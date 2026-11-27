// Reads a spreadsheet file (.xlsx or .csv) into plain rows. Pure: no DOM, no network, no
// library. An .xlsx file is a zip of XML files; the browser's own unzipper does the heavy part.
// A cell comes out as text, a number, or { date: 'YYYY-MM-DD' }; an empty cell is ''.

const MAX_XML = 30e6;      // unzipped size of any one part, in bytes
export const MAX_ROWS = 3000;
const MAX_COLS = 60;

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

// The list of files inside a zip: name -> { method, size, start, packed }.
function zipEntries(b) {
  let end = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 66000; i--) {
    if (u32(b, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not-zip');
  const out = new Map();
  let p = u32(b, end + 16);
  for (let n = u16(b, end + 10); n > 0 && p + 46 <= b.length && u32(b, p) === 0x02014b50; n--) {
    const nameLen = u16(b, p + 28);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { method: u16(b, p + 10), packed: u32(b, p + 20), size: u32(b, p + 24), local: u32(b, p + 42) });
    p += 46 + nameLen + u16(b, p + 30) + u16(b, p + 32);
  }
  return out;
}

async function unzipText(b, e) {
  if (!e) return '';
  if (e.size > MAX_XML) throw new Error('too-big');
  const start = e.local + 30 + u16(b, e.local + 26) + u16(b, e.local + 28);
  const data = b.subarray(start, start + e.packed);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error('not-zip');
  if (typeof DecompressionStream === 'undefined') throw new Error('old-browser');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks = []; let total = 0;
  for (const reader = stream.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_XML) throw new Error('too-big');
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, k) => {
  if (k[0] !== '#') return ENT[k] ?? m;
  const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}).replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
