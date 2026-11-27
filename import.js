// Turns the rows of a spreadsheet into draft expenses. Pure: no DOM, no network.
// The app asks the questions (which column is what, who each name is); this file only guesses
// sensible first answers and applies the final ones.
import { toMinor, fromMinor } from './money.js';
import { MAX_AMOUNT } from './clean.js';

export const MAX_DRAFTS = 1000;
export const MAX_NAMES = 30; // more different values than this in a "who" column means it is not a column of names

export const cellText = (c) => (c == null ? '' : typeof c === 'object' ? (c.date || '') : String(c)).trim();
const lower = (c) => cellText(c).toLowerCase();
const colLetter = (i) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));

// What each kind of column tends to be called. The first pattern that matches wins, so the
// most certain wording comes first.
const HEADS = {
  desc: [/^(particulars?|description|purpose|details?|narration|item|expense|what)$/, /particular|descri|purpose|narrat|detail|item|expense|remark|note/],
  amount: [/^(amount|amt)$/, /^(amount|amt)\b/, /^(cost|price|total|value|spent|inr|rs\.?|rupees)$/, /amount|amt|cost|price/],
  date: [/^(date|day)$/, /\bdate\b/],
  paidBy: [/paid\s*by|payer|who\s*paid|spent\s*by|paid\s*from/, /^(name|person|by|who|member)$/],
  sharedBy: [/benefici|shared|for\s*whom|whose|split\s*(between|among|with)|on\s*behalf/],
};
const headKind = (text) => Object.keys(HEADS).find((k) => HEADS[k].some((re) => re.test(text)));

// Finds the header row and guesses which column is which.
// Returns { headerRow (-1 if none), cols: [{ i, label, sample }], guess: { desc, amount, date, paidBy, sharedBy } } with -1 for "none".
export function findTable(rows) {
  let headerRow = -1; let best = 1;
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const kinds = new Set(rows[r].filter((c) => typeof c === 'string').map((c) => headKind(c.toLowerCase())).filter(Boolean));
    if (kinds.size > best) { best = kinds.size; headerRow = r; }
  }
  const body = rows.slice(headerRow + 1);
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const cols = [];
  for (let i = 0; i < width; i++) {
    const cells = body.map((r) => r[i]).filter((c) => c !== '' && c != null);
    if (!cells.length) continue;
    const head = headerRow >= 0 ? cellText(rows[headerRow][i]) : '';
    cols.push({
      i, label: (head || 'Column ' + colLetter(i)).slice(0, 40), named: !!head, sample: cellText(cells[0]).slice(0, 30), filled: cells.length,
      dates: cells.filter((c) => dateOf(c)).length, numbers: cells.filter((c) => typeof c === 'number').length,
      texts: cells.filter((c) => typeof c === 'string').length,
      textLen: cells.reduce((s, c) => s + (typeof c === 'string' ? c.length : 0), 0),
      counting: cells.length > 2 && cells.every((c, k) => c === k + 1), // a serial-number column
    });
  }
  const guess = { desc: -1, amount: -1, date: -1, paidBy: -1, sharedBy: -1 };
  // `sure` marks a guess the heading states outright. A bare "Name" or "Person" column holds
  // names, but the heading does not say whether that person paid or it was bought for them.
  const sure = { desc: false, amount: false, date: false, paidBy: false, sharedBy: false };
  for (const kind of Object.keys(guess)) {
    for (const [n, re] of HEADS[kind].entries()) {
      const hit = cols.find((c) => c.named && re.test(c.label.toLowerCase()) && !Object.values(guess).includes(c.i));
      if (hit) { guess[kind] = hit.i; sure[kind] = !(kind === 'paidBy' && n > 0); break; }
    }
  }
  // No usable headings: go by what the columns hold. Only columns before the first gap are
  // considered, because side tables often sit to the right of the list.
  const free = (c) => !Object.values(guess).includes(c.i);
  const main = cols.filter((c, k) => c.i === k);
  const pick = (score) => main.filter(free).map((c) => [score(c), c]).filter(([s]) => s > 0).sort((p, q) => q[0] - p[0])[0]?.[1].i ?? -1;
  if (guess.date < 0) guess.date = pick((c) => (c.dates > c.filled / 2 ? c.dates : 0));
  if (guess.amount < 0) guess.amount = pick((c) => (!c.counting && c.dates === 0 && c.numbers > c.filled / 2 ? c.numbers : 0));
  if (guess.desc < 0) guess.desc = pick((c) => (c.texts > c.filled / 2 ? c.textLen : 0));
  return { headerRow, cols: cols.map(({ i, label, sample }) => ({ i, label, sample })), guess, sure };
}

