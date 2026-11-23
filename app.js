import {
  CURRENCIES, toMinor, fromMinor, formatMoney, convert, owedBy, balances, settle, validateSplit, amountHelp,
} from './money.js';
import { cleanData, GROUP_ID, MAX_AMOUNT, MAX_RATE } from './clean.js';
import { openStore, newId } from './store.js';

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
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  window.scrollTo(0, 0);
  document.querySelector('.toast')?.remove();
  lastHtml = '';
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
  const editor = view.sub === 'e' || view.sub === 'p';
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
  if (!me || !g.members.some((m) => m.id === me)) return whoAmI(g, d, view.gid);
  if (view.sub === 'e') { view.drawn = true; return expenseEditor(g, d, me); }
  if (view.sub === 'p') { view.drawn = true; return paymentEditor(g, d, me); }
  groupView(g, d, me);
}

// ---------- home ----------
function homeView() {
  const groups = LS.get('split:groups', []).filter((x) => x && GROUP_ID.test(x.id));
  render(`
    <header class="top"><h1>Split</h1></header>
    ${banners(null)}
    ${groups.length ? `<div class="list">${groups.map((x) => `
      <div class="row"><a class="grow plain" href="#/g/${esc(x.id)}"><div class="title">${esc(x.name)}</div>
      <div class="small">Last opened ${esc(stamp(x.at))}</div></a>
      <button class="icon" data-forget="${esc(x.id)}" aria-label="Remove from this phone">×</button></div>`).join('')}</div>
      <p class="small">× only takes a group off this phone’s list. The group and its link keep working.</p>`
    : '<p class="empty">No groups yet.<br>Make one for your next trip, then send the link to your friends.</p>'}
    <a class="btn primary fab" href="#/new">+ New group</a>`, true);
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
      <p class="small">Pick your name so the app can show what you owe. This phone will remember it.</p>
      <div class="list">${g.members.map((m) => `<button class="row" style="width:100%;background:none;border-radius:0" data-id="${esc(m.id)}">
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
    ...g.members.map((m) => `${m.name} share (${home})`)]];
  for (const x of [...items].reverse()) {
    if (x.type === 'payment') {
      rows.push([x.date, 'Payment', '', nameOf(g, x.from), nameOf(g, x.to), f(x.amount, home), home, 1, f(x.amount, home), ...g.members.map(() => '')]);
    } else {
      const owed = owedBy(x, g.members, home);
      rows.push([x.date, 'Expense', x.desc, nameOf(g, x.paidBy), '', f(x.amount, x.currency), x.currency, x.rate,
        f(convert(x.amount, x.currency, home, x.rate), home), ...g.members.map((m) => f(owed[m.id], home))]);
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
  const tab = (key, label, href) => `<a href="${esc(href)}" class="${sub === key ? 'on' : ''}">${label}</a>`;
  let body = '';

  if (sub === 'balances') {
    body = `
      <div class="list">${g.members.map((m) => {
        const v = bal[m.id];
        const you = m.id === me;
        const txt = v > 0 ? `<span class="pos">${you ? 'get' : 'gets'} back ${esc(formatMoney(v, home))}</span>`
          : v < 0 ? `<span class="neg">${you ? 'owe' : 'owes'} ${esc(formatMoney(-v, home))}</span>` : '<span class="small">settled up</span>';
        return `<div class="row"><div class="grow title">${esc(nameOf(g, m.id, me))}</div><div class="right">${txt}</div></div>`;
      }).join('')}</div>
      <h3>Suggested payments to settle</h3>
      ${plan.length ? `<div class="list">${plan.map((p, i) => `
        <div class="row"><div class="grow"><div class="title">${esc(nameOf(g, p.from, me))} → ${esc(nameOf(g, p.to, me))}</div>
        <div class="small">${esc(formatMoney(p.amount, home))}</div></div>
        <button data-pay="${i}">Mark paid</button></div>`).join('')}</div>
        <p class="small">Tap “Mark paid” only after the money has really moved, and only one of you needs to.</p>`
      : '<p class="empty">Everyone is settled up.</p>'}
      <p class="inline" style="flex-wrap:wrap"><a class="btn" href="#/g/${esc(gid)}/p/new">Record another payment</a>
        <button id="summary">Share summary</button><button id="csv">Download list</button></p>
      <h3>People</h3>
      <div class="list">${g.members.map((m) => `<div class="row"><div class="grow title">${esc(m.name)}${m.id === me ? ' <span class="small">(you)</span>' : ''}</div>
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
      <div class="card"><div class="big ${mine > 0 ? 'pos' : mine < 0 ? 'neg' : ''}">${mine > 0 ? 'You get back ' + esc(formatMoney(mine, home))
        : mine < 0 ? 'You owe ' + esc(formatMoney(-mine, home)) : 'You are settled up'}</div>
        <div class="small">Group spent ${esc(formatMoney(spent, home))} in total</div></div>
      ${items.length ? `<div class="list">${items.map((x) => itemRow(x, g, me, gid)).join('')}</div>`
      : '<p class="empty">No expenses yet. Tap “Add expense” when someone pays for something.</p>'}`;
  }

  if (!render(`
    <header class="top">${back('#/')}<h1>${esc(g.name)}</h1><button id="share">Share link</button></header>
    ${banners(d)}
    <nav class="tabs">${tab('expenses', 'Expenses', `#/g/${gid}`)}${tab('balances', 'Balances', `#/g/${gid}/balances`)}${tab('activity', 'Activity', `#/g/${gid}/activity`)}</nav>
    ${body}
    <a class="btn primary fab" href="#/g/${esc(gid)}/e/new">+ Add expense</a>`)) return;

  $app.querySelector('#share').onclick = () => shareGroup(g, gid);
  if (sub !== 'balances') return;
  $app.querySelectorAll('[data-pay]').forEach((b) => {
    b.onclick = () => { prefill = plan[Number(b.dataset.pay)]; location.hash = `#/g/${gid}/p/new`; };
  });
  $app.querySelector('#summary').onclick = () => {
    const lines = [`${g.name}: balances`,
      ...g.members.map((m) => `${m.name}: ${bal[m.id] > 0 ? 'gets back ' + formatMoney(bal[m.id], home) : bal[m.id] < 0 ? 'owes ' + formatMoney(-bal[m.id], home) : 'settled up'}`)];
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
  if (x.type === 'payment') {
    return `<a class="row" href="#/g/${esc(gid)}/p/${esc(x.id)}"><div class="small" style="width:44px">${esc(shortDate(x.date))}</div>
      <div class="grow"><div class="title">${esc(nameOf(g, x.from, me))} paid ${esc(nameOf(g, x.to, me))}</div><div class="small">Payment</div></div>
      <div class="right">${esc(formatMoney(x.amount, home))}</div></a>`;
  }
  const total = convert(x.amount, x.currency, home, x.rate);
  const myShare = owedBy(x, g.members, home)[me] || 0;
  const foreign = x.currency !== home ? ` · ${esc(formatMoney(x.amount, x.currency))}` : '';
  let mine;
  if (x.paidBy === me) mine = total - myShare > 0 ? `<span class="pos">you lent<br>${esc(formatMoney(total - myShare, home))}</span>` : '<span class="small">just you</span>';
  else mine = myShare > 0 ? `<span class="neg">you owe<br>${esc(formatMoney(myShare, home))}</span>` : '<span class="small">not in it</span>';
  return `<a class="row" href="#/g/${esc(gid)}/e/${esc(x.id)}"><div class="small" style="width:44px">${esc(shortDate(x.date))}</div>
    <div class="grow"><div class="title">${esc(x.desc)}</div><div class="small">${esc(nameOf(g, x.paidBy, me))} paid ${esc(formatMoney(total, home))}${foreign}</div></div>
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
    desc: old.desc, amount: String(fromMinor(old.amount, old.currency)), currency: old.currency, rate: String(old.rate),
    date: old.date || today(), paidBy: old.paidBy, mode: old.split.mode,
    vals: Object.fromEntries(g.members.map((m) => {
      const w = old.split.weights[m.id] || 0;
      if (old.split.mode === 'equal') return [m.id, w > 0];
      if (old.split.mode === 'exact') return [m.id, w ? String(fromMinor(w, old.currency)) : ''];
      return [m.id, w ? String(w) : ''];
    })),
  } : {
    desc: '', amount: '', currency: CURRENCIES[LS.get('split:cur:' + gid, home)] ? LS.get('split:cur:' + gid, home) : home,
    rate: '', date: today(), paidBy: me, mode: 'equal',
    vals: Object.fromEntries(g.members.map((m) => [m.id, true])),
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
      <select id="paid">${g.members.map((m) => `<option value="${esc(m.id)}" ${m.id === f.paidBy ? 'selected' : ''}>${esc(nameOf(g, m.id, me))}</option>`).join('')}</select>
      <label for="date">Date</label><input id="date" type="date" value="${esc(f.date)}">
      <label>Split</label>
      <div class="seg">${Object.entries(MODES).map(([k, v]) => `<button type="button" data-mode="${k}">${v}</button>`).join('')}</div>
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
    const rate = foreign ? num(f.rate) : 1;
    const weights = {};
    for (const m of g.members) {
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
    else if (f.mode === 'exact' && g.members.some((m) => String(f.vals[m.id] || '').trim() && !toMinor(f.vals[m.id], f.currency))) error = 'One of the exact amounts is not clear. ' + amountHelp(f.currency);
    else error = validateSplit(split, amount);
    return { amount, rate, split, error };
  }

  function drawRate() {
    if (f.currency === home) { q('#rateBox').innerHTML = ''; return; }
    q('#rateBox').innerHTML = `<label for="rate">Exchange rate: 1 ${esc(f.currency)} = ? ${esc(home)}</label>
      <input id="rate" inputmode="decimal" value="${esc(f.rate)}" placeholder="Fetching today’s rate…">
      <div class="small" id="rateNote">${esc(rateNote)}</div>`;
    q('#rate').oninput = (e) => { f.rate = e.target.value; refresh(); };
  }

  function drawRows() {
    $app.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === f.mode));
    q('#rows').innerHTML = g.members.map((m) => {
      const v = f.vals[m.id];
      const input = f.mode === 'equal'
        ? `<input type="checkbox" data-m="${esc(m.id)}" ${v ? 'checked' : ''}>`
        : `<input data-m="${esc(m.id)}" inputmode="decimal" value="${esc(v)}" placeholder="0">`;
      const unit = f.mode === 'exact' ? esc(f.currency) : f.mode === 'percent' ? '%' : f.mode === 'shares' ? 'shares' : '';
      return `<label class="split-row" style="margin:0;color:inherit"><span class="name">${esc(nameOf(g, m.id, me))}
        <span class="small" data-share="${esc(m.id)}" style="display:block"></span></span>${input}<span class="small" style="width:44px">${unit}</span></label>`;
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
    for (const m of g.members) {
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
    if (f.currency !== home && !f.rate) {
      const want = f.currency;
      const r = await fetchRate(want, home);
      if (f.currency !== want || !q('#rate')) return; // the user moved on while this was loading
      if (r && !f.rate) {
        f.rate = String(r.rate); q('#rate').value = f.rate;
        rateNote = r.date === today() ? 'Today’s rate is filled in. Change it if you got a different rate.'
          : `No internet: this is the rate from ${shortDate(r.date)}. Change it if you know today’s.`;
      } else if (!r) { q('#rate').placeholder = 'Type the rate'; rateNote = 'Could not fetch a rate. Type the one you got.'; }
      q('#rateNote').textContent = rateNote;
    }
    if (f.mode === 'exact') drawRows();
    refresh();
  }

  q('#desc').oninput = (e) => { f.desc = e.target.value; };
  q('#amt').oninput = (e) => { f.amount = e.target.value; refresh(); };
  q('#cur').onchange = (e) => { f.currency = e.target.value; f.rate = ''; currencyChanged(); };
  q('#paid').onchange = (e) => { f.paidBy = e.target.value; };
  q('#date').onchange = (e) => { f.date = e.target.value; };
  $app.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => {
      if (f.mode === b.dataset.mode) return;
      f.mode = b.dataset.mode;
      for (const m of g.members) f.vals[m.id] = f.mode === 'equal' ? true : f.mode === 'shares' ? '1' : '';
      drawRows(); refresh();
    };
  });

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
    store.putItem(gid, item);
    LS.set('split:cur:' + gid, f.currency);
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
  const to = old ? old.to : (pre && has(pre.to) ? pre.to : g.members.find((m) => m.id !== from)?.id);
  const amt = old ? old.amount : (pre ? pre.amount : 0);
  const opts = (sel) => g.members.map((m) => `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(nameOf(g, m.id, me))}</option>`).join('');
  render(`
    <header class="top">${back('#/g/' + gid + '/balances')}<h1>${old ? 'Edit payment' : 'Record a payment'}</h1></header>
    <div class="card">
      <label for="from">Who paid</label><select id="from">${opts(from)}</select>
      <label for="to">Paid to</label><select id="to">${opts(to)}</select>
      <label for="amt">Amount (${esc(home)})</label><input id="amt" inputmode="decimal" value="${amt ? esc(fromMinor(amt, home)) : ''}">
      <label for="date">Date</label><input id="date" type="date" value="${esc(old ? old.date || today() : today())}">
      <p class="small">Record this once the money has actually been paid (cash, UPI or bank). Only one of you needs to record it.</p>
      <div class="actions">${old ? '<button class="danger" id="del">Delete</button>' : ''}<button class="primary" id="save">Save payment</button></div>
    </div>`, true);
  const q = (s) => $app.querySelector(s);
  let done = false;
  q('#save').onclick = () => {
    if (done) return;
    const f = q('#from').value; const t = q('#to').value;
    const amount = toMinor(q('#amt').value, home);
    if (f === t) return toast('Pick two different people.');
    if (!amount || amount > MAX_AMOUNT) return toast(q('#amt').value.trim() ? amountHelp(home) : 'Enter the amount.');
    if (changedSince(old)) return toast(STALE);
    const now = Date.now();
    const twin = live.data.items.find((x) => x.type === 'payment' && !x.deleted && x.id !== id
      && x.from === f && x.to === t && x.amount === amount && now - x.createdAt < 2 * 86400000);
    if (twin && !confirm(`${nameOf(g, twin.createdBy, me)} already recorded this same payment on ${stamp(twin.createdAt)}. Record it a second time?`)) return;
    done = true; q('#save').disabled = true;
    const date = q('#date').value;
    store.putItem(gid, {
      id, type: 'payment', from: f, to: t, amount, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today(),
      createdBy: old ? (old.createdBy || me) : me, createdAt: old ? old.createdAt : now, updatedBy: me, updatedAt: now, deleted: false,
    });
    log(gid, me, g, `${old ? 'edited a payment' : 'recorded a payment'}: ${nameOf(g, f, null)} paid ${nameOf(g, t, null)} ${formatMoney(amount, home)}`);
    location.hash = '#/g/' + gid + '/balances';
  };
  q('#del')?.addEventListener('click', () => {
    if (done) return;
    if (changedSince(old)) return toast(STALE);
    if (!confirm('Delete this payment?')) return;
    done = true;
    store.putItem(gid, { ...old, createdBy: old.createdBy || me, updatedBy: me, updatedAt: Date.now(), deleted: true });
    log(gid, me, g, `deleted a payment (${nameOf(g, old.from, null)} → ${nameOf(g, old.to, null)} ${formatMoney(old.amount, home)})`);
    location.hash = '#/g/' + gid + '/balances';
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
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();
