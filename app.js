import {
  CURRENCIES, toMinor, fromMinor, formatMoney, convert, owedBy, balances, settle, validateSplit, amountHelp,
  tripCosts, poolStats,
} from './money.js';
import { cleanData, GROUP_ID, MAX_AMOUNT, MAX_RATE, POOL_ID, POOL_NAME } from './clean.js';
import { openStore, newId } from './store.js';
import { readSheets } from './sheet.js';
import {
  findTable, amountOf, distinctValues, guessPerson, guessSharers, nameTokens, buildDrafts, draftProblem, markDuplicates, MAX_NAMES, MAX_DRAFTS,
} from './import.js';

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const shortDate = (d) => (d ? new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
const stamp = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const num = (v) => { const n = Number(String(v ?? '').trim().replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : 0; };

let store;
let live = null;      // { gid, data, unsub }; data is cleaned, or { status }
let view = null;      // { gid, sub, id, drawn }
let lastHtml = '';
let prefill = null;   // a suggested payment tapped on the Balances tab
let build = '';       // fingerprint of the running version, shown on the home screen
let updateReady = false; // a newer version is installed and waiting for a safe moment to load
let imp = null;       // a spreadsheet being brought in: its rows, the answers given and the draft expenses

// ---------- small helpers ----------
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}
window.addEventListener('store-error', (e) => {
  const code = e.detail?.code || '';
  toast(code === 'permission-denied' ? 'That change was not accepted by the server.'
    : code === 'resource-exhausted' ? 'The free daily limit is used up. Changes will sync tomorrow.'
      : 'Could not save: ' + (e.detail?.message || e.detail));
});

// Replaces the screen only when it really changed, and keeps anything being typed.
function render(html, fresh) {
  if (!fresh && html === lastHtml) return false;
  const keep = {};
  const active = document.activeElement && $app.contains(document.activeElement) ? document.activeElement.id : '';
  if (!fresh) $app.querySelectorAll('input[id]').forEach((i) => { if (i.type !== 'checkbox' && i.value) keep[i.id] = i.value; });
  $app.innerHTML = html; lastHtml = html;
  for (const [id, v] of Object.entries(keep)) {
    const el = document.getElementById(id);
    if (el && el.tagName === 'INPUT' && !el.value) el.value = v;
  }
  if (active) document.getElementById(active)?.focus();
  return true;
}

const meKey = (gid) => 'split:me:' + gid;
const getMe = (gid) => LS.get(meKey(gid), null);
function rememberGroup(gid, name) {
  const old = LS.get('split:groups', []);
  if (old[0]?.id === gid && old[0].name === name && Date.now() - old[0].at < 60000) return;
  LS.set('split:groups', [{ id: gid, name, at: Date.now() }, ...old.filter((x) => x.id !== gid)].slice(0, 100));
}
const nameOf = (g, id, me) => (id && id === me ? 'You' : (g.members.find((m) => m.id === id)?.name || 'Someone'));
const banners = (d) => [
  store.mode === 'local' ? 'Test mode: groups stay on this phone only.' : '',
  store.mode === 'cloud' && !store.durable ? 'This browser cannot keep changes safe without internet. Open the link in Chrome or Safari instead.' : '',
  d?.offline && store.mode === 'cloud' ? 'Offline. Your changes are kept on this phone and will sync when you are back online.' : '',
  d && !d.offline && d.pending ? 'Sending your latest changes…' : '',
  d?.unreadable ? `${d.unreadable} damaged ${d.unreadable === 1 ? 'entry was' : 'entries were'} left out.` : '',
].filter(Boolean).map((t) => `<div class="banner">${esc(t)}</div>`).join('');
const back = (href) => `<a class="btn back" aria-label="Back" href="${esc(href)}">‹</a>`;

function currencyOptions(selected, first, short = false) {
  const codes = [first, ...Object.keys(CURRENCIES).filter((c) => c !== first)];
  return codes.map((c) => `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c)}${short ? '' : ' · ' + esc(CURRENCIES[c].name)}</option>`).join('');
}

// Returns { rate, date } (home-currency units per 1 `from`), or null. `date` is when the
// rates were fetched, which is not today when the phone is offline.
async function fetchRate(from, to) {
  const k = 'split:rates:' + to;
  let c = LS.get(k, null);
  if (!c || c.date !== today()) {
    try {
      const j = await (await fetch('https://open.er-api.com/v6/latest/' + encodeURIComponent(to))).json();
      if (j.result === 'success' && j.rates && typeof j.rates === 'object') { c = { date: today(), rates: j.rates }; LS.set(k, c); }
    } catch { /* offline: fall back to the last saved rates */ }
  }
  const x = Number(c?.rates?.[from]);
  const rate = x > 0 ? +(1 / x).toPrecision(6) : 0;
  return rate > 0 && rate <= MAX_RATE ? { rate, date: c.date } : null;
}

// Loose number: "1,60,000", "1005", "159.2", "0.00628".
const loose = (v) => { const m = toMinor(v, 'USD'); return m ? m / 100 : num(v); };
// An exchange rate held the way people state it: "a CUR = b HOME". `kept` is an exact rate
// (from a saved entry or the rate service) used until someone types over it.
const rateState = (r) => { const x = { a: '', b: '', kept: null }; if (r > 0) setRate(x, r); return x; };
function setRate(x, r) {
  x.kept = r;
  if (r < 1) { x.a = String(+(1 / r).toPrecision(6)); x.b = '1'; } else { x.a = '1'; x.b = String(+r.toPrecision(6)); }
}
const rateOf = (x) => (x.kept != null ? x.kept : (loose(x.a) > 0 ? loose(x.b) / loose(x.a) : 0));
// The rate this group last used for a currency: for cash changed once, that is the rate they got.
function lastGroupRate(cur, home) {
  if (cur === home) return 0;
  const hit = [...(live?.data?.items || [])].sort((p, q) => q.createdAt - p.createdAt)
    .find((x) => !x.deleted && (x.type === 'expense' ? x.currency === cur : x.orig?.currency === cur));
  return hit ? (hit.type === 'expense' ? hit.rate : hit.orig.rate) : 0;
}
async function defaultRate(cur, home) {
  const own = lastGroupRate(cur, home);
  if (own) return { rate: own, note: `This is the rate from your group’s last ${cur} entry. Change it if this one was different.` };
  const r = await fetchRate(cur, home);
  if (!r) return null;
  return { rate: r.rate, note: r.date === today() ? 'Today’s market rate is filled in. Change it to the rate you actually got.'
    : `No internet: this is the market rate from ${shortDate(r.date)}. Change it to the rate you got.` };
}
function drawRateBox(el, cur, home, x, note, onChange) {
  if (cur === home) { el.innerHTML = ''; delete el.dataset.rate; return; }
  el.innerHTML = `<label for="ra">Exchange rate you got</label>
    <div class="inline"><input id="ra" inputmode="decimal" value="${esc(x.a)}" placeholder="…" style="flex:1"><span class="small">${esc(cur)} =</span>
      <input id="rb" inputmode="decimal" value="${esc(x.b)}" placeholder="…" style="flex:1"><span class="small">${esc(home)}</span></div>
    <div class="small" id="rateNote">${esc(note || 'You can type totals, like 160000 INR = 1005 USD.')}</div>`;
  el.dataset.rate = String(rateOf(x) || '');
  for (const [id, key] of [['ra', 'a'], ['rb', 'b']]) {
    el.querySelector('#' + id).oninput = (e) => { x[key] = e.target.value; x.kept = null; el.dataset.rate = String(rateOf(x) || '');
      el.querySelector('#rateNote').textContent = 'Using the rate you typed. Totals work too, like 160000 INR = 1005 USD.';
      onChange();
    };
  }
}

async function shareText(title, text, url) {
  if (navigator.share) {
    try { await navigator.share(url ? { title, text, url } : { title, text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const all = url ? text + ' ' + url : text;
  try { await navigator.clipboard.writeText(all); toast('Copied. Paste it in WhatsApp.'); } catch { prompt('Copy this:', all); }
}
function shareGroup(g, gid) {
  if (store.mode === 'local') return toast('Test mode: friends cannot open this group.');
  shareText(g.name, `Add our expenses for “${g.name}” here (no sign-up). Anyone with this link can edit, so keep it in our group:`,
    location.origin + location.pathname + '#/g/' + gid);
}

function log(gid, me, g, text) {
  store.addLog(gid, { at: Date.now(), by: me, byName: nameOf(g, me, null).slice(0, 40), text: String(text).slice(0, 400) });
}

// ---------- routing ----------
function route() {
  // A newer version arrived while a form was open: load it now that the form is closed.
  if (updateReady) { updateReady = false; location.reload(); return; }
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  window.scrollTo(0, 0);
  document.querySelector('.toast')?.remove();
  lastHtml = '';
  if (!(parts[0] === 'g' && parts[2] === 'import' && imp?.gid === parts[1])) imp = null;
  if (parts[0] === 'new') { stopLive(); view = null; return newGroupView(); }
  if (parts[0] === 'g' && parts[1]) {
    const gid = parts[1];
    // Only ids the app itself could have made are ever looked up or put on the page.
    if (!GROUP_ID.test(gid)) { stopLive(); view = null; return notFound(); }
    if (!live || live.gid !== gid) {
      stopLive();
      const mine = { gid, data: { status: 'loading' } };
      live = mine;
      mine.unsub = store.watch(gid, (raw) => {
        if (live !== mine) return;
        mine.data = raw.status === 'ok' ? { ...cleanData(raw), status: 'ok', offline: raw.offline, pending: raw.pending } : raw;
        if (mine.data.status === 'ok' && !mine.data.group) mine.data = { status: 'damaged' };
        draw();
      });
    }
    if (parts[2] === 'import' && !imp) imp = { gid, step: 'pick' };
    view = { gid, sub: parts[2] || 'expenses', id: parts[3], drawn: false };
    return draw();
  }
  stopLive(); view = null;
  homeView();
}
function stopLive() { if (live) { live.unsub?.(); live = null; } }

function notFound(damaged) {
  render(`<header class="top">${back('#/')}<h1>${damaged ? 'Cannot open' : 'Not found'}</h1></header>
    <p class="empty">${damaged ? 'This group’s data is damaged and cannot be shown.'
    : 'This group does not exist. Check that the whole link was copied: it ends in 20 letters and numbers.'}</p>`, true);
}

function draw() {
  if (!view || !live) return;
  const editor = view.sub === 'e' || view.sub === 'p' || view.sub === 'import';
  if (editor && view.drawn) return; // do not wipe a form someone is typing into
  const d = live.data;
  if (d.status === 'loading') {
    render('<p class="empty">Loading the group…<br><span class="small">The first time needs an internet connection.</span></p>');
    return;
  }
  if (d.status !== 'ok') return notFound(d.status === 'damaged');
  const g = d.group;
  rememberGroup(view.gid, g.name);
  const me = getMe(view.gid);
  if (!me || !g.people.some((m) => m.id === me)) return whoAmI(g, d, view.gid);
  if (view.sub === 'e') { view.drawn = true; return expenseEditor(g, d, me); }
  if (view.sub === 'p') { view.drawn = true; return paymentEditor(g, d, me); }
  if (view.sub === 'import') { view.drawn = true; return importView(me); }
  groupView(g, d, me);
}

// ---------- home ----------
function homeView() {
  const groups = LS.get('split:groups', []).filter((x) => x && GROUP_ID.test(x.id));
  render(`
    <header class="top"><h1>Split</h1></header>
    ${banners(null)}
    <div class="card"><div class="title">Joining friends?</div>
      <p class="small" style="margin:4px 0 10px">Every group has its own link. Open the link your friend sent, or paste it here. Do not make a new group: that starts a separate one nobody else can see.</p>
      <div class="inline"><input id="paste" placeholder="Paste the group link" autocapitalize="off" autocomplete="off" spellcheck="false"><button id="openlink">Open</button></div></div>
    ${groups.length ? `<div class="list">${groups.map((x) => `
      <div class="row"><a class="grow plain" href="#/g/${esc(x.id)}"><div class="title">${esc(x.name)}</div>
      <div class="small">Last opened ${esc(stamp(x.at))}</div></a>
      <button class="icon" data-forget="${esc(x.id)}" aria-label="Remove from this phone">×</button></div>`).join('')}</div>
      <p class="small">× only takes a group off this phone’s list. The group and its link keep working.</p>`
    : '<p class="empty">No groups on this phone yet.<br>Starting a trip? Make the group once, then send its link to everyone.</p>'}
    <p class="small" id="build" style="text-align:center;margin-top:24px">${build ? 'Version ' + esc(build) : ''}</p>
    <a class="btn primary fab" href="#/new">+ New group</a>`, true);
  $app.querySelector('#openlink').onclick = () => {
    const v = $app.querySelector('#paste').value.trim();
    const id = (v.match(/#\/g\/([A-Za-z0-9]{20})(?![A-Za-z0-9])/) || v.match(/^([A-Za-z0-9]{20})$/) || [])[1];
    if (!id) return toast('That is not a group link. A group link ends in #/g/ and 20 letters and numbers.');
    location.hash = '#/g/' + id;
  };
  $app.querySelectorAll('[data-forget]').forEach((b) => {
    b.onclick = () => {
      const x = groups.find((q) => q.id === b.dataset.forget);
      if (!confirm(`Take “${x.name}” off this phone’s list? You will need its link to open it again.`)) return;
      LS.set('split:groups', groups.filter((q) => q.id !== x.id));
      homeView();
    };
  });
}

function newGroupView() {
  render(`
    <header class="top">${back('#/')}<h1>New group</h1></header>
    ${banners(null)}
    <div class="banner">Only one person makes the group. If a friend already made it, go back and open their link instead.</div>
    <div class="card">
      <label for="gname">Group name</label><input id="gname" placeholder="Vietnam trip 2026" maxlength="60">
      <label for="gcur">Main currency (balances are shown in this; it cannot be changed later)</label><select id="gcur">${currencyOptions('INR', 'INR')}</select>
      <label for="myname">Your name</label><input id="myname" maxlength="30" value="${esc(LS.get('split:myname', ''))}">
      <label>Friends (you can add more later)</label><div id="friends"></div>
      <button id="addf" type="button" style="margin-top:8px">+ Add another person</button>
      <div class="actions"><button class="primary" id="create">Create group</button></div>
    </div>`, true);
  const friends = $app.querySelector('#friends');
  const addField = () => {
    const i = document.createElement('input');
    i.maxLength = 30; i.placeholder = 'Name'; i.style.marginTop = '6px';
    friends.appendChild(i); return i;
  };
  addField(); addField();
  $app.querySelector('#addf').onclick = () => addField().focus();
  const btn = $app.querySelector('#create');
  btn.onclick = async () => {
    const name = $app.querySelector('#gname').value.trim();
    const myName = $app.querySelector('#myname').value.trim();
    if (!name) return toast('Give the group a name.');
    if (!myName) return toast('Enter your name.');
    const names = [myName];
    for (const i of friends.querySelectorAll('input')) {
      const n = i.value.trim();
      if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
    }
    if (names.length > 50) return toast('A group can have at most 50 people.');
    btn.disabled = true;
    const members = names.map((n) => ({ id: 'm' + newId(8), name: n }));
    const group = { name, currency: $app.querySelector('#gcur').value, members, createdAt: Date.now() };
    const gid = await store.createGroup(group);
    LS.set(meKey(gid), members[0].id);
    LS.set('split:myname', myName);
    rememberGroup(gid, name);
    LS.set('split:nudge:' + gid, true);
    log(gid, members[0].id, group, `created the group with ${names.join(', ')}`);
    location.hash = '#/g/' + gid;
  };
}

// ---------- pick who you are ----------
function addPerson(gid, g, raw, me) {
  const n = raw.trim().slice(0, 30);
  if (!n) return null;
  const now = live?.data?.group || g; // the latest list, not the one this screen was drawn with
  if (now.members.some((m) => m.name.toLowerCase() === n.toLowerCase())) { toast(`${n} is already in the group.`); return null; }
  if (now.members.length >= 50) { toast('A group can have at most 50 people.'); return null; }
  const m = { id: 'm' + newId(8), name: n };
  store.addMember(gid, m);
  log(gid, me || m.id, { members: [...now.members, m] }, me ? `added ${n} to the group` : 'joined the group');
  return m;
}

function whoAmI(g, d, gid) {
  if (!render(`
    <header class="top">${back('#/')}<h1>${esc(g.name)}</h1></header>
    ${banners(d)}
    <div class="card"><div class="big">Who are you?</div>
      <p class="small">You are joining “${esc(g.name)}”. Pick your name so the app can show what you owe. This phone will remember it.</p>
      <div class="list">${g.people.map((m) => `<button class="row" style="width:100%;background:none;border-radius:0" data-id="${esc(m.id)}">
        <span class="grow title" style="text-align:left">${esc(m.name)}</span>›</button>`).join('')}</div>
      <label for="newname">Not on the list? Add yourself</label>
      <div class="inline"><input id="newname" maxlength="30" placeholder="Your name"><button id="join">Join</button></div>
    </div>`)) return;
  $app.querySelectorAll('[data-id]').forEach((b) => { b.onclick = () => { LS.set(meKey(gid), b.dataset.id); lastHtml = ''; draw(); }; });
  const join = $app.querySelector('#join');
  join.onclick = () => {
    const m = addPerson(gid, g, $app.querySelector('#newname').value, null);
    if (!m) return;
    join.disabled = true;
    $app.querySelector('#newname').value = '';
    LS.set(meKey(gid), m.id);
  };
}

// ---------- group screens ----------
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets running it as a formula
  return '"' + s.replace(/"/g, '""') + '"';
}
function downloadCsv(g, items) {
  const home = g.currency; const f = (v, c) => fromMinor(v, c);
  const rows = [['Date', 'Type', 'Description', 'Paid by', 'Paid to', 'Amount', 'Currency', 'Rate', `Amount (${home})`,
    ...g.people.map((m) => `${m.name} share (${home})`)]];
  for (const x of [...items].reverse()) {
    if (x.type === 'payment') {
      const o = x.orig || { amount: x.amount, currency: home, rate: 1 };
      rows.push([x.date, 'Payment', '', nameOf(g, x.from), nameOf(g, x.to), f(o.amount, o.currency), o.currency, o.rate, f(x.amount, home), ...g.people.map(() => '')]);
    } else {
      const owed = owedBy(x, g.members, home);
      rows.push([x.date, 'Expense', x.desc, nameOf(g, x.paidBy), '', f(x.amount, x.currency), x.currency, x.rate,
        f(convert(x.amount, x.currency, home, x.rate), home), ...g.people.map((m) => f(owed[m.id], home))]);
    }
  }
  const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = g.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '-expenses.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function groupView(g, d, me) {
  const { gid, sub } = view;
  const home = g.currency;
  const items = d.items.filter((x) => !x.deleted)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  const bal = balances(items, g.members, home);
  const plan = settle(bal);
  const costs = tripCosts(items, g.members, home);
  const ps = g.pool ? poolStats(items, g.members, home, POOL_ID) : null;
  const money = (v) => esc(formatMoney(v, home));
  // What was put into the pool in other currencies, e.g. "₹1,60,000".
  const byCur = {};
  for (const x of items) {
    if (x.type !== 'payment' || !x.orig) continue;
    if (x.to === POOL_ID) byCur[x.orig.currency] = (byCur[x.orig.currency] || 0) + x.orig.amount;
    if (x.from === POOL_ID) byCur[x.orig.currency] = (byCur[x.orig.currency] || 0) - x.orig.amount;
  }
  const collected = Object.entries(byCur).filter(([, v]) => v > 0).map(([c, v]) => formatMoney(v, c)).join(' + ');
  const tab = (key, label, href) => `<a href="${esc(href)}" class="${sub === key ? 'on' : ''}">${label}</a>`;
  // Expenses this phone brought in from a sheet in the last day, for the Undo card.
  const lastImport = LS.get('split:lastimport:' + gid, null);
  const importIds = new Set(lastImport && Array.isArray(lastImport.ids) && Date.now() - lastImport.at < 86400000 ? lastImport.ids : []);
  const fromSheet = items.filter((x) => importIds.has(x.id));
  let body = '';

  if (sub === 'balances') {
    body = `
      ${ps ? `<div class="card"><div class="small">Trip pool</div>
        <div class="big ${ps.left < 0 ? 'neg' : ''}">${ps.left >= 0 ? money(ps.left) + ' left' : money(-ps.left) + ' overspent'}</div>
        <div class="small">Put in ${money(ps.total)}${collected ? ` (${esc(collected)})` : ''} · spent ${money(ps.spent)}${ps.left < 0 ? '. The pool has paid out more than was put in. Is a contribution missing?' : ''}</div>
        <p style="margin:10px 0 0"><button id="topup">Add money to pool</button></p></div>` : ''}
      <div class="list">${g.people.map((m) => {
        const v = bal[m.id];
        const you = m.id === me;
        const txt = v > 0 ? `<span class="pos">${you ? 'get' : 'gets'} back ${money(v)}</span>`
          : v < 0 ? `<span class="neg">${you ? 'owe' : 'owes'} ${money(-v)}</span>` : '<span class="small">settled up</span>';
        const c = costs[m.id];
        return `<div class="row"><div class="grow"><div class="title">${esc(nameOf(g, m.id, me))}</div>
          <div class="small">Trip cost ${money(c.cost)}${c.personal ? ` (${money(c.personal)} personal)` : ''}${ps ? ` · put in ${money(ps.paidIn[m.id])}` : ''}</div></div>
          <div class="right">${txt}</div></div>`;
      }).join('')}</div>
      <h3>Suggested payments to settle</h3>
      ${plan.length ? `<div class="list">${plan.map((p, i) => `
        <div class="row"><div class="grow"><div class="title">${esc(nameOf(g, p.from, me))} → ${esc(nameOf(g, p.to, me))}</div>
        <div class="small">${money(p.amount)}${p.from === POOL_ID ? ' · back from the pool' : p.to === POOL_ID ? ' · into the pool' : ''}</div></div>
        <button data-pay="${i}">Mark paid</button></div>`).join('')}</div>
        <p class="small">Tap “Mark paid” only after the money has really moved, and only one of you needs to.</p>`
      : '<p class="empty">Everyone is settled up.</p>'}
      <p class="inline" style="flex-wrap:wrap"><a class="btn" href="#/g/${esc(gid)}/p/new">Record another payment</a>
        <button id="summary">Share summary</button><button id="csv">Download list</button><a class="btn" href="#/g/${esc(gid)}/import">Add from a sheet</a>
        ${g.pool ? '' : '<button id="pool">Start a trip pool</button>'}</p>
      ${g.pool ? '' : '<p class="small">A trip pool is money everyone puts into one kitty for common spending.</p>'}
      <h3>People</h3>
      <div class="list">${g.people.map((m) => `<div class="row"><div class="grow title">${esc(m.name)}${m.id === me ? ' <span class="small">(you)</span>' : ''}</div>
        <button data-rename="${esc(m.id)}">Rename</button>
        ${m.id !== me && !d.used.has(m.id) ? `<button class="danger" data-remove="${esc(m.id)}">Remove</button>` : ''}</div>`).join('')}</div>
      <div class="card">
        <label for="addname" style="margin-top:0">Add a person</label>
        <div class="inline"><input id="addname" maxlength="30" placeholder="Name"><button id="addp">Add</button></div>
        <p class="small" style="margin-top:14px">A person can be removed only while no expense or payment involves them.
          This phone is set as <b>${esc(nameOf(g, me, null))}</b>. <a href="#" id="switch">Not you?</a> · <a href="#" id="regroup">Rename group</a></p>
      </div>`;
  } else if (sub === 'activity') {
    body = (d.log.length ? `<div class="list">${d.log.map((l) => `
      <div class="row"><div class="grow"><div><b>${esc(l.by && l.by === me ? 'You' : l.byName)}</b> ${esc(l.text)}</div>
      <div class="small">${esc(stamp(l.at))}</div></div></div>`).join('')}</div>` : '<p class="empty">Nothing yet.</p>')
      + '<p class="small">Names here are whatever each phone was set to. There are no logins, so treat this as a notebook among friends, not proof.</p>';
  } else {
    const mine = bal[me] || 0;
    const spent = items.filter((x) => x.type === 'expense').reduce((s, x) => s + convert(x.amount, x.currency, home, x.rate), 0);
    body = `
      ${fromSheet.length ? `<div class="card"><div class="title">${fromSheet.length} ${fromSheet.length === 1 ? 'expense was' : 'expenses were'} added from your sheet</div>
        <p class="small" style="margin:4px 0 10px">Tap any of them to change it or to set an uneven split. Wrong sheet? Undo takes them out again.</p>
        <div class="inline"><button id="impundo">Undo</button><button id="impok">OK</button></div></div>` : ''}`
      + `
      <div class="card"><div class="big ${mine > 0 ? 'pos' : mine < 0 ? 'neg' : ''}">${mine > 0 ? 'You get back ' + esc(formatMoney(mine, home))
        : mine < 0 ? 'You owe ' + esc(formatMoney(-mine, home)) : 'You are settled up'}</div>
        <div class="small">Your trip cost so far: ${money(costs[me].cost)}${costs[me].personal ? ` (${money(costs[me].personal)} personal)` : ''}${ps ? ` · pool has ${money(ps.left)} left` : ''}</div>
        <div class="small">Group spent ${money(spent)} in total</div></div>
      ${items.length ? `<div class="list">${items.map((x) => itemRow(x, g, me, gid)).join('')}</div>`
      : '<p class="empty">No expenses yet. Tap “Add expense” when someone pays for something.</p>'}
      <p style="text-align:center"><a class="btn" href="#/g/${esc(gid)}/import">Add many from an Excel sheet</a></p>
      ${g.pool ? '' : '<p class="small">Put money together in a common kitty? Pick “Trip pool” under “Paid by” for anything paid from it, and record who put in what on the Balances tab.</p>'}`;
  }

  if (!render(`
    <header class="top">${back('#/')}<h1>${esc(g.name)}</h1><button id="share">Share link</button></header>
    ${banners(d)}
    ${LS.get('split:nudge:' + gid, false) ? `<div class="card"><div class="title">Next: send this group’s link</div>
      <p class="small" style="margin:4px 0 10px">Friends see this group only by opening its link. If they make their own group, it will be a separate one.</p>
      <div class="inline"><button class="primary" id="nudgeshare">Share link</button><button id="nudgedone">Done</button></div></div>` : ''}
    <nav class="tabs">${tab('expenses', 'Expenses', `#/g/${gid}`)}${tab('balances', 'Balances', `#/g/${gid}/balances`)}${tab('activity', 'Activity', `#/g/${gid}/activity`)}</nav>
    ${body}
    <a class="btn primary fab" href="#/g/${esc(gid)}/e/new">+ Add expense</a>`)) return;

  $app.querySelector('#share').onclick = () => shareGroup(g, gid);
  const endNudge = () => { LS.set('split:nudge:' + gid, false); lastHtml = ''; draw(); };
  $app.querySelector('#nudgeshare')?.addEventListener('click', () => { shareGroup(g, gid); endNudge(); });
  $app.querySelector('#nudgedone')?.addEventListener('click', endNudge);
  const endImport = () => { LS.set('split:lastimport:' + gid, null); lastHtml = ''; draw(); };
  $app.querySelector('#impok')?.addEventListener('click', endImport);
  $app.querySelector('#impundo')?.addEventListener('click', () => {
    // Anything changed by hand since it came in is somebody's work, so it stays.
    const untouched = fromSheet.filter((x) => x.updatedAt === x.createdAt);
    const kept = fromSheet.length - untouched.length;
    if (!untouched.length) { toast('All of them were changed after they came in, so none were taken out.'); return endImport(); }
    if (!confirm(`Take out the ${untouched.length} ${untouched.length === 1 ? 'expense' : 'expenses'} that came from the sheet?${kept ? ` ${kept} changed since then will stay.` : ''}`)) return;
    const now = Date.now();
    for (const x of untouched) store.putItem(gid, { ...x, createdBy: x.createdBy || me, updatedBy: me, updatedAt: now, deleted: true });
    log(gid, me, g, `took out ${untouched.length} ${untouched.length === 1 ? 'expense' : 'expenses'} that had been added from a sheet`);
    endImport();
  });
  if (sub !== 'balances') return;
  $app.querySelectorAll('[data-pay]').forEach((b) => {
    b.onclick = () => { prefill = plan[Number(b.dataset.pay)]; location.hash = `#/g/${gid}/p/new`; };
  });
  $app.querySelector('#topup')?.addEventListener('click', () => { prefill = { from: me, to: POOL_ID, amount: 0 }; location.hash = `#/g/${gid}/p/new`; });
  $app.querySelector('#pool')?.addEventListener('click', (e) => {
    e.target.disabled = true;
    store.addMember(gid, { id: POOL_ID, name: POOL_NAME });
    log(gid, me, g, 'started a trip pool');
  });
  $app.querySelector('#summary').onclick = () => {
    const lines = [`${g.name}: balances`,
      ...(ps ? [`Trip pool: ${formatMoney(ps.left, home)} left (put in ${formatMoney(ps.total, home)}, spent ${formatMoney(ps.spent, home)})`] : []),
      ...g.people.map((m) => `${m.name}: ${bal[m.id] > 0 ? 'gets back ' + formatMoney(bal[m.id], home) : bal[m.id] < 0 ? 'owes ' + formatMoney(-bal[m.id], home) : 'settled up'}`)];
    if (plan.length) lines.push('', 'To settle:', ...plan.map((p) => `${nameOf(g, p.from)} pays ${nameOf(g, p.to)} ${formatMoney(p.amount, home)}`));
    shareText(g.name, lines.join('\n'));
  };
  $app.querySelector('#csv').onclick = () => downloadCsv(g, items);
  $app.querySelector('#addp').onclick = () => {
    if (addPerson(gid, g, $app.querySelector('#addname').value, me)) $app.querySelector('#addname').value = '';
  };
  $app.querySelectorAll('[data-rename]').forEach((b) => {
    b.onclick = () => {
      const m = g.members.find((x) => x.id === b.dataset.rename);
      const n = (prompt(`New name for ${m.name}:`, m.name) || '').trim().slice(0, 30);
      if (!n || n === m.name) return;
      if (g.members.some((x) => x.id !== m.id && x.name.toLowerCase() === n.toLowerCase())) return toast(`${n} is already in the group.`);
      store.renameMember(gid, m.id, n);
      log(gid, me, g, `renamed ${m.name} to ${n}`);
    };
  });
  $app.querySelectorAll('[data-remove]').forEach((b) => {
    b.onclick = () => {
      const m = g.members.find((x) => x.id === b.dataset.remove);
      if (live.data.used?.has(m.id)) return toast(`${m.name} is in an expense or payment now, so cannot be removed.`);
      if (!confirm(`Remove ${m.name} from the group?`)) return;
      store.removeMember(gid, m.id);
      log(gid, me, g, `removed ${m.name} from the group`);
    };
  });
  $app.querySelector('#switch').onclick = (e) => { e.preventDefault(); LS.set(meKey(gid), null); lastHtml = ''; draw(); };
  $app.querySelector('#regroup').onclick = (e) => {
    e.preventDefault();
    const n = (prompt('New name for the group:', g.name) || '').trim().slice(0, 60);
    if (!n || n === g.name) return;
    store.renameGroup(gid, n);
    log(gid, me, g, `renamed the group to “${n}”`);
  };
}

function itemRow(x, g, me, gid) {
  const home = g.currency;
  const money = (v) => esc(formatMoney(v, home));
  const day = `<div class="small" style="width:44px">${esc(shortDate(x.date))}</div>`;
  if (x.type === 'payment') {
    const title = x.to === POOL_ID ? `${nameOf(g, x.from, me)} put money in the pool`
      : x.from === POOL_ID ? `${nameOf(g, x.to, me)} took money back from the pool`
        : `${nameOf(g, x.from, me)} paid ${nameOf(g, x.to, me)}`;
    return `<a class="row" href="#/g/${esc(gid)}/p/${esc(x.id)}">${day}
      <div class="grow"><div class="title">${esc(title)}</div><div class="small">${x.to === POOL_ID || x.from === POOL_ID ? 'Pool' : 'Payment'}</div></div>
      <div class="right">${money(x.amount)}${x.orig ? `<div class="small">${esc(formatMoney(x.orig.amount, x.orig.currency))}</div>` : ''}</div></a>`;
  }
  const total = convert(x.amount, x.currency, home, x.rate);
  const myShare = owedBy(x, g.members, home)[me] || 0;
  const sharers = Object.keys(x.split.weights);
  const personal = sharers.length === 1;
  const foreign = x.currency !== home ? ` · ${esc(formatMoney(x.amount, x.currency))}` : '';
  const tag = !personal ? '' : sharers[0] === x.paidBy ? ' · personal' : ` · personal (${esc(nameOf(g, sharers[0], me))})`;
  let mine;
  if (x.paidBy === me) mine = total - myShare > 0 ? `<span class="pos">you lent<br>${money(total - myShare)}</span>` : '<span class="small">personal</span>';
  else if (myShare > 0) mine = x.paidBy === POOL_ID ? `<span class="small">your share<br>${money(myShare)}</span>` : `<span class="neg">you owe<br>${money(myShare)}</span>`;
  else mine = '<span class="small">not in it</span>';
  return `<a class="row" href="#/g/${esc(gid)}/e/${esc(x.id)}">${day}
    <div class="grow"><div class="title">${esc(x.desc)}</div><div class="small">${esc(nameOf(g, x.paidBy, me))} paid ${money(total)}${foreign}${tag}</div></div>
    <div class="right small">${mine}</div></a>`;
}

// Finds the item an editor was opened for. `gone` explains why it cannot be edited.
function findItem(d, id, type) {
  const x = d.items.find((q) => q.id === id && q.type === type);
  return { old: x && !x.deleted ? x : null, gone: !x ? 'could not be found' : x.deleted ? 'was deleted' : '' };
}
// True if someone else changed or deleted the item while this phone had it open.
function changedSince(old) {
  if (!old) return false;
  const cur = live?.data?.items?.find((q) => q.id === old.id);
  return !cur || cur.deleted || cur.updatedAt !== old.updatedAt;
}
const STALE = 'Someone else changed this while you had it open. Go back and open it again, so their change is not lost.';

// ---------- expense editor ----------
const MODES = { equal: 'Equally', exact: 'Exact', percent: '%', shares: 'Shares' };

function expenseEditor(g, d, me) {
  const { gid } = view;
  const home = g.currency;
  const isNew = view.id === 'new';
  const { old, gone } = isNew ? { old: null } : findItem(d, view.id, 'expense');
  if (!isNew && !old) { render(`<header class="top">${back('#/g/' + gid)}<h1>Expense</h1></header><p class="empty">This expense ${gone}.</p>`, true); return; }
  const id = old ? old.id : newId(); // made once, so a double tap cannot save two copies

  const f = old ? {
    desc: old.desc, amount: String(fromMinor(old.amount, old.currency)), currency: old.currency, x: rateState(old.currency !== home ? old.rate : 0),
    date: old.date || today(), paidBy: old.paidBy, mode: old.split.mode,
    vals: Object.fromEntries(g.people.map((m) => {
      const w = old.split.weights[m.id] || 0;
      if (old.split.mode === 'equal') return [m.id, w > 0];
      if (old.split.mode === 'exact') return [m.id, w ? String(fromMinor(w, old.currency)) : ''];
      return [m.id, w ? String(w) : ''];
    })),
  } : {
    desc: '', amount: '', currency: CURRENCIES[LS.get('split:cur:' + gid, home)] ? LS.get('split:cur:' + gid, home) : home,
    x: rateState(0), date: today(), paidBy: g.members.some((m) => m.id === LS.get('split:payer:' + gid, me)) ? LS.get('split:payer:' + gid, me) : me, mode: 'equal',
    vals: Object.fromEntries(g.people.map((m) => [m.id, true])),
  };
  let rateNote = '';

  render(`
    <header class="top">${back('#/g/' + gid)}<h1>${old ? 'Edit expense' : 'Add expense'}</h1></header>
    <div class="card">
      <label for="desc">What was it for?</label><input id="desc" maxlength="80" placeholder="Dinner, taxi, hotel…" value="${esc(f.desc)}">
      <label for="amt">Amount</label>
      <div class="inline"><input id="amt" inputmode="decimal" placeholder="0" value="${esc(f.amount)}" style="flex:1">
        <select id="cur" style="width:96px">${currencyOptions(f.currency, home, true)}</select></div>
      <div id="rateBox"></div>
      <label for="paid">Paid by</label>
      <select id="paid">${g.people.map((m) => `<option value="${esc(m.id)}" ${m.id === f.paidBy ? 'selected' : ''}>${esc(nameOf(g, m.id, me))}</option>`).join('')}
        <option value="${POOL_ID}" ${f.paidBy === POOL_ID ? 'selected' : ''}>${POOL_NAME} (common money)</option></select>
      <div class="small" id="paidNote"></div>
      <label for="date">Date</label><input id="date" type="date" value="${esc(f.date)}">
      <label>Split</label>
      <div class="seg">${Object.entries(MODES).map(([k, v]) => `<button type="button" data-mode="${k}">${v}</button>`).join('')}</div>
      <button type="button" id="justme" style="margin-top:8px">Just me (personal)</button>
      <div id="rows" style="margin-top:8px"></div>
      <div id="hint" class="hint"></div>
      <div class="actions">${old ? '<button class="danger" id="del">Delete</button>' : ''}<button class="primary" id="save">Save</button></div>
      ${old ? `<p class="small">Added by ${esc(nameOf(g, old.createdBy, me))} on ${esc(stamp(old.createdAt))}${old.updatedAt !== old.createdAt ? `; last changed by ${esc(nameOf(g, old.updatedBy, me))} on ${esc(stamp(old.updatedAt))}` : ''}.</p>` : ''}
    </div>`, true);

  const q = (s) => $app.querySelector(s);
  const row = (mid, attr) => [...$app.querySelectorAll(`[${attr}]`)].find((el) => el.getAttribute(attr) === mid);

  function compute() {
    const amount = toMinor(f.amount, f.currency);
    const foreign = f.currency !== home;
    const rate = foreign ? rateOf(f.x) : 1;
    const weights = {};
    for (const m of g.people) {
      const v = f.vals[m.id];
      let w = 0;
      if (f.mode === 'equal') w = v ? 1 : 0;
      else if (f.mode === 'exact') w = toMinor(v, f.currency) || 0;
      else w = num(v);
      if (w > 0) weights[m.id] = w;
    }
    const split = { mode: f.mode, weights };
    let error = null;
    if (!String(f.amount).trim()) error = 'Enter the amount.';
    else if (!amount) error = amountHelp(f.currency);
    else if (amount > MAX_AMOUNT) error = 'That amount is too large.';
    else if (foreign && !(rate > 0 && rate <= MAX_RATE)) error = 'Enter the exchange rate.';
    else if (f.mode === 'exact' && g.people.some((m) => String(f.vals[m.id] || '').trim() && !toMinor(f.vals[m.id], f.currency))) error = 'One of the exact amounts is not clear. ' + amountHelp(f.currency);
    else error = validateSplit(split, amount);
    return { amount, rate, split, error };
  }

  function drawRate() { drawRateBox(q('#rateBox'), f.currency, home, f.x, rateNote, refresh); }

  function drawRows() {
    $app.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === f.mode));
    q('#rows').innerHTML = g.people.map((m) => {
      const v = f.vals[m.id];
      const input = f.mode === 'equal'
        ? `<input type="checkbox" data-m="${esc(m.id)}" ${v ? 'checked' : ''}>`
        : `<input data-m="${esc(m.id)}" inputmode="decimal" value="${esc(v)}" placeholder="0">`;
      const unit = f.mode === 'exact' ? esc(f.currency) : f.mode === 'percent' ? '%' : f.mode === 'shares' ? 'shares' : '';
      return `<label class="split-row" style="margin:0;color:inherit"><span class="name">${esc(nameOf(g, m.id, me))}
        <span class="small" data-share="${esc(m.id)}" style="display:block"></span></span>${input}${unit ? `<span class="small" style="width:44px">${unit}</span>` : ''}</label>`;
    }).join('');
    $app.querySelectorAll('[data-m]').forEach((i) => {
      i.oninput = i.onchange = () => { f.vals[i.dataset.m] = i.type === 'checkbox' ? i.checked : i.value; refresh(); };
    });
  }

  function refresh() {
    const c = compute();
    const hint = q('#hint');
    const ok = c.amount && (f.currency === home || (c.rate > 0 && c.rate <= MAX_RATE));
    const owed = ok ? owedBy({ amount: c.amount, currency: f.currency, rate: c.rate, split: c.split }, g.members, home) : {};
    for (const m of g.people) {
      const el = row(m.id, 'data-share');
      if (el) el.textContent = owed[m.id] ? formatMoney(owed[m.id], home) : '';
    }
    if (c.error && String(f.amount).trim()) { hint.className = 'hint neg'; hint.textContent = c.error; }
    else if (ok && f.currency !== home) {
      hint.className = 'hint small'; hint.textContent = `${formatMoney(c.amount, f.currency)} = ${formatMoney(convert(c.amount, f.currency, home, c.rate), home)}`;
    } else { hint.className = 'hint'; hint.textContent = ''; }
  }

  async function currencyChanged() {
    rateNote = '';
    drawRate();
    if (f.currency !== home && !rateOf(f.x)) {
      const want = f.currency;
      const r = await defaultRate(want, home);
      if (f.currency !== want || !q('#ra')) return; // the user moved on while this was loading
      if (r && !rateOf(f.x)) { setRate(f.x, r.rate); rateNote = r.note; } else if (!r) rateNote = 'Could not fetch a rate. Type the one you got.';
      drawRate();
    }
    if (f.mode === 'exact') drawRows();
    refresh();
  }

  q('#desc').oninput = (e) => { f.desc = e.target.value; };
  q('#amt').oninput = (e) => { f.amount = e.target.value; refresh(); };
  q('#cur').onchange = (e) => { f.currency = e.target.value; f.x = rateState(0); currencyChanged(); };
  const paidNote = () => { q('#paidNote').textContent = f.paidBy === POOL_ID ? 'Paid out of the money everyone put together. Nobody is owed for this; it comes off the pool.' : ''; };
  q('#paid').onchange = (e) => { f.paidBy = e.target.value; paidNote(); };
  paidNote();
  q('#date').onchange = (e) => { f.date = e.target.value; };
  $app.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => {
      if (f.mode === b.dataset.mode) return;
      f.mode = b.dataset.mode;
      for (const m of g.people) f.vals[m.id] = f.mode === 'equal' ? true : f.mode === 'shares' ? '1' : '';
      drawRows(); refresh();
    };
  });
  q('#justme').onclick = () => {
    f.mode = 'equal';
    for (const m of g.people) f.vals[m.id] = m.id === me;
    drawRows(); refresh();
  };

  let done = false;
  q('#save').onclick = () => {
    if (done) return;
    const c = compute();
    const desc = f.desc.trim().slice(0, 80);
    if (!desc) return toast('Say what the expense was for.');
    if (c.error) return toast(c.error);
    if (changedSince(old)) return toast(STALE);
    done = true; q('#save').disabled = true;
    const now = Date.now();
    const item = {
      id, type: 'expense', desc, amount: c.amount, currency: f.currency,
      rate: f.currency === home ? 1 : c.rate, date: /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : today(), paidBy: f.paidBy, split: c.split,
      createdBy: old ? (old.createdBy || me) : me, createdAt: old ? old.createdAt : now, updatedBy: me, updatedAt: now, deleted: false,
    };
    if (item.paidBy === POOL_ID && !live.data.group.pool) { // first use of the pool starts it
      store.addMember(gid, { id: POOL_ID, name: POOL_NAME });
      log(gid, me, g, 'started a trip pool');
    }
    store.putItem(gid, item);
    LS.set('split:cur:' + gid, f.currency);
    LS.set('split:payer:' + gid, f.paidBy);
    const total = formatMoney(convert(item.amount, item.currency, home, item.rate), home);
    log(gid, me, g, `${old ? 'edited' : 'added'} “${desc}” (${total}, paid by ${nameOf(g, item.paidBy, null)})`);
    location.hash = '#/g/' + gid;
  };
  q('#del')?.addEventListener('click', () => {
    if (done) return;
    if (changedSince(old)) return toast(STALE);
    if (!confirm(`Delete “${old.desc}”?`)) return;
    done = true;
    store.putItem(gid, { ...old, createdBy: old.createdBy || me, updatedBy: me, updatedAt: Date.now(), deleted: true });
    log(gid, me, g, `deleted “${old.desc}” (${formatMoney(convert(old.amount, old.currency, home, old.rate), home)})`);
    location.hash = '#/g/' + gid;
  });

  drawRows();
  currencyChanged();
  if (!old) q('#desc').focus();
}

// ---------- payment editor ----------
function paymentEditor(g, d, me) {
  const { gid } = view;
  const home = g.currency;
  const isNew = view.id === 'new';
  const { old, gone } = isNew ? { old: null } : findItem(d, view.id, 'payment');
  if (!isNew && !old) { render(`<header class="top">${back('#/g/' + gid)}<h1>Payment</h1></header><p class="empty">This payment ${gone}.</p>`, true); return; }
  const id = old ? old.id : newId();
  const pre = isNew ? prefill : null; prefill = null;
  const has = (mid) => g.members.some((m) => m.id === mid);
  const from = old ? old.from : (pre && has(pre.from) ? pre.from : me);
  const to = old ? old.to : (pre && has(pre.to) ? pre.to : g.people.find((m) => m.id !== from)?.id);
  const start = old ? (old.orig || { amount: old.amount, currency: home, rate: 0 }) : { amount: pre ? pre.amount : 0, currency: home, rate: 0 };
  const f = { amount: start.amount ? String(fromMinor(start.amount, start.currency)) : '', currency: start.currency, x: rateState(start.rate) };
  let rateNote = '';
  const opts = (sel) => g.members.map((m) => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(nameOf(g, m.id, me))}</option>`).join('');
  render(`
    <header class="top">${back('#/g/' + gid + '/balances')}<h1>${old ? 'Edit payment' : to === POOL_ID ? 'Add money to pool' : 'Record a payment'}</h1></header>
    <div class="card">
      <label for="from">Who paid</label><select id="from">${opts(from)}</select>
      <label for="to">Paid to</label><select id="to">${opts(to)}</select>
      <label for="amt">Amount</label>
      <div class="inline"><input id="amt" inputmode="decimal" placeholder="0" value="${esc(f.amount)}" style="flex:1">
        <select id="cur" style="width:96px">${currencyOptions(f.currency, home, true)}</select></div>
      <div id="rateBox"></div>
      <div id="hint" class="hint"></div>
      <label for="date">Date</label><input id="date" type="date" value="${esc(old ? old.date || today() : today())}">
      <p class="small">Record this once the money has actually been paid (cash, UPI or bank). Only one of you needs to record it.</p>
      <div class="actions">${old ? '<button class="danger" id="del">Delete</button>' : ''}<button class="primary" id="save">Save payment</button></div>
    </div>`, true);
  const q = (s) => $app.querySelector(s);

  // The amount in the group currency is what the balances use; the original is kept beside it.
  function compute() {
    const foreign = f.currency !== home;
    const typed = toMinor(f.amount, f.currency);
    const rate = foreign ? rateOf(f.x) : 1;
    let error = null;
    if (!String(f.amount).trim()) error = 'Enter the amount.';
    else if (!typed || typed > MAX_AMOUNT) error = amountHelp(f.currency);
    else if (foreign && !(rate > 0 && rate <= MAX_RATE)) error = 'Enter the exchange rate you got.';
    const amount = error ? 0 : convert(typed, f.currency, home, rate);
    if (!error && !(amount > 0 && amount <= MAX_AMOUNT)) error = 'That comes to nothing in ' + home + '. Check the rate.';
    return { foreign, typed, rate, amount, error };
  }
  function refresh() {
    const c = compute(); const hint = q('#hint');
    if (c.error && String(f.amount).trim()) { hint.className = 'hint neg'; hint.textContent = c.error; }
    else if (!c.error && c.foreign) { hint.className = 'hint small'; hint.textContent = `${formatMoney(c.typed, f.currency)} = ${formatMoney(c.amount, home)}`; }
    else { hint.className = 'hint'; hint.textContent = ''; }
  }
  const drawRate = () => drawRateBox(q('#rateBox'), f.currency, home, f.x, rateNote, refresh);
  async function currencyChanged() {
    rateNote = ''; drawRate();
    if (f.currency !== home && !rateOf(f.x)) {
      const want = f.currency;
      const r = await defaultRate(want, home);
      if (f.currency !== want || !q('#ra')) return;
      if (r && !rateOf(f.x)) { setRate(f.x, r.rate); rateNote = r.note; } else if (!r) rateNote = 'Could not fetch a rate. Type the one you got.';
      drawRate();
    }
    refresh();
  }
  q('#amt').oninput = (e) => { f.amount = e.target.value; refresh(); };
  q('#cur').onchange = (e) => { f.currency = e.target.value; f.x = rateState(0); currencyChanged(); };

  // Rebuilds the stored record; a cleaned item carries `orig`, which the database does not hold.
  const record = (p) => {
    const doc = { id, type: 'payment', from: p.from, to: p.to, amount: p.amount, date: p.date,
      createdBy: p.createdBy, createdAt: p.createdAt, updatedBy: me, updatedAt: Date.now(), deleted: p.deleted };
    if (p.orig) Object.assign(doc, { currency: p.orig.currency, rate: p.orig.rate, desc: String(p.orig.amount) });
    return doc;
  };
  let done = false;
  q('#save').onclick = () => {
    if (done) return;
    const fr = q('#from').value; const t = q('#to').value;
    const c = compute();
    if (fr === t) return toast('Pick two different people.');
    if (c.error) return toast(c.error);
    if (changedSince(old)) return toast(STALE);
    const now = Date.now();
    const twin = live.data.items.find((x) => x.type === 'payment' && !x.deleted && x.id !== id
      && x.from === fr && x.to === t && x.amount === c.amount && now - x.createdAt < 2 * 86400000);
    if (twin && !confirm(`${nameOf(g, twin.createdBy, me)} already recorded this same payment on ${stamp(twin.createdAt)}. Record it a second time?`)) return;
    done = true; q('#save').disabled = true;
    const date = q('#date').value;
    store.putItem(gid, record({ from: fr, to: t, amount: c.amount, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today(),
      createdBy: old ? (old.createdBy || me) : me, createdAt: old ? old.createdAt : now, deleted: false,
      orig: c.foreign ? { amount: c.typed, currency: f.currency, rate: c.rate } : null }));
    const what = c.foreign ? `${formatMoney(c.typed, f.currency)} (${formatMoney(c.amount, home)})` : formatMoney(c.amount, home);
    log(gid, me, g, `${old ? 'edited a payment' : 'recorded a payment'}: ${nameOf(g, fr, null)} paid ${nameOf(g, t, null)} ${what}`);
    location.hash = '#/g/' + gid + '/balances';
  };
  q('#del')?.addEventListener('click', () => {
    if (done) return;
    if (changedSince(old)) return toast(STALE);
    if (!confirm('Delete this payment?')) return;
    done = true;
    store.putItem(gid, record({ ...old, createdBy: old.createdBy || me, deleted: true }));
    log(gid, me, g, `deleted a payment (${nameOf(g, old.from, null)} → ${nameOf(g, old.to, null)} ${formatMoney(old.amount, home)})`);
    location.hash = '#/g/' + gid + '/balances';
  });
  currencyChanged();
}

// ---------- add many expenses from a spreadsheet ----------
// Three screens: pick the file, answer questions about it (which column is what, who each
// name is, who shares), then check the list row by row. Nothing is saved before the last tap.
const FILE_ERRORS = {
  'old-xls': 'This is an old-style Excel file (.xls). Open it in Excel, choose Save As, pick “Excel Workbook (.xlsx)”, and bring that one in.',
  'too-big': 'That sheet is too big to open here.',
  'old-browser': 'This browser cannot open Excel files. Save the sheet as CSV and bring that in, or update the browser.',
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Everyone an answer can point at: the group's people, plus names from the sheet that will join.
const impPeople = () => [...live.data.group.people, ...imp.added];
function impNewPerson(name) {
  const k = name.toLowerCase();
  if (!imp.newIds[k]) imp.newIds[k] = 'm' + newId(8);
  return { id: imp.newIds[k], name: name.slice(0, 30) };
}
function impSyncAdded() {
  const names = new Map();
  for (const v of imp.payers) if (imp.payerAns[v.key] === 'new') names.set(v.key, v.value);
  for (const v of imp.whoms) if (imp.sharerAns[v.key]?.pick === 'new') names.set(v.key, v.value);
  imp.added = [...names.values()].map(impNewPerson);
}
// The names found in a column, or null when it is plainly not a column of names.
function impNames(col) {
  if (col < 0) return [];
  const v = distinctValues(imp.sheets[imp.sheetIx].rows, imp.table, col);
  return v.length > MAX_NAMES ? null : v;
}
const impTaken = (v) => live.data.group.members.some((m) => m.name.toLowerCase() === v.key);
// What this phone answered last time for a name in this group's sheets, if it still makes sense.
function impRecall(kind, key) {
  const r = LS.get('split:impnames:' + imp.gid, {})?.[kind]?.[key];
  const ids = new Set(impPeople().map((p) => p.id));
  if (kind === 'payer') return r === 'skip' || r === POOL_ID || ids.has(r) ? r : null;
  if (r === 'all') return { pick: 'all' };
  const some = Array.isArray(r) ? r.filter((id) => ids.has(id)) : [];
  return !some.length || some.length !== r.length ? null : some.length === 1 ? { pick: some[0] } : { pick: 'some', ids: some };
}
function impRemember(answers) {
  const old = LS.get('split:impnames:' + imp.gid, {}) || {};
  const whom = Object.fromEntries(imp.whoms.map((v) => [v.key, imp.sharerAns[v.key].pick === 'all' ? 'all' : answers.sharers[v.key]]));
  const last = (o) => Object.fromEntries(Object.entries(o).slice(-100));
  LS.set('split:impnames:' + imp.gid, { payer: last({ ...old.payer, ...answers.payer }), whom: last({ ...old.whom, ...whom }) });
}
// First answers to "who is this name?", for the user to correct.
function impGuessPayers() {
  imp.payers = impNames(imp.map.paidBy);
  if (!imp.payers) { imp.payers = []; imp.map.paidBy = -1; toast('That column has too many different entries to be names, so it is not used for who paid.'); }
  imp.payerAns = {};
  for (const v of imp.payers) {
    imp.payerAns[v.key] = impRecall('payer', v.key) || guessPerson(v.value, live.data.group.people)
      || (/pool|kitty|common|contri/i.test(v.value) ? POOL_ID : impTaken(v) ? 'skip' : 'new');
  }
  impSyncAdded();
  impGuessWhoms();
}
function impGuessWhoms() {
  imp.whoms = impNames(imp.map.sharedBy);
  if (!imp.whoms) { imp.whoms = []; imp.map.sharedBy = -1; toast('That column has too many different entries to be names, so it is not used for who shares.'); }
  imp.sharerAns = {};
  const single = (v) => nameTokens(v.value).length <= 1;
  // Single names first, so "Asha and Ravi" can find people who are only now being added.
  for (const v of imp.whoms.filter(single)) {
    const s = guessSharers(v.value, impPeople());
    imp.sharerAns[v.key] = impRecall('whom', v.key) || (s.all ? { pick: 'all' } : s.ids.length ? { pick: s.ids[0] } : impTaken(v) ? { pick: 'some', ids: [] } : { pick: 'new' });
    impSyncAdded();
  }
  for (const v of imp.whoms.filter((x) => !single(x))) {
    const s = guessSharers(v.value, impPeople());
    imp.sharerAns[v.key] = impRecall('whom', v.key) || (s.all ? { pick: 'all' } : { pick: 'some', ids: s.ids });
  }
}
function impSetSheet(ix) {
  imp.sheetIx = ix;
  imp.table = findTable(imp.sheets[ix].rows);
  imp.map = { ...imp.table.guess };
  impGuessPayers();
}
// The answers in the plain form buildDrafts takes.
function impAnswers() {
  const all = impPeople().map((p) => p.id);
  const payer = {}; const sharers = {};
  for (const v of imp.payers) payer[v.key] = imp.payerAns[v.key] === 'new' ? impNewPerson(v.value).id : imp.payerAns[v.key];
  for (const v of imp.whoms) {
    const a = imp.sharerAns[v.key];
    sharers[v.key] = (a.pick === 'all' ? all : a.pick === 'new' ? [impNewPerson(v.value).id] : a.pick === 'some' ? a.ids : [a.pick]).filter((id) => all.includes(id));
  }
  return {
    currency: imp.currency, today: today(), payer, sharers,
    payerDefault: imp.map.paidBy >= 0 ? null : imp.payerDefault,
    sharersDefault: all.filter((id) => !imp.notSharing.has(id)),
  };
}

function importView(me) {
  imp.step = view.id === 'review' && imp.drafts ? 'review' : view.id === 'ask' && imp.sheets ? 'ask' : 'pick';
  importDraw(me);
}
function importDraw(me) {
  if (!imp || live?.data?.status !== 'ok') return;
  if (imp.step === 'ask') return importAsk(me);
  if (imp.step === 'review') return importReview(me);
  importPick(me);
}

function importPick(me) {
  const { gid } = imp;
  const mine = imp;
  render(`
    <header class="top">${back('#/g/' + gid)}<h1>Add from a sheet</h1></header>
    <div class="card"><div class="big">Bring in many expenses at once</div>
      <p class="small">Pick an Excel file (.xlsx) or a CSV file that has one expense on each row. You will be asked a few questions about it, then you can check and change every row. Nothing is added until you say so.</p>
      <label for="file">The sheet</label><input id="file" type="file" accept=".xlsx,.csv,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/comma-separated-values">
      <p class="small" id="reading"></p>
      <p class="small">It needs a column saying what each expense was for and a column with the amount. Date, who paid and who it was for are used when the sheet has them.
        In Google Sheets: File › Download › Microsoft Excel. The file itself stays on this phone; only the expenses you approve go to the group.</p>
    </div>`, true);
  $app.querySelector('#file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 15e6) { e.target.value = ''; return toast('That file is over 15 MB, which is too big to open here.'); }
    $app.querySelector('#reading').textContent = 'Reading the sheet…';
    let sheets;
    try { sheets = await readSheets(new Uint8Array(await f.arrayBuffer()), f.name); } catch (err) {
      if (imp !== mine || imp.step !== 'pick') return;
      e.target.value = ''; $app.querySelector('#reading').textContent = '';
      return toast(FILE_ERRORS[err.message] || 'That file could not be read as a spreadsheet. Use an Excel file (.xlsx) or a CSV file.');
    }
    if (imp !== mine || imp.step !== 'pick') return; // left this screen while the file was being read
    if (!sheets.length) { e.target.value = ''; $app.querySelector('#reading').textContent = ''; return toast('That sheet has no rows in it.'); }
    const home = live.data.group.currency;
    Object.assign(imp, { fileName: f.name, sheets, currency: home, x: rateState(0), rateNote: '', payerDefault: me, notSharing: new Set(),
      newIds: {}, added: [], payers: [], whoms: [], drafts: null, edited: false });
    const usable = sheets.findIndex((s) => { const t = findTable(s.rows); return t.guess.desc >= 0 && t.guess.amount >= 0; });
    impSetSheet(Math.max(0, usable));
    location.hash = `#/g/${gid}/import/ask`;
  };
}

function importAsk(me) {
  const { gid } = imp;
  const g = live.data.group; const home = g.currency;
  const cols = imp.table.cols;
  const colOpts = (sel, none) => (none ? `<option value="-1" ${sel < 0 ? 'selected' : ''}>${esc(none)}</option>` : '')
    + cols.map((c) => `<option value="${c.i}" ${c.i === sel ? 'selected' : ''}>${esc(c.label)}${c.sample ? ' · e.g. ' + esc(/^d{4}-d{2}-d{2}$/.test(c.sample) ? shortDate(c.sample) : c.sample) : ''}</option>`).join('');
  const people = impPeople();
  const opt = (value, label, sel) => `<option value="${esc(value)}" ${value === sel ? 'selected' : ''}>${esc(label)}</option>`;
  const rowsOf = (v) => `<span class="small">${plural(v.count, 'row', 'rows')}</span>`;
  const colName = (i) => cols.find((c) => c.i === i)?.label || '';

  const payerRows = imp.payers.map((v, i) => `<div class="split-row"><span class="name">${esc(v.value)} ${rowsOf(v)}</span>
    <select data-payer="${i}" style="width:56%">${g.people.map((m) => opt(m.id, nameOf(g, m.id, me), imp.payerAns[v.key])).join('')}
      ${impTaken(v) ? '' : opt('new', 'New person: ' + v.value, imp.payerAns[v.key])}
      ${opt(POOL_ID, POOL_NAME + ' (common money)', imp.payerAns[v.key])}${opt('skip', 'Leave these rows out', imp.payerAns[v.key])}</select></div>`).join('');
  const whomRows = imp.whoms.map((v, i) => {
    const a = imp.sharerAns[v.key];
    return `<div class="split-row" style="flex-wrap:wrap"><span class="name">${esc(v.value)} ${rowsOf(v)}</span>
      <select data-whom="${i}" style="width:56%">${opt('all', 'Everyone', a.pick)}${people.map((m) => opt(m.id, m.id === me ? 'You' : m.name, a.pick)).join('')}
        ${impTaken(v) || nameTokens(v.value).length > 1 ? '' : opt('new', 'New person: ' + v.value, a.pick)}${opt('some', 'Choose people…', a.pick)}</select>
      ${a.pick === 'some' ? `<div style="width:100%;padding:4px 0 0 12px">${people.map((m) => `<label class="split-row" style="margin:0;color:inherit;border:0;padding:4px 0">
        <span class="name">${esc(m.id === me ? 'You' : m.name)}</span><input type="checkbox" data-whom-of="${i}" value="${esc(m.id)}" ${a.ids.includes(m.id) ? 'checked' : ''}></label>`).join('')}</div>` : ''}</div>`;
  }).join('');

  render(`
    <header class="top">${back('#/g/' + gid + '/import')}<h1>A few questions</h1></header>
    <p class="small">${esc(imp.fileName)}: answer these once and they apply to every row. You can still change any single row on the next screen.</p>
    ${imp.sheets.length > 1 ? `<div class="card"><div class="title">Which sheet has the expenses?</div>
      <select id="isheet" style="margin-top:8px">${imp.sheets.map((s, i) => `<option value="${i}" ${i === imp.sheetIx ? 'selected' : ''}>${esc(s.name)} · ${plural(s.rows.length, 'row', 'rows')}</option>`).join('')}</select></div>` : ''}
    <div class="card"><div class="title">1. Which column is which?</div>
      <p class="small" style="margin:4px 0 0">These are my guesses from the headings. Change any that are wrong.</p>
      <label for="cdesc">What it was for</label><select id="cdesc" data-col="desc">${colOpts(imp.map.desc, imp.map.desc < 0 ? 'Choose a column…' : '')}</select>
      <label for="camount">Amount</label><select id="camount" data-col="amount">${colOpts(imp.map.amount, imp.map.amount < 0 ? 'Choose a column…' : '')}</select>
      <label for="cdate">Date</label><select id="cdate" data-col="date">${colOpts(imp.map.date, 'No date column: use today')}</select>
      <label for="cpaid">Who paid</label><select id="cpaid" data-col="paidBy">${colOpts(imp.map.paidBy, 'No such column: I will say below')}</select>
      <label for="cwhom">Who it was for (who shares it)</label><select id="cwhom" data-col="sharedBy">${colOpts(imp.map.sharedBy, 'No such column: I will say below')}</select>
    </div>
    <div class="card"><div class="title">2. What currency are the amounts in?</div>
      <select id="icur" style="margin-top:8px">${currencyOptions(imp.currency, home)}</select>
      <div id="rateBox"></div><p class="small" id="curNote" style="margin:8px 0 0"></p></div>
    <div class="card"><div class="title">3. Who paid?</div>
      ${imp.map.paidBy >= 0 ? `<p class="small" style="margin:4px 0 8px">These names are in the “${esc(colName(imp.map.paidBy))}” column. Say who each one is.</p>${payerRows}`
    : `<p class="small" style="margin:4px 0 8px">The sheet does not say, so pick who paid for these. If different people paid, pick the main one and change the others on the next screen.</p>
        <select id="ipayer">${g.people.map((m) => opt(m.id, nameOf(g, m.id, me), imp.payerDefault)).join('')}${opt(POOL_ID, POOL_NAME + ' (common money)', imp.payerDefault)}</select>`}
    </div>
    <div class="card"><div class="title">4. Who shares them?</div>
      ${imp.map.sharedBy >= 0 ? `<p class="small" style="margin:4px 0 8px">These are in the “${esc(colName(imp.map.sharedBy))}” column. Say who each one means. A row where that cell is empty is shared by everyone.</p>${whomRows}`
    : `<p class="small" style="margin:4px 0 8px">Each expense is split equally among the people ticked here.</p>
        ${people.map((m) => `<label class="split-row" style="margin:0;color:inherit"><span class="name">${esc(m.id === me ? 'You' : m.name)}</span>
          <input type="checkbox" data-share="${esc(m.id)}" ${imp.notSharing.has(m.id) ? '' : 'checked'}></label>`).join('')}`}
      ${imp.added.length ? `<p class="small" style="margin:10px 0 0">New to the group, added when you save: <b>${esc(imp.added.map((p) => p.name).join(', '))}</b>.</p>` : ''}
    </div>
    <div class="actions"><button class="primary" id="tolist">Check the list</button></div>`, true);

  const q = (s) => $app.querySelector(s);
  const again = () => importDraw(me);
  q('#isheet')?.addEventListener('change', (e) => { impSetSheet(Number(e.target.value)); again(); });
  $app.querySelectorAll('[data-col]').forEach((s) => {
    s.onchange = () => {
      const kind = s.dataset.col; const col = Number(s.value);
      const was = { ...imp.map };
      // One column cannot be two things; the other use gives way.
      for (const k of Object.keys(imp.map)) if (k !== kind && col >= 0 && imp.map[k] === col) imp.map[k] = -1;
      imp.map[kind] = col;
      // Answers about names are kept unless the column they came from changed.
      if (imp.map.paidBy !== was.paidBy) impGuessPayers(); else if (imp.map.sharedBy !== was.sharedBy) impGuessWhoms();
      again();
    };
  });
  $app.querySelectorAll('[data-payer]').forEach((s) => {
    s.onchange = () => { imp.payerAns[imp.payers[Number(s.dataset.payer)].key] = s.value; impSyncAdded(); impGuessWhoms(); again(); };
  });
  $app.querySelectorAll('[data-whom]').forEach((s) => {
    s.onchange = () => {
      const v = imp.whoms[Number(s.dataset.whom)]; const old = imp.sharerAns[v.key];
      imp.sharerAns[v.key] = s.value === 'some' ? { pick: 'some', ids: old.pick === 'some' ? old.ids : [] } : { pick: s.value };
      impSyncAdded(); again();
    };
  });
  $app.querySelectorAll('[data-whom-of]').forEach((c) => {
    c.onchange = () => {
      const a = imp.sharerAns[imp.whoms[Number(c.dataset.whomOf)].key];
      a.ids = c.checked ? [...a.ids, c.value] : a.ids.filter((id) => id !== c.value);
    };
  });
  $app.querySelectorAll('[data-share]').forEach((c) => {
    c.onchange = () => { if (c.checked) imp.notSharing.delete(c.dataset.share); else imp.notSharing.add(c.dataset.share); };
  });
  q('#ipayer')?.addEventListener('change', (e) => { imp.payerDefault = e.target.value; });

  const drawRate = () => {
    drawRateBox(q('#rateBox'), imp.currency, home, imp.x, imp.rateNote, () => {});
    q('#curNote').textContent = imp.currency === home ? '' : `Every amount in the sheet is read as ${imp.currency} and turned into ${home} at this rate.`;
  };
  async function currencyChanged() {
    drawRate();
    if (imp.currency === home || rateOf(imp.x)) return;
    const mine = imp; const want = imp.currency;
    const r = await defaultRate(want, home);
    if (imp !== mine || imp.currency !== want || !q('#ra')) return; // moved on while this was loading
    if (r && !rateOf(imp.x)) { setRate(imp.x, r.rate); imp.rateNote = r.note; } else if (!r) imp.rateNote = 'Could not fetch a rate. Type the one you got.';
    drawRate();
  }
  q('#icur').onchange = (e) => { imp.currency = e.target.value; imp.x = rateState(0); imp.rateNote = ''; currencyChanged(); };
  currencyChanged();

  q('#tolist').onclick = () => {
    if (imp.map.desc < 0) return toast('Pick the column that says what each expense was for.');
    if (imp.map.amount < 0) return toast('Pick the column that has the amounts.');
    if (imp.currency !== home && !(rateOf(imp.x) > 0 && rateOf(imp.x) <= MAX_RATE)) return toast('Enter the exchange rate.');
    if (g.members.length + imp.added.length > 50) return toast('A group can have at most 50 people. Point some of the new names at people already in the group.');
    if (imp.edited && !confirm('This makes the list again from the sheet. Changes you made to single rows will be lost. Go on?')) return;
    const out = buildDrafts(imp.sheets[imp.sheetIx].rows, imp.table, imp.map, impAnswers());
    if (!out.drafts.length) return toast(out.leftOut ? 'Every row was left out by your answers under “Who paid?”.' : 'No row has a clear amount in that column. Check the Amount column.');
    out.dups = markDuplicates(out.drafts, live.data.items, imp.currency);
    Object.assign(imp, { drafts: out.drafts, found: out, open: -1, edited: false });
    location.hash = `#/g/${gid}/import/review`;
  };
}

function importReview(me) {
  const { gid } = imp;
  const g = live.data.group; const home = g.currency; const cur = imp.currency;
  const people = impPeople();
  const rate = cur === home ? 1 : rateOf(imp.x);
  const nm = (id) => (id === POOL_ID ? POOL_NAME : id === me ? 'You' : people.find((p) => p.id === id)?.name || 'Someone');
  const ds = imp.drafts;
  const ready = ds.filter((d) => d.include && !draftProblem(d));
  const stuck = ds.filter((d) => d.include && draftProblem(d)).length;
  const total = ready.reduce((s, d) => s + d.amount, 0);
  const usedNew = imp.added.filter((p) => ready.some((d) => d.paidBy === p.id || d.sharers.includes(p.id)));
  const forWhom = (d) => {
    const n = d.sharers.length;
    if (!n) return 'nobody yet';
    if (n === 1) return d.sharers[0] === d.paidBy ? 'personal' : `for ${nm(d.sharers[0])} only`;
    return n === people.length ? 'shared by everyone' : n === 2 ? `shared by ${nm(d.sharers[0])} and ${nm(d.sharers[1])}` : `shared by ${n} people`;
  };
  const f = imp.found;

  const row = (d, i) => {
    const problem = draftProblem(d);
    const open = imp.open === i;
    return `<div class="row" style="align-items:flex-start" data-row="${i}">
      <input type="checkbox" data-inc="${i}" ${d.include ? 'checked' : ''} aria-label="Add this one" style="margin-top:2px">
      <div class="grow" data-open="${i}" style="cursor:pointer"><div class="title">${d.desc.trim() ? esc(d.desc) : '<span class="neg">No description</span>'}</div>
        <div class="small">${esc(shortDate(d.date))} · ${d.paidBy ? esc(nm(d.paidBy)) + ' paid' : 'payer not known'} · ${esc(forWhom(d))}</div>
        ${d.note ? `<div class="small">${esc(d.note)}</div>` : ''}${problem && (d.include || !d.note) ? `<div class="small neg">${esc(problem)} Tap to fix.</div>` : ''}</div>
      <div class="right" data-open="${i}" style="cursor:pointer">${d.amount ? esc(formatMoney(d.amount, cur)) : '?'}<div class="small" style="color:var(--accent)">${open ? 'Close' : 'Change'}</div></div>
    </div>${open ? `<div style="padding:0 14px 14px;border-top:1px dashed var(--line)">
      <label for="idesc">What was it for?</label><input id="idesc" maxlength="80" value="${esc(d.desc)}">
      <label for="iamt">Amount (${esc(cur)})</label><input id="iamt" inputmode="decimal" value="${d.amount ? esc(String(fromMinor(d.amount, cur))) : ''}">
      <label for="idate">Date</label><input id="idate" type="date" value="${esc(d.date)}">
      <label for="ipaid">Paid by</label><select id="ipaid">${d.paidBy ? '' : '<option value="" selected>Choose…</option>'}
        ${people.map((m) => `<option value="${esc(m.id)}" ${m.id === d.paidBy ? 'selected' : ''}>${esc(nm(m.id))}</option>`).join('')}
        <option value="${POOL_ID}" ${d.paidBy === POOL_ID ? 'selected' : ''}>${POOL_NAME} (common money)</option></select>
      <label>Split equally among</label>
      ${people.map((m) => `<label class="split-row" style="margin:0;color:inherit"><span class="name">${esc(nm(m.id))}</span>
        <input type="checkbox" data-sh="${esc(m.id)}" ${d.sharers.includes(m.id) ? 'checked' : ''}></label>`).join('')}
      <div class="actions"><button id="idone" class="primary">Done</button></div></div>` : ''}`;
  };

  render(`
    <header class="top">${back('#/g/' + gid + '/import/ask')}<h1>Check the list</h1></header>
    <div class="card"><div class="big" id="readyline">${plural(ready.length, 'expense', 'expenses')} ready to add</div>
      <div class="small">Total ${esc(formatMoney(total, cur))}${cur !== home ? ' = ' + esc(formatMoney(convert(total, cur, home, rate), home)) : ''}, from “${esc(imp.fileName)}”.</div>
      ${stuck ? `<div class="small neg">${plural(stuck, 'ticked row still needs', 'ticked rows still need')} a detail (in red below) and will not be added until fixed.</div>` : ''}
      ${f.dups ? `<div class="small">${plural(f.dups, 'row is', 'rows are')} already in the group, so not ticked.</div>` : ''}
      ${f.noAmount ? `<div class="small">${plural(f.noAmount, 'row', 'rows')} had no clear amount and ${f.noAmount === 1 ? 'was' : 'were'} left out.</div>` : ''}
      ${f.leftOut ? `<div class="small">${plural(f.leftOut, 'row was', 'rows were')} left out as you asked.</div>` : ''}
      ${f.tooMany ? `<div class="small neg">Only the first ${MAX_DRAFTS} rows are shown. Bring in the rest as a second sheet.</div>` : ''}
      ${usedNew.length ? `<div class="small">Joining the group with this: <b>${esc(usedNew.map((p) => p.name).join(', '))}</b>.</div>` : ''}
      <div class="actions"><button class="primary" data-add ${ready.length ? '' : 'disabled'}>Add ${plural(ready.length, 'expense', 'expenses')}</button></div>
      <p class="small" style="margin:10px 0 0">Tap a row to change what it says, who paid or who shares it. Untick a row to leave it out. An uneven split (exact amounts or %) is set afterwards, by opening that expense.</p></div>
    <div class="list">${ds.map(row).join('')}</div>
    <div class="actions"><a class="btn" href="#/g/${esc(gid)}/import/ask">Back to the questions</a>
      <button class="primary" data-add ${ready.length ? '' : 'disabled'}>Add ${plural(ready.length, 'expense', 'expenses')}</button></div>`, true);

  const q = (s) => $app.querySelector(s);
  const again = () => importDraw(me);
  $app.querySelectorAll('[data-inc]').forEach((c) => { c.onchange = () => { ds[Number(c.dataset.inc)].include = c.checked; imp.edited = true; again(); }; });
  $app.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => { const i = Number(el.dataset.open); imp.open = imp.open === i ? -1 : i; again(); };
  });
  if (imp.open >= 0 && q('#idesc')) {
    const d = ds[imp.open];
    const touch = () => { imp.edited = true; };
    q('#idesc').oninput = (e) => { d.desc = e.target.value.slice(0, 80); touch(); };
    q('#iamt').oninput = (e) => { d.amount = amountOf(e.target.value, cur); touch(); };
    q('#idate').onchange = (e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) d.date = e.target.value; touch(); };
    q('#ipaid').onchange = (e) => { d.paidBy = e.target.value || null; touch(); };
    $app.querySelectorAll('[data-sh]').forEach((c) => {
      c.onchange = () => { d.sharers = people.map((p) => p.id).filter((id) => (id === c.dataset.sh ? c.checked : d.sharers.includes(id))); touch(); };
    });
    q('#idone').onclick = () => { imp.open = -1; again(); };
  }

  let done = false;
  $app.querySelectorAll('[data-add]').forEach((b) => {
    b.onclick = () => {
      if (done) return;
      const now = live.data.group; // the group as it is this moment, not as it was when the list was made
      const list = ds.filter((d) => d.include && !draftProblem(d));
      if (!list.length) return toast('Nothing is ticked.');
      const used = new Set(list.flatMap((d) => [d.paidBy, ...d.sharers]));
      const joining = imp.added.filter((p) => used.has(p.id));
      const startPool = used.has(POOL_ID) && !now.pool;
      const known = new Set([...now.members.map((m) => m.id), ...joining.map((p) => p.id), POOL_ID]);
      if ([...used].some((id) => !known.has(id))) return toast('Someone in this list has been removed from the group since. Go back to the questions and check the names.');
      const clash = joining.find((p) => now.members.some((m) => m.name.toLowerCase() === p.name.toLowerCase()));
      if (clash) return toast(`${clash.name} has joined the group since. Go back to the questions and point that name at them.`);
      if (now.members.length + joining.length + (startPool ? 1 : 0) > 50) return toast('A group can have at most 50 people.');
      if (!confirm(`Add ${plural(list.length, 'expense', 'expenses')} to “${now.name}”? Everyone in the group will see them.`)) return;
      done = true; $app.querySelectorAll('[data-add]').forEach((x) => { x.disabled = true; });
      for (const p of joining) store.addMember(gid, p);
      const after = { members: [...now.members, ...joining] };
      if (joining.length) log(gid, me, after, `added ${joining.map((p) => p.name).join(', ')} to the group`);
      if (startPool) { store.addMember(gid, { id: POOL_ID, name: POOL_NAME }); log(gid, me, after, 'started a trip pool'); }
      const at = Date.now(); const ids = [];
      list.forEach((d, i) => {
        const id = newId(); ids.push(id);
        store.putItem(gid, {
          id, type: 'expense', desc: d.desc.trim().slice(0, 80), amount: d.amount, currency: cur, rate,
          date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : today(), paidBy: d.paidBy,
          split: { mode: 'equal', weights: Object.fromEntries(d.sharers.map((s) => [s, 1])) },
          createdBy: me, createdAt: at + i, updatedBy: me, updatedAt: at + i, deleted: false,
        });
      });
      const sum = list.reduce((s, d) => s + convert(d.amount, cur, home, rate), 0);
      log(gid, me, after, `added ${plural(list.length, 'expense', 'expenses')} from a sheet (${formatMoney(sum, home)} in all)`);
      LS.set('split:lastimport:' + gid, { at, ids });
      impRemember(impAnswers());
      imp = null;
      location.hash = '#/g/' + gid;
    };
  });
}

