import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { fetchNewTitles, flattenNewTitles } from './whakoom';

const wanted = new Hono<AppContext>();

wanted.use('*', requireAuth);

interface WantedRow {
  whakoom_comic_id: string;
  title: string;
  series: string | null;
  number: string | null;
  cover_url: string | null;
  publisher: string | null;
  collection_whakoom_id: string | null;
  comics_url_path: string | null;
  release_month: string | null;
  added_at: string;
}

// GET /wanted — lista completa, mas recientes primero
wanted.get('/', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT * FROM wanted_comics ORDER BY added_at DESC')
    .all<WantedRow>();
  return c.json({ data: rows.results });
});

// POST /wanted — upsert por whakoom_comic_id
wanted.post('/', async (c) => {
  const body = await c.req.json<Partial<WantedRow>>();
  const id = body.whakoom_comic_id?.trim();
  if (!id) return c.json({ error: 'whakoom_comic_id requerido' }, 400);
  if (!body.title?.trim()) return c.json({ error: 'title requerido' }, 400);

  await c.env.DB.prepare(`
    INSERT INTO wanted_comics (
      whakoom_comic_id, title, series, number, cover_url,
      publisher, collection_whakoom_id, comics_url_path, release_month
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(whakoom_comic_id) DO UPDATE SET
      title = excluded.title,
      series = COALESCE(excluded.series, wanted_comics.series),
      number = COALESCE(excluded.number, wanted_comics.number),
      cover_url = COALESCE(excluded.cover_url, wanted_comics.cover_url),
      publisher = COALESCE(excluded.publisher, wanted_comics.publisher),
      collection_whakoom_id = COALESCE(excluded.collection_whakoom_id, wanted_comics.collection_whakoom_id),
      comics_url_path = COALESCE(excluded.comics_url_path, wanted_comics.comics_url_path),
      release_month = COALESCE(excluded.release_month, wanted_comics.release_month)
  `).bind(
    id,
    body.title.trim(),
    body.series ?? null,
    body.number ?? null,
    body.cover_url ?? null,
    body.publisher ?? null,
    body.collection_whakoom_id ?? null,
    body.comics_url_path ?? null,
    body.release_month ?? null,
  ).run();

  const row = await c.env.DB
    .prepare('SELECT * FROM wanted_comics WHERE whakoom_comic_id = ?')
    .bind(id)
    .first<WantedRow>();
  return c.json(row, 201);
});

// POST /wanted/repair-url-paths — backfill comics_url_path para entradas sin URL.
// Por cada release_month distinto, descarga la pagina de novedades de Whakoom
// y actualiza los registros que coincidan por whakoom_comic_id.
wanted.post('/repair-url-paths', async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT whakoom_comic_id, release_month FROM wanted_comics
              WHERE comics_url_path IS NULL AND release_month IS NOT NULL`)
    .all<{ whakoom_comic_id: string; release_month: string }>();

  if (rows.results.length === 0) return c.json({ fixed: 0, message: 'Nada que reparar' });

  // Agrupar por mes para minimizar fetches
  const byMonth = new Map<string, string[]>();
  for (const r of rows.results) {
    const yyyymm = r.release_month.replace('-', ''); // "2026-03" → "202603"
    if (!byMonth.has(yyyymm)) byMonth.set(yyyymm, []);
    byMonth.get(yyyymm)!.push(r.whakoom_comic_id);
  }

  let fixed = 0;
  const log: string[] = [];

  for (const [yyyymm, ids] of byMonth.entries()) {
    const groups = await fetchNewTitles(c.env, yyyymm);
    if (!groups) { log.push(`${yyyymm}: fetch fallido`); continue; }

    const flat = flattenNewTitles(groups);
    const urlByComicId = new Map(
      flat
        .filter(i => i.comics_url_path)
        .map(i => [i.whakoom_comic_id, i.comics_url_path!])
    );

    for (const id of ids) {
      const urlPath = urlByComicId.get(id);
      if (!urlPath) { log.push(`${yyyymm}/${id}: no encontrado en newtitles`); continue; }
      await c.env.DB
        .prepare('UPDATE wanted_comics SET comics_url_path = ? WHERE whakoom_comic_id = ?')
        .bind(urlPath, id).run();
      fixed++;
    }
  }

  return c.json({ fixed, total: rows.results.length, log });
});

// DELETE /wanted/:whakoom_comic_id
wanted.delete('/:whakoom_comic_id', async (c) => {
  const id = c.req.param('whakoom_comic_id');
  await c.env.DB
    .prepare('DELETE FROM wanted_comics WHERE whakoom_comic_id = ?')
    .bind(id).run();
  return c.json({ ok: true });
});

export { wanted };
