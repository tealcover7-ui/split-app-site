import {
  CURRENCIES, toMinor, fromMinor, formatMoney, convert, owedBy, balances, settle, validateSplit,
} from './money.js';
import { openStore, newId } from './store.js';

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const shortDate = (d) => new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const stamp = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

let store;
let live = null;   // { gid, data, unsub }
let view = null;   // { gid, sub, id, q, drawn }

// ---------- small helpers ----------
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
window.addEventListener('store-error', (e) => toast('Could not save: ' + (e.detail?.message || e.detail)));

const meKey = (gid) => 'split:me:' + gid;
const getMe = (gid) => LS.get(meKey(gid), null);
function rememberGroup(gid, name) {
  const list = LS.get('split:groups', []).filter((x) => x.id !== gid);
  list.unshift({ id: gid, name, at: Date.now() });
  LS.set('split:groups', list);
}
const nameOf = (g, id, me) => (id === me ? 'You' : (g.members.find((m) => m.id === id)?.name || 'Someone'));
const testBanner = () => (store.mode === 'local'
  ? '<div class="banner">Test mode: groups stay on this phone only. Friends will see them once Firebase is connected.</div>' : '');

function currencyOptions(selected, first, short = false) {
  const codes = [first, ...Object.keys(CURRENCIES).filter((c) => c !== first)];
  return codes.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}${short ? '' : ' · ' + esc(CURRENCIES[c].name)}</option>`).join('');
}

async function fetchRate(from, to) {
  const k = 'split:rates:' + to;
  let c = LS.get(k, null);
  if (!c || c.date !== today()) {
    try {
      const j = await (await fetch('https://open.er-api.com/v6/latest/' + to)).json();
      if (j.result === 'success') { c = { date: today(), rates: j.rates }; LS.set(k, c); }
    } catch { /* offline: fall back to the last saved rates */ }
  }
  const x = c?.rates?.[from];
  return x ? +(1 / x).toPrecision(6) : null;
}

async function shareGroup(g, gid) {
  const url = location.origin + location.pathname + '#/g/' + gid;
  if (store.mode === 'local') toast('Test mode: friends cannot open this group yet.');
  const text = `Add our expenses for “${g.name}” here (no sign-up):`;
  if (navigator.share) {
    try { await navigator.share({ title: g.name, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied. Paste it in WhatsApp.'); } catch { prompt('Copy this link:', url); }
}

function log(gid, me, g, text) {
  store.addLog(gid, { at: Date.now(), by: me, byName: nameOf(g, me, null), text });
}

// ---------- routing ----------
function route() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  document.querySelector('.toast')?.remove();
  if (parts[0] === 'new') { stopLive(); return newGroupView(); }
  if (parts[0] === 'g' && parts[1]) {
    const gid = parts[1];
    if (!live || live.gid !== gid) {
      stopLive();
      live = { gid, data: null };
      live.unsub = store.watch(gid, (data) => { live.data = data; draw(); });
    }
    view = { gid, sub: parts[2] || 'expenses', id: parts[3], q: new URLSearchParams(qs || ''), drawn: false };
    return draw();
  }
  stopLive(); view = null;
  homeView();
}
function stopLive() { if (live) { live.unsub?.(); live = null; } }

function draw() {
  if (!view || !live) return;
  const editor = view.sub === 'e' || view.sub === 'p';
  if (editor && view.drawn) return; // do not wipe a form someone is typing into
  const d = live.data;
  if (!d || d.group === 'loading') {
    $app.innerHTML = '<p class="empty">Loading the group…<br><span class="small">The first time needs an internet connection.</span></p>';
    return;
  }
  if (d.group === null) {
    $app.innerHTML = `<header class="top"><a class="btn back" aria-label="Back" href="#/">‹</a><h1>Not found</h1></header>
      <p class="empty">This group does not exist. Check that the whole link was copied.</p>`;
    return;
  }
  const g = d.group;
  rememberGroup(view.gid, g.name);
  const me = getMe(view.gid);
  if (!me || !g.members.some((m) => m.id === me)) return whoAmI(g, view.gid);
  view.drawn = true;
  if (view.sub === 'e') return expenseEditor(g, d, me);
  if (view.sub === 'p') return paymentEditor(g, d, me);
  groupView(g, d, me);
}

// ---------- home ----------
function homeView() {
  const groups = LS.get('split:groups', []);
  $app.innerHTML = `
    <header class="top"><h1>Split</h1></header>
    ${testBanner()}
    ${groups.length ? `<div class="list">${groups.map((x) => `
      <a class="row" href="#/g/${esc(x.id)}"><div class="grow"><div class="title">${esc(x.name)}</div>
      <div class="small">Last opened ${stamp(x.at)}</div></div><span class="small">›</span></a>`).join('')}</div>`
    : '<p class="empty">No groups yet.<br>Make one for your next trip, then send the link to your friends.</p>'}
    <a class="btn primary fab" href="#/new">+ New group</a>`;
}

function newGroupView() {
  $app.innerHTML = `
    <header class="top"><a class="btn back" aria-label="Back" href="#/">‹</a><h1>New group</h1></header>
    ${testBanner()}
    <div class="card">
      <label for="gname">Group name</label><input id="gname" placeholder="Vietnam trip 2026" maxlength="60">
      <label for="gcur">Main currency (balances are shown in this)</label><select id="gcur">${currencyOptions('INR', 'INR')}</select>
      <label for="myname">Your name</label><input id="myname" maxlength="30" value="${esc(LS.get('split:myname', ''))}">
      <label>Friends</label><div id="friends"></div>
      <button id="addf" type="button" style="margin-top:8px">+ Add another person</button>
      <div class="actions"><button class="primary" id="create">Create group</button></div>
    </div>`;
  const friends = $app.querySelector('#friends');
  const addField = () => {
    const i = document.createElement('input');
    i.maxLength = 30; i.placeholder = 'Name'; i.style.marginTop = '6px';
    friends.appendChild(i); return i;
  };
  addField(); addField();
  $app.querySelector('#addf').onclick = () => addField().focus();
  $app.querySelector('#create').onclick = async () => {
    const name = $app.querySelector('#gname').value.trim();
    const myName = $app.querySelector('#myname').value.trim();
    if (!name) return toast('Give the group a name.');
    if (!myName) return toast('Enter your name.');
    const names = [myName];
    for (const i of friends.querySelectorAll('input')) {
      const n = i.value.trim();
      if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
    }
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
function whoAmI(g, gid) {
  $app.innerHTML = `
    <header class="top"><a class="btn back" aria-label="Back" href="#/">‹</a><h1>${esc(g.name)}</h1></header>
    ${testBanner()}
    <div class="card"><div class="big">Who are you?</div>
      <p class="small">Pick your name so the app can show what you owe. This phone will remember it.</p>
      <div class="list">${g.members.map((m) => `<button class="row" style="width:100%;background:none;border-radius:0" data-id="${esc(m.id)}">
        <span class="grow title" style="text-align:left">${esc(m.name)}</span>›</button>`).join('')}</div>
      <label for="newname">Not on the list? Add yourself</label>
      <div class="inline"><input id="newname" maxlength="30" placeholder="Your name"><button id="join">Join</button></div>
    </div>`;
  $app.querySelectorAll('[data-id]').forEach((b) => { b.onclick = () => { LS.set(meKey(gid), b.dataset.id); view.drawn = false; draw(); }; });
  $app.querySelector('#join').onclick = () => {
    const n = $app.querySelector('#newname').value.trim();
    if (!n) return;
    if (g.members.some((m) => m.name.toLowerCase() === n.toLowerCase())) return toast(`${n} is already on the list. Tap the name above.`);
    const m = { id: 'm' + newId(8), name: n };
    store.addMember(gid, m);
    LS.set(meKey(gid), m.id);
    log(gid, m.id, { members: [...g.members, m] }, 'joined the group');
  };
}

// ---------- group screens ----------
function groupView(g, d, me) {
  const { gid, sub } = view;
  const home = g.currency;
  const items = d.items.filter((x) => !x.deleted)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
  const bal = balances(items, g.members, home);
  const tab = (key, label, href) => `<a href="${href}" class="${sub === key ? 'on' : ''}">${label}</a>`;
  let body = '';

  if (sub === 'balances') {
    const plan = settle(bal);
    body = `
      <div class="list">${g.members.map((m) => {
        const v = bal[m.id];
        const you = m.id === me;
        const txt = v > 0 ? `<span class="pos">${you ? 'get' : 'gets'} back ${formatMoney(v, home)}</span>`
          : v < 0 ? `<span class="neg">${you ? 'owe' : 'owes'} ${formatMoney(-v, home)}</span>` : '<span class="small">settled up</span>';
        return `<div class="row"><div class="grow title">${esc(nameOf(g, m.id, me))}</div><div class="right">${txt}</div></div>`;
      }).join('')}</div>
      <h3>Fewest payments to settle</h3>
      ${plan.length ? `<div class="list">${plan.map((p) => `
        <div class="row"><div class="grow"><div class="title">${esc(nameOf(g, p.from, me))} → ${esc(nameOf(g, p.to, me))}</div>
        <div class="small">${formatMoney(p.amount, home)}</div></div>
        <a class="btn back" aria-label="Back" href="#/g/${gid}/p/new?from=${p.from}&to=${p.to}&amt=${p.amount}">Mark paid</a></div>`).join('')}</div>`
      : '<p class="empty">Everyone is settled up.</p>'}
      <p><a class="btn back" aria-label="Back" href="#/g/${gid}/p/new">Record some other payment</a></p>
      <h3>People</h3>
      <div class="card">
        <div class="small">${g.members.map((m) => esc(m.name)).join(', ')}</div>
        <label for="addname">Add a person</label>
        <div class="inline"><input id="addname" maxlength="30" placeholder="Name"><button id="addp">Add</button></div>
        <p class="small" style="margin-top:14px">This phone is set as <b>${esc(nameOf(g, me, null))}</b>. <a href="#" id="switch">Not you?</a></p>
      </div>`;
  } else if (sub === 'activity') {
    body = d.log.length ? `<div class="list">${d.log.map((l) => `
      <div class="row"><div class="grow"><div><b>${esc(l.by === me ? 'You' : l.byName)}</b> ${esc(l.text)}</div>
      <div class="small">${stamp(l.at)}</div></div></div>`).join('')}</div>` : '<p class="empty">Nothing yet.</p>';
  } else {
    const mine = bal[me] || 0;
    const spent = items.filter((x) => x.type !== 'payment').reduce((s, x) => s + convert(x.amount, x.currency, home, x.rate), 0);
    body = `
      <div class="card"><div class="big ${mine > 0 ? 'pos' : mine < 0 ? 'neg' : ''}">${mine > 0 ? 'You get back ' + formatMoney(mine, home)
        : mine < 0 ? 'You owe ' + formatMoney(-mine, home) : 'You are settled up'}</div>
        <div class="small">Group spent ${formatMoney(spent, home)} in total</div></div>
      ${items.length ? `<div class="list">${items.map((x) => itemRow(x, g, me, gid)).join('')}</div>`
      : '<p class="empty">No expenses yet. Tap “Add expense” when someone pays for something.</p>'}`;
  }

  $app.innerHTML = `
    <header class="top"><a class="btn back" aria-label="Back" href="#/">‹</a><h1>${esc(g.name)}</h1><button id="share">Share link</button></header>
    ${testBanner()}
    ${d.offline && store.mode === 'cloud' ? '<div class="banner">Offline. Your changes are saved and will sync when you are back online.</div>' : ''}
    <nav class="tabs">${tab('expenses', 'Expenses', `#/g/${gid}`)}${tab('balances', 'Balances', `#/g/${gid}/balances`)}${tab('activity', 'Activity', `#/g/${gid}/activity`)}</nav>
    ${body}
    <a class="btn primary fab" href="#/g/${gid}/e/new">+ Add expense</a>`;

  $app.querySelector('#share').onclick = () => shareGroup(g, gid);
  const addp = $app.querySelector('#addp');
  if (addp) {
    addp.onclick = () => {
      const n = $app.querySelector('#addname').value.trim();
      if (!n) return;
      if (g.members.some((m) => m.name.toLowerCase() === n.toLowerCase())) return toast(`${n} is already in the group.`);
      store.addMember(gid, { id: 'm' + newId(8), name: n });
      log(gid, me, g, `added ${n} to the group`);
    };
    $app.querySelector('#switch').onclick = (e) => { e.preventDefault(); LS.set(meKey(gid), null); view.drawn = false; draw(); };
  }
}

function itemRow(x, g, me, gid) {
  const home = g.currency;
  if (x.type === 'payment') {
    return `<a class="row" href="#/g/${gid}/p/${x.id}"><div class="small" style="width:44px">${shortDate(x.date)}</div>
      <div class="grow"><div class="title">${esc(nameOf(g, x.from, me))} paid ${esc(nameOf(g, x.to, me))}</div><div class="small">Payment</div></div>
      <div class="right">${formatMoney(x.amount, home)}</div></a>`;
  }
  const total = convert(x.amount, x.currency, home, x.rate);
  const myShare = owedBy(x, g.members, home)[me] || 0;
  const foreign = x.currency !== home ? ` · ${formatMoney(x.amount, x.currency)}` : '';
  let mine;
  if (x.paidBy === me) mine = total - myShare > 0 ? `<span class="pos">you lent<br>${formatMoney(total - myShare, home)}</span>` : '<span class="small">just you</span>';
  else mine = myShare > 0 ? `<span class="neg">you owe<br>${formatMoney(myShare, home)}</span>` : '<span class="small">not in it</span>';
  return `<a class="row" href="#/g/${gid}/e/${x.id}"><div class="small" style="width:44px">${shortDate(x.date)}</div>
    <div class="grow"><div class="title">${esc(x.desc)}</div><div class="small">${esc(nameOf(g, x.paidBy, me))} paid ${formatMoney(total, home)}${foreign}</div></div>
    <div class="right small">${mine}</div></a>`;
}

// ---------- expense editor ----------
const MODES = { equal: 'Equally', exact: 'Exact', percent: '%', shares: 'Shares' };

function expenseEditor(g, d, me) {
  const { gid } = view;
  const home = g.currency;
  const old = view.id !== 'new' ? d.items.find((x) => x.id === view.id && !x.deleted) : null;
  if (view.id !== 'new' && !old) { $app.innerHTML = `<p class="empty">This expense was deleted. <a href="#/g/${gid}">Back</a></p>`; return; }

  const f = old ? {
    desc: old.desc, amount: String(fromMinor(old.amount, old.currency)), currency: old.currency, rate: String(old.rate),
    date: old.date, paidBy: old.paidBy, mode: old.split.mode,
    vals: Object.fromEntries(g.members.map((m) => {
      const w = old.split.weights[m.id] || 0;
      if (old.split.mode === 'equal') return [m.id, w > 0];
      if (old.split.mode === 'exact') return [m.id, w ? String(fromMinor(w, old.currency)) : ''];
      return [m.id, w ? String(w) : ''];
    })),
  } : {
    desc: '', amount: '', currency: LS.get('split:cur:' + gid, home), rate: '', date: today(), paidBy: me, mode: 'equal',
    vals: Object.fromEntries(g.members.map((m) => [m.id, true])),
  };

  $app.innerHTML = `
    <header class="top"><a class="btn back" aria-label="Back" href="#/g/${gid}">‹</a><h1>${old ? 'Edit expense' : 'Add expense'}</h1></header>
    <div class="card">
      <label for="desc">What was it for?</label><input id="desc" maxlength="80" placeholder="Dinner, taxi, hotel…" value="${esc(f.desc)}">
      <label for="amt">Amount</label>
      <div class="inline"><input id="amt" inputmode="decimal" placeholder="0" value="${esc(f.amount)}" style="flex:1">
        <select id="cur" style="width:96px">${currencyOptions(f.currency, home, true)}</select></div>
      <div id="rateBox"></div>
      <label for="paid">Paid by</label>
      <select id="paid">${g.members.map((m) => `<option value="${m.id}" ${m.id === f.paidBy ? 'selected' : ''}>${esc(nameOf(g, m.id, me))}</option>`).join('')}</select>
      <label for="date">Date</label><input id="date" type="date" value="${esc(f.date)}">
      <label>Split</label>
      <div class="seg">${Object.entries(MODES).map(([k, v]) => `<button type="button" data-mode="${k}">${v}</button>`).join('')}</div>
      <div id="rows" style="margin-top:8px"></div>
      <div id="hint" class="hint"></div>
      <div class="actions">${old ? '<button class="danger" id="del">Delete</button>' : ''}<button class="primary" id="save">Save</button></div>
      ${old ? `<p class="small">Added by ${esc(nameOf(g, old.createdBy, me))} on ${stamp(old.createdAt)}${old.updatedBy && old.updatedAt !== old.createdAt ? `; last changed by ${esc(nameOf(g, old.updatedBy, me))} on ${stamp(old.updatedAt)}` : ''}.</p>` : ''}
    </div>`;

  const q = (s) => $app.querySelector(s);

  function compute() {
    const amount = toMinor(f.amount, f.currency);
    const foreign = f.currency !== home;
    const rate = foreign ? Number(f.rate) : 1;
    const weights = {};
    for (const m of g.members) {
      const v = f.vals[m.id];
      let w = 0;
      if (f.mode === 'equal') w = v ? 1 : 0;
      else if (f.mode === 'exact') w = toMinor(v, f.currency) || 0;
      else w = Number(v) > 0 ? Number(v) : 0;
      if (w > 0) weights[m.id] = w;
    }
    const split = { mode: f.mode, weights };
    let error = null;
    if (!amount) error = 'Enter the amount.';
    else if (foreign && !(rate > 0)) error = 'Enter the exchange rate.';
    else error = validateSplit(split, amount);
    return { amount, rate, split, error };
  }

  function drawRate() {
    if (f.currency === home) { q('#rateBox').innerHTML = ''; return; }
    q('#rateBox').innerHTML = `<label for="rate">Exchange rate: 1 ${f.currency} = ? ${home}</label>
      <input id="rate" inputmode="decimal" value="${esc(f.rate)}" placeholder="Fetching today’s rate…">
      <div class="small">Today’s rate is filled in. Change it if you got a different rate.</div>`;
    q('#rate').oninput = (e) => { f.rate = e.target.value; refresh(); };
  }

  function drawRows() {
    $app.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === f.mode));
    q('#rows').innerHTML = g.members.map((m) => {
      const v = f.vals[m.id];
      const input = f.mode === 'equal'
        ? `<input type="checkbox" data-m="${m.id}" ${v ? 'checked' : ''}>`
        : `<input data-m="${m.id}" inputmode="decimal" value="${esc(v)}" placeholder="0">`;
      const unit = f.mode === 'exact' ? f.currency : f.mode === 'percent' ? '%' : f.mode === 'shares' ? 'shares' : '';
      return `<label class="split-row" style="margin:0;color:inherit"><span class="name">${esc(nameOf(g, m.id, me))}
        <span class="small" data-share="${m.id}" style="display:block"></span></span>${input}<span class="small" style="width:44px">${unit}</span></label>`;
    }).join('');
    $app.querySelectorAll('[data-m]').forEach((i) => {
      i.oninput = i.onchange = () => { f.vals[i.dataset.m] = i.type === 'checkbox' ? i.checked : i.value; refresh(); };
    });
  }

  function refresh() {
    const c = compute();
    const hint = q('#hint');
    if (c.amount && (f.currency === home || c.rate > 0)) {
      const owed = owedBy({ amount: c.amount, currency: f.currency, rate: c.rate, split: c.split }, g.members, home);
      for (const m of g.members) {
        const el = $app.querySelector(`[data-share="${m.id}"]`);
        if (el) el.textContent = owed[m.id] ? formatMoney(owed[m.id], home) : '';
      }
    }
    if (c.error && c.amount) { hint.className = 'hint neg'; hint.textContent = c.error; }
    else if (c.amount && f.currency !== home && c.rate > 0) {
      hint.className = 'hint small'; hint.textContent = `${formatMoney(c.amount, f.currency)} = ${formatMoney(convert(c.amount, f.currency, home, c.rate), home)}`;
    } else { hint.className = 'hint'; hint.textContent = ''; }
  }

  async function currencyChanged() {
    drawRate();
    if (f.currency !== home && !f.rate) {
      const r = await fetchRate(f.currency, home);
      if (r && !f.rate && q('#rate')) { f.rate = String(r); q('#rate').value = f.rate; }
      if (!r && q('#rate')) q('#rate').placeholder = 'No internet: type the rate';
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

  q('#save').onclick = () => {
    const c = compute();
    const desc = f.desc.trim();
    if (!desc) return toast('Say what the expense was for.');
    if (c.error) return toast(c.error);
    const now = Date.now();
    const item = {
      id: old ? old.id : newId(), type: 'expense', desc, amount: c.amount, currency: f.currency,
      rate: f.currency === home ? 1 : c.rate, date: f.date || today(), paidBy: f.paidBy, split: c.split,
      createdBy: old ? old.createdBy : me, createdAt: old ? old.createdAt : now, updatedBy: me, updatedAt: now, deleted: false,
    };
    store.putItem(gid, item);
    LS.set('split:cur:' + gid, f.currency);
    const total = formatMoney(convert(item.amount, item.currency, home, item.rate), home);
    log(gid, me, g, `${old ? 'edited' : 'added'} “${desc}” (${total}, paid by ${nameOf(g, item.paidBy, null)})`);
    location.hash = '#/g/' + gid;
  };
  q('#del')?.addEventListener('click', () => {
    if (!confirm(`Delete “${old.desc}”?`)) return;
    store.putItem(gid, { ...old, deleted: true, updatedBy: me, updatedAt: Date.now() });
    log(gid, me, g, `deleted “${old.desc}”`);
    location.hash = '#/g/' + gid;
  });

  drawRows();
  currencyChanged();
  if (!old) q('#desc').focus();
}

// ---------- payment editor ----------
function paymentEditor(g, d, me) {
  const { gid, q: params } = view;
  const home = g.currency;
  const old = view.id !== 'new' ? d.items.find((x) => x.id === view.id && !x.deleted) : null;
  if (view.id !== 'new' && !old) { $app.innerHTML = `<p class="empty">This payment was deleted. <a href="#/g/${gid}">Back</a></p>`; return; }
  const from = old ? old.from : params.get('from') || me;
  const to = old ? old.to : params.get('to') || g.members.find((m) => m.id !== from)?.id;
  const amt = old ? old.amount : Number(params.get('amt')) || 0;
  const opts = (sel) => g.members.map((m) => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(nameOf(g, m.id, me))}</option>`).join('');
  $app.innerHTML = `
    <header class="top"><a class="btn back" aria-label="Back" href="#/g/${gid}/balances">‹</a><h1>${old ? 'Edit payment' : 'Record a payment'}</h1></header>
    <div class="card">
      <label for="from">Who paid</label><select id="from">${opts(from)}</select>
      <label for="to">Paid to</label><select id="to">${opts(to)}</select>
      <label for="amt">Amount (${home})</label><input id="amt" inputmode="decimal" value="${amt ? fromMinor(amt, home) : ''}">
      <label for="date">Date</label><input id="date" type="date" value="${esc(old ? old.date : today())}">
      <p class="small">Record this once the money has actually been paid (cash, UPI or bank).</p>
      <div class="actions">${old ? '<button class="danger" id="del">Delete</button>' : ''}<button class="primary" id="save">Save payment</button></div>
    </div>`;
  const q = (s) => $app.querySelector(s);
  q('#save').onclick = () => {
    const f = q('#from').value; const t = q('#to').value;
    const amount = toMinor(q('#amt').value, home);
    if (f === t) return toast('Pick two different people.');
    if (!amount) return toast('Enter the amount.');
    const now = Date.now();
    store.putItem(gid, {
      id: old ? old.id : newId(), type: 'payment', from: f, to: t, amount, date: q('#date').value || today(),
      createdBy: old ? old.createdBy : me, createdAt: old ? old.createdAt : now, updatedBy: me, updatedAt: now, deleted: false,
    });
    log(gid, me, g, `${old ? 'edited a payment' : 'recorded a payment'}: ${nameOf(g, f, null)} paid ${nameOf(g, t, null)} ${formatMoney(amount, home)}`);
    location.hash = '#/g/' + gid + '/balances';
  };
  q('#del')?.addEventListener('click', () => {
    if (!confirm('Delete this payment?')) return;
    store.putItem(gid, { ...old, deleted: true, updatedBy: me, updatedAt: Date.now() });
    log(gid, me, g, `deleted a payment (${nameOf(g, old.from, null)} → ${nameOf(g, old.to, null)} ${formatMoney(old.amount, home)})`);
    location.hash = '#/g/' + gid + '/balances';
  });
}

// ---------- start ----------
(async () => {
  store = await openStore();
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
