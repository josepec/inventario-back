import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';

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
      publisher, collection_whakoom_id, release_month
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(whakoom_comic_id) DO UPDATE SET
      title = excluded.title,
      series = COALESCE(excluded.series, wanted_comics.series),
      number = COALESCE(excluded.number, wanted_comics.number),
      cover_url = COALESCE(excluded.cover_url, wanted_comics.cover_url),
      publisher = COALESCE(excluded.publisher, wanted_comics.publisher),
      collection_whakoom_id = COALESCE(excluded.collection_whakoom_id, wanted_comics.collection_whakoom_id),
      release_month = COALESCE(excluded.release_month, wanted_comics.release_month)
  `).bind(
    id,
    body.title.trim(),
    body.series ?? null,
    body.number ?? null,
    body.cover_url ?? null,
    body.publisher ?? null,
    body.collection_whakoom_id ?? null,
    body.release_month ?? null,
  ).run();

  const row = await c.env.DB
    .prepare('SELECT * FROM wanted_comics WHERE whakoom_comic_id = ?')
    .bind(id)
    .first<WantedRow>();
  return c.json(row, 201);
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
