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

// "1,200.75" -> 120075 (USD). Returns null for anything that is not a positive amount.
export function toMinor(text, code) {
  const s = String(text ?? '').replace(/[,\s]/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const d = dec(code);
  const [whole, frac = ''] = s.split('.');
  let minor = Number(whole || '0') * 10 ** d + Number((frac + '0'.repeat(d)).slice(0, d) || '0');
  if (frac.length > d && Number(frac[d]) >= 5) minor += 1; // round half up on the extra digit
  return Number.isSafeInteger(minor) ? minor : null;
}

export const fromMinor = (minor, code) => minor / 10 ** dec(code);

export function formatMoney(minor, code) {
  const d = dec(code);
  const whole = minor % 10 ** d === 0;
  const n = new Intl.NumberFormat(code === 'INR' ? 'en-IN' : 'en-US', {
    minimumFractionDigits: whole ? 0 : d, maximumFractionDigits: d,
  }).format(Math.abs(minor) / 10 ** d);
  const sym = CURRENCIES[code] ? CURRENCIES[code].sym : code + ' ';
  return (minor < 0 ? '-' : '') + sym + n;
}

// rate = units of `to` per 1 unit of `from`. Rounds once, to the nearest minor unit of `to`.
export function convert(amountMinor, from, to, rate) {
  if (from === to) return amountMinor;
  return Math.round((amountMinor / 10 ** dec(from)) * rate * 10 ** dec(to));
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

// Fewest payments: repeatedly pay the largest creditor from the largest debtor.
export function settle(bal) {
  const ids = Object.keys(bal);
  const left = { ...bal };
  const plan = [];
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
