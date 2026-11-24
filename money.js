// Pure money maths for Split App. No DOM, no network. All amounts are integers in the
// currency's minor unit (paise, cents); currencies like VND have no minor unit.

export const CURRENCIES = {
  INR: { dec: 2, sym: '₹', name: 'Indian rupee' },
  USD: { dec: 2, sym: '$', name: 'US dollar' },
  EUR: { dec: 2, sym: '€', name: 'Euro' },
  GBP: { dec: 2, sym: '£', name: 'British pound' },
  AED: { dec: 2, sym: 'AED ', name: 'UAE dirham' },
  SGD: { dec: 2, sym: 'S$', name: 'Singapore dollar' },
  THB: { dec: 2, sym: '฿', name: 'Thai baht' },
  VND: { dec: 0, sym: '₫', name: 'Vietnamese dong' },
  KHR: { dec: 0, sym: '៛', name: 'Cambodian riel' },
  MYR: { dec: 2, sym: 'RM ', name: 'Malaysian ringgit' },
  IDR: { dec: 0, sym: 'Rp ', name: 'Indonesian rupiah' },
  LKR: { dec: 2, sym: 'Rs ', name: 'Sri Lankan rupee' },
  NPR: { dec: 2, sym: 'NRs ', name: 'Nepalese rupee' },
  JPY: { dec: 0, sym: '¥', name: 'Japanese yen' },
  AUD: { dec: 2, sym: 'A$', name: 'Australian dollar' },
  CHF: { dec: 2, sym: 'CHF ', name: 'Swiss franc' },
};

const dec = (code) => (CURRENCIES[code] ? CURRENCIES[code].dec : 2);

const GROUPED = /^\d{1,3}([.,]\d{3})+$/;          // 1,250,000 or 1.250.000
const INDIAN = /^\d{1,2}(,\d{2})*,\d{3}$/;         // 1,25,000

// Typed amount -> integer minor units, or null when it is not a clear positive amount.
// People type "1,200.75", "1.200,75" (comma-decimal phones) and "50.000" (a Vietnamese price),
// so separators are read by position, and anything ambiguous is refused rather than guessed.
export function toMinor(text, code) {
  const s = String(text ?? '').replace(/\s/g, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const d = dec(code);
  let whole = s; let frac = '';
  if (/[.,]/.test(s)) {
    if (GROUPED.test(s) && (d === 0 || /^[^.]*$/.test(s) || (s.match(/\./g) || []).length > 1)) {
      whole = s.replace(/[.,]/g, '');               // separators are thousands marks only
    } else if (INDIAN.test(s)) {
      whole = s.replace(/,/g, '');
    } else if (d === 0) {
      return null;                                  // no decimals exist in this currency
    } else {
      const at = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
      const other = s[at] === '.' ? ',' : '.';
      whole = s.slice(0, at); frac = s.slice(at + 1);
      if (frac.length > d || /[.,]/.test(frac) || whole.includes(s[at])) return null;
      if (whole.includes(other) && !GROUPED.test(whole) && !INDIAN.test(whole)) return null;
      whole = whole.replace(/[.,]/g, '');
    }
  }
  const minor = Number(whole || '0') * 10 ** d + Number((frac + '0'.repeat(d)).slice(0, d) || '0');
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

// What to tell someone whose amount was refused.
export const amountHelp = (code) => (dec(code) === 0
  ? `Type the full amount with no decimals, like 50000. ${code} has no smaller unit.`
  : 'Type the amount like 1250.50, with at most 2 decimals.');

export const fromMinor = (minor, code) => minor / 10 ** dec(code);

export function formatMoney(minor, code) {
  const d = dec(code);
  const whole = minor % 10 ** d === 0;
  const n = new Intl.NumberFormat(code === 'INR' ? 'en-IN' : 'en-US', {
    minimumFractionDigits: whole ? 0 : d, maximumFractionDigits: d,
  }).format(Math.abs(minor) / 10 ** d);
  const sym = CURRENCIES[code] ? CURRENCIES[code].sym : ''; // never echo an unknown code into the page
  return (minor < 0 ? '-' : '') + sym + n;
}

// rate = units of `to` per 1 unit of `from`. Rounds once, to the nearest minor unit of `to`.
export function convert(amountMinor, from, to, rate) {
  if (from === to) return amountMinor;
  // The tiny nudge makes exact halves (8.075) round up even when floating point stores
  // them a hair low (8.074999…).
  return Math.round((amountMinor / 10 ** dec(from)) * rate * 10 ** dec(to) * (1 + 1e-12));
}

// Share an integer total by weight. Largest remainder; ties go to the earlier position.
export function allocate(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k][1]] += 1;
  return parts;
}