const MONEY_WORDS = {
  INR: /\binr\b|rupee|₹|\brs\b/, USD: /\busd\b|dollar|\$/, EUR: /\beur\b|euro|€/, GBP: /\bgbp\b|pound|£/, AED: /\baed\b|dirham/,
  SGD: /\bsgd\b/, THB: /\bthb\b|baht|\bthai\b/, VND: /\bvnd\b|dong/, KHR: /\bkhr\b|riel/, MYR: /\bmyr\b|ringgit/, IDR: /\bidr\b|rupiah/,
  LKR: /\blkr\b/, NPR: /\bnpr\b/, JPY: /\bjpy\b|\byen\b|¥/, AUD: /\baud\b/, CHF: /\bchf\b|franc/,
};
// The currency a heading names ("Amount (THB)", "Cost in dollars"), or null when it names none.
export function currencyHint(label) {
  const s = String(label).toLowerCase();
  const hits = Object.keys(MONEY_WORDS).filter((c) => MONEY_WORDS[c].test(s));
  return hits.length === 1 ? hits[0] : null;
}

// A cell -> integer minor units of `cur`, or null when it is not a clear positive amount.
export function amountOf(cell, cur) {
  const scale = Math.round(1 / fromMinor(1, cur));
  let minor = null;
  if (typeof cell === 'number') minor = Math.round(cell * scale * (1 + 1e-12));
  else if (typeof cell === 'string') {
    if (/^\s*[-(]/.test(cell)) return null; // a refund or a negative: not an expense
    const s = cell.replace(/[^\d.,]/g, '').replace(/^[.,]+|[.,]+$/g, '');
    minor = toMinor(s, cur);
    if (minor == null && /^\d+\.\d+$/.test(s)) minor = Math.round(Number(s) * scale * (1 + 1e-12));
  }
  return Number.isSafeInteger(minor) && minor > 0 && minor <= MAX_AMOUNT ? minor : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y, m, d) => {
  if (y < 100) y += 2000;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (!(y >= 2000 && y <= 2100) || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
  return t.toISOString().slice(0, 10);
};
// A cell -> 'YYYY-MM-DD', or '' when it is not a date. Typed dates are read day first (22/03/2025).
export function dateOf(cell) {
  if (cell && typeof cell === 'object') return /^\d{4}-\d{2}-\d{2}$/.test(cell.date || '') ? iso(+cell.date.slice(0, 4), +cell.date.slice(5, 7), +cell.date.slice(8, 10)) : '';
  if (typeof cell !== 'string') return '';
  const s = cell.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/, '$1');
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/);
  if (m) return +m[2] > 12 && +m[1] <= 12 ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-/ ]([a-z]{3})[a-z]*\.?,?[-/ ](\d{4}|\d{2})$/);
  if (m && MONTHS.includes(m[2])) return iso(+m[3], MONTHS.indexOf(m[2]) + 1, +m[1]);
  m = s.match(/^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/);
  if (m && MONTHS.includes(m[1])) return iso(+m[3], MONTHS.indexOf(m[1]) + 1, +m[2]);
  return '';
}

// The different values in one column below the header: [{ value, key, count }], most used first.
export function distinctValues(rows, table, col) {
  const seen = new Map();
  for (const row of rows.slice(table.headerRow + 1)) {
    const value = cellText(row[col]); const key = value.toLowerCase();
    if (!value) continue;
    if (!seen.has(key)) seen.set(key, { value: value.slice(0, 30), key, count: 0 });
    seen.get(key).count += 1;
  }
  return [...seen.values()].sort((p, q) => q.count - p.count);
}