const attr = (tag, name) => (tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`)) || [])[1];
// The text inside one <si> or <is> block: every <t> run, without the phonetic guides.
const runs = (xml) => [...xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

// Excel stores a date as a day count and marks it as a date only through the cell's number format.
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const TIME_ONLY = new Set([18, 19, 20, 21, 45, 46, 47]);
function dateStyles(xml) {
  const custom = new Map();
  for (const m of xml.matchAll(/<numFmt\s[^>]*>/g)) {
    const code = unxml(attr(m[0], 'formatCode') || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    custom.set(Number(attr(m[0], 'numFmtId')), /[dy]/i.test(code) || /m{3,}/i.test(code));
  }
  const xfs = (xml.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [''])[0];
  return [...xfs.matchAll(/<xf\s[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') || 0);
    return custom.has(id) ? custom.get(id) : DATE_IDS.has(id) && !TIME_ONLY.has(id);
  });
}
export function serialToDate(n, date1904) {
  if (!(n >= 1 && n < 2958466)) return null;
  const t = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + Math.floor(n) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); }
  return n - 1;
};

function sheetRows(xml, strings, isDate, date1904) {
  const rows = [];
  let ri = -1;
  for (const rm of xml.matchAll(/<row(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attr(rm[1] || '', 'r'));
    ri = r > 0 ? r - 1 : ri + 1;
    if (ri >= MAX_ROWS) break;
    const row = [];
    let ci = -1;
    for (const cm of (rm[2] || '').matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1] || ''; const inner = cm[2] || '';
      const ref = attr(a, 'r');
      ci = ref ? colIndex(ref) : ci + 1;
      if (ci < 0 || ci >= MAX_COLS) continue;
      const t = attr(a, 't');
      const raw = (inner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/) || [])[1];
      let v = '';
      if (t === 'inlineStr') v = runs(inner);
      else if (raw == null) v = '';
      else if (t === 's') v = strings[Number(raw)] ?? '';
      else if (t === 'str') v = unxml(raw);
      else if (t === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'e') v = '';
      else if (t === 'd') v = /^\d{4}-\d{2}-\d{2}/.test(raw) ? { date: raw.slice(0, 10) } : unxml(raw);
      else {
        const n = Number(raw);
        if (!Number.isFinite(n)) v = '';
        else if (isDate[Number(attr(a, 's') || 0)] && serialToDate(n, date1904)) v = { date: serialToDate(n, date1904) };
        else v = n;
      }
      if (typeof v === 'string') v = v.replace(/\s+/g, ' ').trim().slice(0, 300);
      if (v !== '') row[ci] = v;
    }
    if (row.length) rows[ri] = row;
  }
  return squareUp(rows);
}

// Fills the gaps so every row has the same number of cells, and drops trailing empty rows.
function squareUp(rows) {
  const width = Math.min(MAX_COLS, rows.reduce((w, r) => Math.max(w, r ? r.length : 0), 0));
  const out = [];
  for (let i = 0; i < rows.length; i++) out.push(Array.from({ length: width }, (_, c) => rows[i]?.[c] ?? ''));
  while (out.length && out[out.length - 1].every((c) => c === '')) out.pop();
  return out;
}

async function readXlsx(b) {
  const zip = zipEntries(b);
  const text = (name) => unzipText(b, zip.get(name));
  const book = await text('xl/workbook.xml');
  if (!book) throw new Error('not-xlsx');
  const rels = new Map([...(await text('xl/_rels/workbook.xml.rels')).matchAll(/<Relationship\s[^>]*>/g)]
    .map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target') || '']));
  const strings = [...(await text('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => runs(m[1] || ''));
  const isDate = dateStyles(await text('xl/styles.xml'));
  const date1904 = /<workbookPr[^>]*date1904="(1|true)"/.test(book);
  const sheets = [];
  for (const m of book.matchAll(/<sheet\s[^>]*>/g)) {
    if (attr(m[0], 'state') === 'hidden' || attr(m[0], 'state') === 'veryHidden') continue;
    const target = rels.get(attr(m[0], 'r:id')) || '';
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    if (!/^xl\/worksheets\//.test(path)) continue; // chart sheets and the like
    const rows = sheetRows(await text(path), strings, isDate, date1904);
    if (rows.length) sheets.push({ name: unxml(attr(m[0], 'name') || 'Sheet').slice(0, 40), rows });
  }
  return sheets;
}

// CSV as spreadsheets write it: quoted cells, doubled quotes, commas, semicolons or tabs.
export function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const head = s.slice(0, 5000).split(/\r?\n/)[0] || '';
  const sep = [',', ';', '\t'].map((d) => [head.split(d).length, d]).sort((p, q) => q[0] - p[0])[0][1];
  const rows = []; let row = []; let cell = ''; let quoted = false; let wasQuoted = false;
  const endCell = () => {
    let v = cell.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!wasQuoted && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    if (row.length < MAX_COLS) row.push(v);
    cell = ''; wasQuoted = false;
  };
  for (let i = 0; i < s.length && rows.length < MAX_ROWS; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { quoted = true; wasQuoted = true; cell = '';
    } else if (ch === sep) endCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      endCell(); rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { endCell(); rows.push(row); }
  return squareUp(rows);
}

// bytes: Uint8Array of the picked file. Returns [{ name, rows }], one per sheet that has rows.
// Throws Error('old-xls' | 'not-sheet' | 'too-big' | 'old-browser') for files it cannot read.
export async function readSheets(bytes, fileName = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > 4 && u32(b, 0) === 0x04034b50) {
    try { return await readXlsx(b); } catch (e) { throw new Error(['too-big', 'old-browser'].includes(e.message) ? e.message : 'not-sheet'); }
  }
  if (b.length > 8 && u32(b, 0) === 0xe011cfd0) throw new Error('old-xls');
  if (b.subarray(0, 4000).includes(0)) throw new Error('not-sheet');
  const rows = parseCsv(new TextDecoder().decode(b));
  return rows.length ? [{ name: fileName.replace(/\.[^.]*$/, '').slice(0, 40) || 'Sheet', rows }] : [];
}
