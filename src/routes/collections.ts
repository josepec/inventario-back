import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { paginate, now } from '../db/helpers';

const collections = new Hono<AppContext>();

collections.use('*', requireAuth);

function parseCol(r: Record<string, unknown>) {
  return {
    ...r,
    tracking: r['tracking'] === 1,
    authors: r['authors'] ? JSON.parse(r['authors'] as string) : [],
    issues: r['issues'] ? JSON.parse(r['issues'] as string) : [],
  };
}

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

  result.data = result.data.map(parseCol);
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

  return c.json({ ...parseCol(col), comics: comics.results.map(r => ({ ...r, owned: r['owned'] === 1 })) });
});

// POST /collections
collections.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const str = (key: string) => { const v = body[key]; return (v === '' || v == null) ? null : String(v); };
  const num = (key: string) => { const v = body[key]; return (v == null || v === '') ? null : Number(v); };
  const json = (key: string) => { const v = body[key]; return v == null ? null : JSON.stringify(v); };

  // Upsert por whakoom_id si existe
  const whakoomId = str('whakoom_id');
  if (whakoomId) {
    const existing = await c.env.DB
      .prepare('SELECT id FROM collections WHERE whakoom_id = ?')
      .bind(whakoomId)
      .first<{ id: number }>();

    if (existing) {
      // Siempre actualizar con los datos más recientes de Whakoom
      await c.env.DB.prepare(`
        UPDATE collections SET
          title=COALESCE(?,title), publisher=COALESCE(?,publisher),
          cover_url=COALESCE(?,cover_url), total_issues=COALESCE(?,total_issues),
          description=?, url=COALESCE(?,url),
          format=?, status=?,
          edition_details=?, synopsis=?,
          authors=?, issues=?,
          updated_at=?
        WHERE id=?
      `).bind(
        str('title'), str('publisher'), str('cover_url'), num('total_issues'),
        str('description'), str('url'), str('format'), str('status'),
        str('edition_details'), str('synopsis'), json('authors'), json('issues'),
        now(), existing.id
      ).run();
      return c.json({ id: existing.id, whakoom_id: whakoomId, existed: true });
    }
  }

  // Sin whakoom_id: evitar duplicados por título
  if (!whakoomId) {
    const title = str('title');
    if (title) {
      const existing = await c.env.DB
        .prepare('SELECT id FROM collections WHERE title = ? AND whakoom_id IS NULL')
        .bind(title)
        .first<{ id: number }>();
      if (existing) {
        // Actualizar con datos nuevos (puede venir con más info que la primera vez)
        await c.env.DB.prepare(`
          UPDATE collections SET
            whakoom_id=COALESCE(?,whakoom_id), whakoom_type=COALESCE(?,whakoom_type),
            publisher=COALESCE(?,publisher), cover_url=COALESCE(?,cover_url),
            total_issues=COALESCE(?,total_issues),
            description=COALESCE(?,description), url=COALESCE(?,url),
            format=COALESCE(?,format), status=COALESCE(?,status),
            edition_details=COALESCE(?,edition_details), synopsis=COALESCE(?,synopsis),
            authors=COALESCE(?,authors), issues=COALESCE(?,issues),
            updated_at=?
          WHERE id=?
        `).bind(
          str('whakoom_id'), str('whakoom_type'),
          str('publisher'), str('cover_url'), num('total_issues'),
          str('description'), str('url'), str('format'), str('status'),
          str('edition_details'), str('synopsis'), json('authors'), json('issues'),
          now(), existing.id
        ).run();
        return c.json({ id: existing.id, existed: true });
      }
    }
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO collections (
      whakoom_id, whakoom_type, title, publisher, cover_url, total_issues,
      description, url, format, status, edition_details, synopsis,
      authors, issues, whakoom_synced_at, tracking, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
  `).bind(
    whakoomId,
    str('whakoom_type'),
    str('title') ?? 'Sin título',
    str('publisher'),
    str('cover_url'),
    num('total_issues'),
    str('description'),
    str('url'),
    str('format'),
    str('status'),
    str('edition_details'),
    str('synopsis'),
    json('authors'),
    json('issues'),
    str('whakoom_synced_at'),
    now(), now()
  ).run();

  const col = await c.env.DB
    .prepare('SELECT * FROM collections WHERE id = ?')
    .bind(result.meta.last_row_id)
    .first<Record<string, unknown>>();

  return c.json(parseCol(col!), 201);
});

// PUT /collections/:id
collections.put('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Record<string, unknown>>();
  const str = (key: string) => { const v = body[key]; return (v === '' || v == null) ? null : String(v); };
  const num = (key: string) => { const v = body[key]; return (v == null || v === '') ? null : Number(v); };
  const json = (key: string) => { const v = body[key]; return v == null ? null : JSON.stringify(v); };

  const existing = await c.env.DB
    .prepare('SELECT id FROM collections WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'No encontrada' }, 404);

  const tracking = body['tracking'] != null ? (body['tracking'] ? 1 : 0) : null;

  await c.env.DB.prepare(`
    UPDATE collections SET
      title=?, publisher=?, cover_url=?, total_issues=?, description=?, url=?,
      format=COALESCE(?,format), status=COALESCE(?,status),
      edition_details=COALESCE(?,edition_details), synopsis=COALESCE(?,synopsis),
      authors=COALESCE(?,authors), issues=COALESCE(?,issues),
      whakoom_synced_at=COALESCE(?,whakoom_synced_at),
      tracking=COALESCE(?,tracking), updated_at=?
    WHERE id=?
  `).bind(
    str('title') ?? 'Sin título',
    str('publisher'),
    str('cover_url'),
    num('total_issues'),
    str('description'),
    str('url'),
    str('format'),
    str('status'),
    str('edition_details'),
    str('synopsis'),
    json('authors'),
    json('issues'),
    str('whakoom_synced_at'),
    tracking,
    now(), id
  ).run();

  const col = await c.env.DB
    .prepare('SELECT * FROM collections WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json(parseCol(col!));
});

// DELETE /collections/:id — cascade: elimina también los comics asociados
collections.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await c.env.DB
    .prepare('SELECT id FROM collections WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'No encontrada' }, 404);

  // Borrar comics asociados y luego la colección
  await c.env.DB.prepare('DELETE FROM comics WHERE collection_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

export { collections };