// The one person a written name means, or null. "Sumeet" matches "Sumeet P" when nobody else does.
export function guessPerson(value, people) {
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  const exact = people.find((p) => p.name.toLowerCase() === v);
  if (exact) return exact.id;
  const near = people.filter((p) => { const n = p.name.toLowerCase(); return n.startsWith(v + ' ') || v.startsWith(n + ' '); });
  return near.length === 1 ? near[0].id : null;
}

const EVERYONE = /^(all|both|everyone|everybody|common|shared|group|equal|equally|each|split|all of us)$/;
export const nameTokens = (value) => String(value).split(/\s*(?:,|&|\+|\/|\band\b)\s*/i).map((t) => t.trim()).filter(Boolean);
// Who a "for whom" value means: { all: true } or { ids, unknown } (names that matched nobody).
export function guessSharers(value, people) {
  if (EVERYONE.test(String(value).trim().toLowerCase())) return { all: true, ids: people.map((p) => p.id), unknown: [] };
  const ids = []; const unknown = [];
  for (const t of nameTokens(value)) {
    const id = guessPerson(t, people);
    if (!id) unknown.push(t); else if (!ids.includes(id)) ids.push(id);
  }
  return { all: false, ids, unknown };
}

// What still stops a draft from being saved, in plain words; '' when it is ready.
export function draftProblem(d) {
  if (!d.desc.trim()) return 'Say what it was for.';
  if (!d.amount) return 'The amount is not clear.';
  if (!d.paidBy) return 'Pick who paid.';
  if (!d.sharers.length) return 'Pick who shares it.';
  return '';
}

// map: column numbers { desc, amount, date, paidBy, sharedBy } (-1 = no such column).
// a: { currency, today, payer: { key: id | 'skip' }, payerDefault, sharers: { key: [ids] }, sharersDefault: [ids] }.
// Returns { drafts, noAmount, leftOut, tooMany }.
export function buildDrafts(rows, table, map, a) {
  const drafts = []; let noAmount = 0; let leftOut = 0; let tooMany = false;
  let lastDate = '';
  for (let r = table.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const desc = cellText(row[map.desc]).slice(0, 80);
    const amount = amountOf(row[map.amount], a.currency);
    // A date written once for several rows applies to the rows under it.
    const ownDate = map.date >= 0 ? dateOf(row[map.date]) : '';
    if (ownDate) lastDate = ownDate;
    if (!amount) { if (desc) noAmount += 1; continue; }
    const who = map.paidBy >= 0 ? lower(row[map.paidBy]) : '';
    const paidBy = who ? (a.payer[who] ?? null) : a.payerDefault;
    if (paidBy === 'skip') { leftOut += 1; continue; }
    const whom = map.sharedBy >= 0 ? lower(row[map.sharedBy]) : '';
    const sharers = [...new Set(whom ? (a.sharers[whom] || []) : a.sharersDefault)];
    const total = /^(grand\s+|sub[\s-]?)?totals?\b/i.test(desc);
    if (drafts.length >= MAX_DRAFTS) { tooMany = true; break; }
    drafts.push({
      row: r + 1, desc, amount, date: ownDate || lastDate || a.today, paidBy: paidBy || null, sharers,
      include: !total, note: total ? 'Looks like a total, so it is not ticked.' : '',
    });
  }
  return { drafts, noAmount, leftOut, tooMany };
}

// Unticks drafts that match an expense already in the group (same day, amount and wording),
// so the same sheet can be brought in twice without doubling everything.
export function markDuplicates(drafts, items, currency) {
  const have = new Map();
  const key = (x) => `${x.date}|${x.amount}|${x.desc.trim().toLowerCase()}`;
  for (const x of items) if (x.type === 'expense' && !x.deleted && x.currency === currency) have.set(key(x), (have.get(key(x)) || 0) + 1);
  let n = 0;
  for (const d of drafts) {
    const left = have.get(key(d)) || 0;
    if (!left) continue;
    have.set(key(d), left - 1);
    if (d.include) { d.include = false; n += 1; }
    d.note = 'Already in the group, so it is not ticked.';
  }
  return n;
}
