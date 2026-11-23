// Everything read from the database passes through here before the app uses it. Anyone holding
// a group link can write to that group with their own tools, so records are checked for shape
// and anything malformed is dropped rather than shown. Pure: no DOM, no network.
import { CURRENCIES, convert } from './money.js';

export const GROUP_ID = /^[A-Za-z0-9]{20}$/;
export const ITEM_ID = /^[A-Za-z0-9]{20}$/;
export const MEMBER_ID = /^m[A-Za-z0-9]{8}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MODES = ['equal', 'exact', 'percent', 'shares'];
export const MAX_AMOUNT = 1e12;   // minor units; ten billion rupees
export const MAX_RATE = 1e6;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const amountOk = (v) => Number.isSafeInteger(v) && v > 0 && v <= MAX_AMOUNT;
const memberOrNull = (v) => (typeof v === 'string' && MEMBER_ID.test(v) ? v : null);
const time = (v) => (Number.isFinite(v) ? v : 0);

// Returns a safe group, or null if the record is not a usable group.
export function cleanGroup(raw) {
  if (!isObj(raw) || typeof raw.name !== 'string' || !CURRENCIES[raw.currency] || !Array.isArray(raw.members)) return null;
  const renames = isObj(raw.renames) ? raw.renames : {};
  const seen = new Set();
  const members = [];
  for (const m of raw.members) {
    if (!isObj(m) || !memberOrNull(m.id) || seen.has(m.id) || typeof m.name !== 'string') continue;
    seen.add(m.id);
    const renamed = typeof renames[m.id] === 'string' ? renames[m.id].trim() : '';
    const name = (renamed || m.name).trim().slice(0, 30);
    members.push({ id: m.id, name: name || 'Unnamed' });
  }
  return { name: raw.name.trim().slice(0, 60) || 'Untitled', currency: raw.currency, members, createdAt: time(raw.createdAt) };
}

// Returns a safe expense or payment, or null if the record cannot be trusted.
export function cleanItem(raw, home) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !ITEM_ID.test(raw.id) || !amountOk(raw.amount)) return null;
  const base = {
    id: raw.id, amount: raw.amount, deleted: raw.deleted === true,
    date: typeof raw.date === 'string' && DATE.test(raw.date) ? raw.date : '',
    createdBy: memberOrNull(raw.createdBy), createdAt: time(raw.createdAt),
    updatedBy: memberOrNull(raw.updatedBy), updatedAt: time(raw.updatedAt),
  };
  if (raw.type === 'payment') {
    const from = memberOrNull(raw.from); const to = memberOrNull(raw.to);
    if (!from || !to || from === to) return null;
    return { ...base, type: 'payment', from, to };
  }
  if (raw.type !== 'expense') return null;
  const paidBy = memberOrNull(raw.paidBy);
  if (!paidBy || !CURRENCIES[raw.currency] || !isObj(raw.split) || !MODES.includes(raw.split.mode) || !isObj(raw.split.weights)) return null;
  const rate = raw.currency === home ? 1 : raw.rate;
  if (!(Number.isFinite(rate) && rate > 0 && rate <= MAX_RATE)) return null;
  const weights = {};
  for (const [k, v] of Object.entries(raw.split.weights)) {
    if (memberOrNull(k) && Number.isFinite(v) && v > 0 && v <= MAX_AMOUNT) weights[k] = v;
  }
  if (Object.keys(weights).length === 0) return null;
  const total = convert(raw.amount, raw.currency, home, rate);
  if (!(Number.isSafeInteger(total) && total > 0 && total <= MAX_AMOUNT * 1000)) return null;
  return {
    ...base, type: 'expense', desc: str(raw.desc, 80).trim() || 'Expense', currency: raw.currency, rate, paidBy,
    split: { mode: raw.split.mode, weights },
  };
}

export function cleanLog(raw) {
  if (!isObj(raw) || !Number.isFinite(raw.at)) return null;
  return { at: raw.at, by: memberOrNull(raw.by), byName: str(raw.byName, 40) || 'Someone', text: str(raw.text, 400) };
}

// Cleans a whole snapshot. `unreadable` counts records that were dropped.
export function cleanData(d) {
  const group = cleanGroup(d.group);
  if (!group) return { group: null, items: [], log: [], unreadable: 0 };
  const known = new Set(group.members.map((m) => m.id));
  const used = new Set();
  const items = []; let unreadable = 0;
  for (const raw of d.items || []) {
    const it = cleanItem(raw, group.currency);
    // Money must stay between known people, or balances would stop adding up to zero.
    const people = !it ? [] : it.type === 'payment' ? [it.from, it.to] : [it.paidBy, ...Object.keys(it.split.weights)];
    if (!it || !people.every((id) => known.has(id))) { unreadable += 1; continue; }
    items.push(it);
    if (!it.deleted) people.forEach((id) => used.add(id));
  }
  // A person marked as removed disappears only while no live expense or payment involves them,
  // so nobody can be removed with money still attached.
  const removed = isObj(d.group.removed) ? d.group.removed : {};
  group.members = group.members.filter((m) => !(removed[m.id] === true && !used.has(m.id)));
  return { group, items, used, log: (d.log || []).map(cleanLog).filter(Boolean), unreadable };
}
