// Aplica el backfill de decode por lotes vía `wrangler d1 execute --command`
// (la API de D1 funciona; el endpoint de --file/import por R2 está bloqueado).
// spawnSync sin shell => sin problemas de comillas/saltos de línea.
const { spawnSync } = require('child_process');
const path = require('path');

const STAMP = process.argv[2];
const APPLY = process.argv.includes('--apply'); // sin esto: solo cuenta lotes
if (!STAMP) { console.error('falta STAMP'); process.exit(1); }

const SQL = require('fs').readFileSync(path.join(__dirname, `entity-decode-${STAMP}.sql`), 'utf8');
// El generador escribe una sentencia por bloque terminada en ";\n".
// Las sinopsis llevan saltos internos, así que NO partimos por línea:
// partimos por ";\n" que solo aparece como fin de sentencia (los ; internos
// van dentro de literales sin salto inmediato).
const stmts = SQL.split(/;\n/).map(s => s.trim()).filter(Boolean).map(s => s.endsWith(';') ? s : s + ';');

// Lotes acotados por tamaño para no superar el límite de línea de comandos.
const MAX = 16000;
const batches = [];
let cur = '';
for (const s of stmts) {
  if (cur && (cur.length + s.length + 1) > MAX) { batches.push(cur); cur = ''; }
  cur += (cur ? '\n' : '') + s;
}
if (cur) batches.push(cur);

console.log(`sentencias: ${stmts.length} | lotes: ${batches.length} | apply=${APPLY}`);
if (!APPLY) { console.log('(dry: no se ejecuta nada)'); process.exit(0); }

const wrangler = path.join(__dirname, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
let okBatches = 0, totalChanges = 0;
for (let i = 0; i < batches.length; i++) {
  const r = spawnSync(process.execPath, [
    wrangler, 'd1', 'execute', 'inventario', '--remote', '--json',
    '--command', batches[i],
  ], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 26 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 || /ERROR|fetch failed/i.test(out)) {
    console.error(`\nLOTE ${i + 1}/${batches.length} FALLÓ (status ${r.status}):`);
    console.error(out.slice(-600));
    console.error('Detén y revisa; rollback disponible.');
    process.exit(1);
  }
  // contar changes del JSON
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
    for (const res of j) totalChanges += (res.meta && res.meta.changes) || 0;
  } catch {}
  okBatches++;
  process.stdout.write(`\rlotes OK: ${okBatches}/${batches.length}  changes acumulados: ${totalChanges}   `);
}
console.log(`\nHECHO. lotes OK: ${okBatches}/${batches.length}, changes totales: ${totalChanges}`);
