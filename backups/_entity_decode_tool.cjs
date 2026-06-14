// Genera SQL de backfill (decode de entidades HTML) + rollback, en dry-run.
// Fuente: dumps JSON volcados con `wrangler d1 execute --json SELECT *`.
// Uso: node _entity_decode_tool.cjs <STAMP>
const fs = require('fs');
const path = require('path');
const STAMP = process.argv[2];
if (!STAMP) { console.error('falta STAMP'); process.exit(1); }
const dir = __dirname;

// --- mismo decodeEntities que back/src/routes/whakoom.ts ---
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
const ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|nbsp|amp|quot|apos|lt|gt|hellip|mdash|ndash);/;

function decodeDeep(v) {
  if (typeof v === 'string') return decodeEntities(v);
  if (Array.isArray(v)) return v.map(decodeDeep);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = decodeDeep(v[k]); return o; }
  return v;
}
function decodeJsonCol(s) {
  if (s == null || s === '') return s;
  try { return JSON.stringify(decodeDeep(JSON.parse(s))); }
  catch { return decodeEntities(s); } // no era JSON válido: tratar como texto
}
const sq = (v) => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

// tabla -> { pk, text:[...], json:[...] }
const TABLES = {
  comics: {
    pk: 'id',
    text: ['title','series','writer','artist','colorist','cover_artist','publisher','collection','original_publisher','original_title','synopsis','genre','subtitle'],
    json: ['authors'],
  },
  collections: {
    pk: 'id',
    text: ['title','publisher','description','format','status','edition_details','synopsis'],
    json: ['authors','issues'],
  },
  wanted_comics: {
    pk: 'whakoom_comic_id',
    text: ['title','series','number','publisher'],
    json: [],
  },
};

const upStmts = [], rbStmts = [];
const report = [];
let samples = [];

for (const [table, cfg] of Object.entries(TABLES)) {
  const dump = require(path.join(dir, `dump-${table}-${STAMP}.json`));
  const rows = dump[0].results;
  const colCount = {};
  let rowsChanged = 0;

  for (const row of rows) {
    const sets = [], rbSets = [];
    const cols = [...cfg.text.map(c => [c, false]), ...cfg.json.map(c => [c, true])];
    for (const [col, isJson] of cols) {
      const old = row[col];
      if (old == null || old === '' || !ENTITY_RE.test(String(old))) continue;
      const dec = isJson ? decodeJsonCol(old) : decodeEntities(old);
      if (dec === old) continue;
      sets.push(`${col} = ${sq(dec)}`);
      rbSets.push(`${col} = ${sq(old)}`);
      colCount[col] = (colCount[col] || 0) + 1;
      if (samples.length < 15) samples.push({ table, col, id: row[cfg.pk], from: String(old).slice(0,70), to: String(dec).slice(0,70) });
    }
    if (sets.length) {
      rowsChanged++;
      upStmts.push(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${cfg.pk} = ${sq(row[cfg.pk])};`);
      rbStmts.push(`UPDATE ${table} SET ${rbSets.join(', ')} WHERE ${cfg.pk} = ${sq(row[cfg.pk])};`);
    }
  }
  report.push({ table, total: rows.length, rowsChanged, byCol: colCount });
}

const upFile = path.join(dir, `entity-decode-${STAMP}.sql`);
const rbFile = path.join(dir, `entity-decode-rollback-${STAMP}.sql`);
fs.writeFileSync(upFile, upStmts.join('\n') + '\n');
fs.writeFileSync(rbFile, rbStmts.join('\n') + '\n');

console.log('=== DRY RUN: resumen ===');
for (const r of report) {
  console.log(`\n[${r.table}] ${r.total} filas → ${r.rowsChanged} a actualizar`);
  for (const [c, n] of Object.entries(r.byCol)) console.log(`   ${c}: ${n} celdas`);
}
console.log('\n=== muestras (max 15) ===');
for (const s of samples) console.log(`[${s.table}.${s.col} #${s.id}]\n   antes: ${s.from}\n   desp.: ${s.to}`);
console.log(`\nSQL escrito: ${path.basename(upFile)} (${upStmts.length} UPDATEs)`);
console.log(`Rollback:    ${path.basename(rbFile)}`);