// ---------- start ----------
async function start() {
  try {
    store = await openStore();
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<header class="top"><h1>Split</h1></header>
      <div class="card"><div class="big">Cannot connect</div>
      <p>The app could not reach its server. The first time you open it, it needs an internet connection.</p>
      <div class="actions"><button class="primary" id="retry">Try again</button></div></div>`;
    document.getElementById('retry').onclick = () => location.reload();
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}
// Keeps every phone on the latest published version. The saved copy opens instantly (and
// offline); the app then asks the site for a newer one, and when it has been downloaded the
// page reloads by itself, or waits until an open form is closed.
async function keepUpdated() {
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost')) return;
  const hadWorker = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadWorker || reloading) return; // the very first install is not an update
    const formOpen = view && view.drawn && (view.sub === 'e' || view.sub === 'p' || view.sub === 'import');
    if (formOpen) { updateReady = true; toast('A newer version is ready. It will load when you leave this form.'); return; }
    reloading = true; location.reload();
  });
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    const check = () => reg.update().catch(() => {});
    // A home-screen app is often only resumed, never reopened, so ask again each time it comes back.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    setInterval(check, 30 * 60 * 1000);
    check();
  } catch { /* no offline support in this browser; the app still works online */ }
  try {
    build = (await caches.keys()).filter((k) => k.startsWith('split-')).map((k) => k.slice(6)).pop() || '';
    const el = document.getElementById('build');
    if (el && build) el.textContent = 'Version ' + build;
  } catch { /* no cache storage */ }
}
keepUpdated();
start();
