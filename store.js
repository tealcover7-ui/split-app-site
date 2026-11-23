// Data layer. Cloud = Firebase Firestore (shared, offline cache). Local = this browser only,
// used until firebase-config.js is filled in, and for testing.
import { firebaseConfig } from './firebase-config.js';

const CDN = 'https://www.gstatic.com/firebasejs/10.14.1';
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function newId(len = 20) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

export async function openStore() {
  if (firebaseConfig && firebaseConfig.projectId) {
    try { return await cloudStore(); } catch (e) { console.error('Firebase failed, using local', e); }
  }
  return localStore();
}

async function cloudStore() {
  const { initializeApp } = await import(`${CDN}/firebase-app.js`);
  const fs = await import(`${CDN}/firebase-firestore.js`);
  const app = initializeApp(firebaseConfig);
  const db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
  const g = (gid) => fs.doc(db, 'groups', gid);
  // Writes are queued offline and resolve only when the server confirms, so callers do not wait.
  const fire = (p) => p.catch((e) => window.dispatchEvent(new CustomEvent('store-error', { detail: e })));
  return {
    mode: 'cloud',
    async createGroup(group) {
      const gid = newId();
      fire(fs.setDoc(g(gid), group));
      return gid;
    },
    updateGroup: (gid, patch) => fire(fs.updateDoc(g(gid), patch)),
    // arrayUnion so two people joining at once do not overwrite each other.
    addMember: (gid, m) => fire(fs.updateDoc(g(gid), { members: fs.arrayUnion(m) })),
    putItem: (gid, item) => fire(fs.setDoc(fs.doc(db, 'groups', gid, 'items', item.id), item)),
    addLog: (gid, entry) => fire(fs.setDoc(fs.doc(db, 'groups', gid, 'log', newId()), entry)),
    watch(gid, cb) {
      const state = { group: undefined, items: [], log: [], offline: false };
      const emit = () => { if (state.group !== undefined) cb({ ...state }); };
      let stopped = false;
      // Firestore ends a listener for good on any error. A refusal is expected right after
      // creating a group (the rules check that the group exists on the server, and the
      // create may not have arrived yet), so keep re-listening until it works.
      const listen = (ref, opts, onNext) => {
        let unsub = () => {};
        const start = () => {
          if (stopped) return;
          unsub = fs.onSnapshot(ref, opts, onNext, () => setTimeout(start, 3000));
        };
        start();
        return () => unsub();
      };
      const unsubs = [
        listen(g(gid), { includeMetadataChanges: true }, (s) => {
          state.offline = s.metadata.fromCache;
          // A missing group seen only from the cache may just mean we have not loaded it yet.
          state.group = s.exists() ? s.data() : (s.metadata.fromCache ? 'loading' : null);
          emit();
        }),
        listen(fs.collection(db, 'groups', gid, 'items'), {}, (s) => {
          state.items = s.docs.map((d) => d.data()); emit();
        }),
        listen(fs.query(fs.collection(db, 'groups', gid, 'log'), fs.orderBy('at', 'desc'), fs.limit(200)), {}, (s) => {
          state.log = s.docs.map((d) => d.data()); emit();
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
  const notify = (gid) => (listeners.get(gid) || []).forEach((cb) => cb(snapshot(gid)));
  const snapshot = (gid) => {
    const d = read(gid);
    if (!d) return { group: null, items: [], log: [], offline: false };
    return { group: d.group, items: Object.values(d.items), log: [...d.log].sort((a, b) => b.at - a.at), offline: false };
  };
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
    async createGroup(group) { const gid = newId(); write(gid, (d) => { d.group = group; }); return gid; },
    updateGroup: (gid, patch) => write(gid, (d) => { Object.assign(d.group, patch); }),
    addMember: (gid, m) => write(gid, (d) => { d.group.members.push(m); }),
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
