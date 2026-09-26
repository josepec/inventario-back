// Limpieza de sagas (26/09/2026): colecciones editoriales fuera, número separado,
// "(Saga N)" fuera del título. Además el libro 66, que tenía los datos de
// "El mundo de hielo y fuego" con el ISBN de "Choque de reyes".
// Genera el SQL de aplicación y el de rollback a partir de las copias JSON.
const fs = require('fs');
const orig = JSON.parse(fs.readFileSync(__dirname + '/books-sagas-20260926.json', 'utf8'));
orig.push(JSON.parse(fs.readFileSync(__dirname + '/book-66-20260926.json', 'utf8')));
const byId = Object.fromEntries(orig.map(r => [r.id, r]));
const clear = { saga: null, saga_number: null };
const changes = {
  123: clear, 99: clear, 90: clear, 122: clear, 63: clear, 64: clear, 137: clear, 136: clear, 92: clear,
  73: { saga: 'El Señor de los Anillos', saga_number: 1 },
  70: { saga: 'Canción de hielo y fuego', saga_number: 5 },
  67: { saga: 'Canción de hielo y fuego', saga_number: 4 },
  59: { saga: 'Crónica del asesino de reyes', saga_number: 1, title: 'El nombre del viento' },
  85: { saga: 'Dune', saga_number: 1 },
  114: { saga: 'Resident Evil', saga_number: 0 },
  30: { title: 'El Juicio Final de Carl' },
  29: { title: 'El Libro de Cocina Del Anarquista de la Mazmorra' },
  111: { title: 'Entrevista con el vampiro' },
  33: { title: 'Las recetas perdidas de la taberna Kamogawa' },
  28: { title: 'Así es como se mata' },
  66: {
    title: 'Choque de reyes', author: 'George R.R. Martin', publisher: 'Gigamesh',
    publish_date: '2012', pages: 928, saga: 'Canción de hielo y fuego', saga_number: 2,
  },
};
const lit = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const apply = [], rollback = [];
for (const [id, ch] of Object.entries(changes)) {
  const o = byId[id];
  if (!o) throw new Error('falta ' + id);
  apply.push(`UPDATE books SET ${Object.entries(ch).map(([k, v]) => `${k}=${lit(v)}`).join(', ')} WHERE id=${id}`);
  rollback.push(`UPDATE books SET ${Object.keys(ch).map(k => `${k}=${lit(o[k])}`).join(', ')} WHERE id=${id}`);
}
fs.writeFileSync(__dirname + '/saga-cleanup-20260926.sql', apply.join(';\n') + ';\n');
fs.writeFileSync(__dirname + '/saga-cleanup-rollback-20260926.sql', rollback.join(';\n') + ';\n');
process.stdout.write(apply.join('; '));
