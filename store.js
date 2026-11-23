// Data layer. Cloud = Firebase Firestore (shared, offline cache). Local = this browser only,
// used only when firebase-config.js is null (development).
import { firebaseConfig } from './firebase-config.js';

const CDN = 'https://www.gstatic.com/firebasejs/10.14.1';
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function newId(len = 20) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

// Throws if the cloud cannot be reached. It must never fall back to the local store when a
// config is present: a group made there would be invisible to everyone else.
export async function openStore() {
  if (firebaseConfig && firebaseConfig.projectId) return cloudStore();
  return localStore();
}

// Some browsers (private tabs, some in-app browsers) have no usable IndexedDB; Firestore then
// keeps unsynced changes in memory only, and the app must say so.
function canPersist() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('split-probe');
      req.onsuccess = () => { req.result.close(); resolve(true); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    } catch { resolve(false); }
    setTimeout(() => resolve(false), 3000);
  });
}

async function cloudStore() {
  const { initializeApp } = await import(`${CDN}/firebase-app.js`);
  const fs = await import(`${CDN}/firebase-firestore.js`);
  const app = initializeApp(firebaseConfig);
  const durable = await canPersist();
  const db = fs.initializeFirestore(app, {
    localCache: durable
      ? fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
      : fs.memoryLocalCache(),
  });
  // Development only: http://localhost:<port>/?emu=8080 talks to the local emulator.
  const emu = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('emu');
  if (emu) fs.connectFirestoreEmulator(db, '127.0.0.1', Number(emu));

  const g = (gid) => fs.doc(db, 'groups', gid);
  // Writes are queued offline and resolve only when the server confirms, so callers do not wait.
  const fire = (p) => p.catch((e) => window.dispatchEvent(new CustomEvent('store-error', { detail: e })));
  return {
    mode: 'cloud',
    durable,
    async createGroup(group) {
      const gid = newId();
      fire(fs.setDoc(g(gid), group));
      return gid;
    },
    renameGroup: (gid, name) => fire(fs.updateDoc(g(gid), { name })),
    // arrayUnion so two people joining at once do not overwrite each other.
    addMember: (gid, m) => fire(fs.updateDoc(g(gid), { members: fs.arrayUnion(m) })),
    renameMember: (gid, id, name) => fire(fs.updateDoc(g(gid), { [`renames.${id}`]: name })),
    removeMember: (gid, id) => fire(fs.updateDoc(g(gid), { [`removed.${id}`]: true })),
    putItem: (gid, item) => fire(fs.setDoc(fs.doc(db, 'groups', gid, 'items', item.id), item)),
    addLog: (gid, entry) => fire(fs.setDoc(fs.doc(db, 'groups', gid, 'log', newId()), entry)),

    // cb gets { status: 'loading' | 'missing' | 'ok', group, items, log, offline, pending }.
    // 'ok' is reported only once both the group and its items have arrived.
    watch(gid, cb) {
      const s = { group: undefined, missing: false, items: null, log: [], offline: false, pending: false };
      let stopped = false;
      const emit = () => {
        if (stopped) return;
        if (s.missing) return cb({ status: 'missing' });
        if (!s.group || !s.items) return cb({ status: 'loading' });
        cb({ status: 'ok', group: s.group, items: s.items, log: s.log, offline: s.offline, pending: s.pending });
      };
      // Firestore ends a listener for good on any error. A refusal is expected right after
      // creating a group (the rules check that the group exists on the server, and the create
      // may not have arrived yet), so re-listen with a growing delay. Stop once the server
      // says the group does not exist.
      const listen = (ref, onNext) => {
        let unsub = () => {}; let tries = 0; let timer;
        const start = () => {
          if (stopped || s.missing) return;
          unsub = fs.onSnapshot(ref, { includeMetadataChanges: true }, (snap) => { tries = 0; onNext(snap); }, () => {
            tries += 1;
            timer = setTimeout(start, Math.min(60000, 1000 * 2 ** tries));
          });
        };
        start();
        return () => { clearTimeout(timer); unsub(); };
      };
      const unsubs = [
        listen(g(gid), (snap) => {
          s.offline = snap.metadata.fromCache;
          if (snap.exists()) { s.group = snap.data(); s.missing = false; }
          // A missing group seen only from the cache may just mean it has not loaded yet.
          else if (!snap.metadata.fromCache) s.missing = true;
          emit();
        }),
        listen(fs.collection(db, 'groups', gid, 'items'), (snap) => {
          s.items = snap.docs.map((d) => d.data());
          s.pending = snap.metadata.hasPendingWrites;
          emit();
        }),
        listen(fs.query(fs.collection(db, 'groups', gid, 'log'), fs.orderBy('at', 'desc'), fs.limit(200)), (snap) => {
          s.log = snap.docs.map((d) => d.data()); emit();
        }),
      ];
      return () => { stopped = true; unsubs.forEach((u) => u()); };
    },
  };
}

function localStore() {
  const key = (gid) => 'split:local:' + gid;
  const listeners = new Map();
  const read = (gid) => { try { return JSON.parse(localStorage.getItem(key(gid))); } catch { return null; } };
  const snapshot = (gid) => {
    const d = read(gid);
    if (!d || !d.group) return { status: 'missing' };
    return { status: 'ok', group: d.group, items: Object.values(d.items), log: [...d.log].sort((a, b) => b.at - a.at), offline: false, pending: false };
  };
  const notify = (gid) => (listeners.get(gid) || []).forEach((cb) => cb(snapshot(gid)));
  const write = (gid, fn) => {
    const d = read(gid) || { group: null, items: {}, log: [] };
    fn(d);
    localStorage.setItem(key(gid), JSON.stringify(d));
    setTimeout(() => notify(gid));
  };
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith('split:local:')) notify(e.key.slice('split:local:'.length));
  });
  return {
    mode: 'local',
    durable: true,
    async createGroup(group) { const gid = newId(); write(gid, (d) => { d.group = group; }); return gid; },
    renameGroup: (gid, name) => write(gid, (d) => { d.group.name = name; }),
    addMember: (gid, m) => write(gid, (d) => { d.group.members.push(m); }),
    renameMember: (gid, id, name) => write(gid, (d) => { d.group.renames = { ...d.group.renames, [id]: name }; }),
    removeMember: (gid, id) => write(gid, (d) => { d.group.removed = { ...d.group.removed, [id]: true }; }),
    putItem: (gid, item) => write(gid, (d) => { d.items[item.id] = item; }),
    addLog: (gid, entry) => write(gid, (d) => { d.log.push(entry); }),
    watch(gid, cb) {
      if (!listeners.has(gid)) listeners.set(gid, []);
      listeners.get(gid).push(cb);
      setTimeout(() => cb(snapshot(gid)));
      return () => listeners.set(gid, listeners.get(gid).filter((x) => x !== cb));
    },
  };
}