// What each member owes for one expense, in the group currency.
export function owedBy(expense, members, home) {
  const total = convert(expense.amount, expense.currency, home, expense.rate);
  const w = expense.split.weights || {};
  const parts = allocate(total, members.map((m) => Math.max(0, Number(w[m.id]) || 0)));
  return Object.fromEntries(members.map((m, i) => [m.id, parts[i]]));
}

// Returns a plain-language problem with the split, or null if it is fine.
// `total` is in the expense currency's minor units (exact amounts are too).
export function validateSplit(split, total) {
  const vals = Object.values(split.weights || {}).map(Number).filter((x) => x > 0);
  if (vals.length === 0) return 'Pick at least one person to share this.';
  const sum = vals.reduce((s, x) => s + x, 0);
  if (split.mode === 'exact' && sum !== total) {
    return `The exact amounts add up to ${sum < total ? 'less' : 'more'} than the total.`;
  }
  if (split.mode === 'percent' && Math.abs(sum - 100) > 1e-9) {
    return `The percentages add up to ${+sum.toFixed(2)}%, not 100%.`;
  }
  return null;
}

// Net position per member: positive = is owed money, negative = owes money.
export function balances(items, members, home) {
  const b = Object.fromEntries(members.map((m) => [m.id, 0]));
  for (const it of items) {
    if (it.deleted) continue;
    if (it.type === 'payment') {
      if (it.from in b) b[it.from] += it.amount;
      if (it.to in b) b[it.to] -= it.amount;
    } else {
      const owed = owedBy(it, members, home);
      if (it.paidBy in b) b[it.paidBy] += convert(it.amount, it.currency, home, it.rate);
      for (const id in owed) b[id] -= owed[id];
    }
  }
  return b;
}

// A short list of payments that clears everyone: first pair off people whose amounts match
// exactly, then repeatedly pay the largest creditor from the largest debtor. At most one
// payment fewer than the number of people; usually, but not always, the fewest possible.
export function settle(bal) {
  const ids = Object.keys(bal);
  const left = { ...bal };
  const plan = [];
  for (const d of ids) {
    if (!(left[d] < 0)) continue;
    const c = ids.find((i) => left[i] === -left[d]);
    if (c) { plan.push({ from: d, to: c, amount: left[c] }); left[d] = 0; left[c] = 0; }
  }
  for (;;) {
    const debtor = ids.filter((i) => left[i] < 0).sort((p, q) => left[p] - left[q])[0];
    const creditor = ids.filter((i) => left[i] > 0).sort((p, q) => left[q] - left[p])[0];
    if (!debtor || !creditor) return plan;
    const amount = Math.min(-left[debtor], left[creditor]);
    plan.push({ from: debtor, to: creditor, amount });
    left[debtor] += amount;
    left[creditor] -= amount;
  }
}

// What the trip cost each member: their share of every live expense. `personal` is the part
// from expenses that were theirs alone.
export function tripCosts(items, members, home) {
  const out = Object.fromEntries(members.map((m) => [m.id, { cost: 0, personal: 0 }]));
  for (const it of items) {
    if (it.deleted || it.type === 'payment') continue;
    const owed = owedBy(it, members, home);
    const sharers = Object.keys(owed).filter((id) => owed[id] > 0);
    for (const id of sharers) {
      out[id].cost += owed[id];
      if (sharers.length === 1) out[id].personal += owed[id];
    }
  }
  return out;
}

// The shared pool, held as a member of the group. `paidIn` is per person, net of anything the
// pool handed back to them; `left` is the cash that should still be in the pool.
export function poolStats(items, members, home, poolId) {
  const paidIn = Object.fromEntries(members.filter((m) => m.id !== poolId).map((m) => [m.id, 0]));
  let spent = 0;
  for (const it of items) {
    if (it.deleted) continue;
    if (it.type === 'payment') {
      if (it.to === poolId && it.from in paidIn) paidIn[it.from] += it.amount;
      if (it.from === poolId && it.to in paidIn) paidIn[it.to] -= it.amount;
    } else if (it.paidBy === poolId) spent += convert(it.amount, it.currency, home, it.rate);
  }
  const total = Object.values(paidIn).reduce((s, x) => s + x, 0);
  return { paidIn, total, spent, left: total - spent };
}
