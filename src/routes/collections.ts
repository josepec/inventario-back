import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { paginate, now } from '../db/helpers';

const collections = new Hono<AppContext>();

collections.use('*', requireAuth);

// GET /collections — listado paginado
collections.get('/', async (c) => {
  const page  = Math.max(1, Number(c.req.query('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20)));
  const search = c.req.query('search') ?? '';

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    conditions.push('(title LIKE ? OR publisher LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await paginate<Record<string, unknown>>(
    c.env.DB, 'collections', where, params, page, limit, 'title ASC'
  );

  return c.json(result);
});

// GET /collections/:id — detalle con sus comics
collections.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const col = await c.env.DB
    .prepare('SELECT * FROM collections WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();

  if (!col) return c.json({ error: 'No encontrada' }, 404);

  const comics = await c.env.DB
    .prepare('SELECT id, title, number, cover_url, read_status, owned FROM comics WHERE collection_id = ? ORDER BY number ASC')
    .bind(id)
    .all<Record<string, unknown>>();

  return c.json({ ...col, comics: comics.results.map(r => ({ ...r, owned: r['owned'] === 1 })) });
});

// POST /collections
collections.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const str = (key: string) => { const v = body[key]; return (v === '' || v == null) ? null : String(v); };
  const num = (key: string) => { const v = body[key]; return (v == null || v === '') ? null : Number(v); };

  // Upsert por whakoom_id si existe
  const whakoomId = str('whakoom_id');
  if (whakoomId) {
    const existing = await c.env.DB
      .prepare('SELECT id FROM collections WHERE whakoom_id = ?')
      .bind(whakoomId)
      .first<{ id: number }>();

    if (existing) {
      return c.json({ id: existing.id, whakoom_id: whakoomId, existed: true });
    }
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO collections (whakoom_id, whakoom_type, title, publisher, cover_url, total_issues, description, url, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(
    whakoomId,
    str('whakoom_type'),
    str('title') ?? 'Sin título',
    str('publisher'),
    str('cover_url'),
    num('total_issues'),
    str('description'),
    str('url'),
    now(), now()
  ).run();

  const col = await c.env.DB
    .prepare('SELECT * FROM collections WHERE id = ?')
    .bind(result.meta.last_row_id)
    .first();

  return c.json(col, 201);
});

// PUT /collections/:id
collections.put('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Record<string, unknown>>();
  const str = (key: string) => { const v = body[key]; return (v === '' || v == null) ? null : String(v); };
  const num = (key: string) => { const v = body[key]; return (v == null || v === '') ? null : Number(v); };

  const existing = await c.env.DB
    .prepare('SELECT id FROM collections WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'No encontrada' }, 404);

  await c.env.DB.prepare(`
    UPDATE collections SET
      title=?, publisher=?, cover_url=?, total_issues=?, description=?, url=?, updated_at=?
    WHERE id=?
  `).bind(
    str('title') ?? 'Sin título',
    str('publisher'),
    str('cover_url'),
    num('total_issues'),
    str('description'),
    str('url'),
    now(), id
  ).run();

  const col = await c.env.DB
    .prepare('SELECT * FROM collections WHERE id = ?').bind(id).first();
  return c.json(col);
});

// DELETE /collections/:id
collections.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await c.env.DB
    .prepare('SELECT id FROM collections WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'No encontrada' }, 404);

  // Desvincular comics
  await c.env.DB.prepare('UPDATE comics SET collection_id = NULL WHERE collection_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

export { collections };
