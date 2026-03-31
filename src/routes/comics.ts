import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { paginate, now } from '../db/helpers';

const comics = new Hono<AppContext>();

comics.use('*', requireAuth);

// GET /comics — listado paginado con filtros
comics.get('/', async (c) => {
  const page  = Math.max(1, Number(c.req.query('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 42)));
  const search      = c.req.query('search') ?? '';
  const read_status = c.req.query('read_status') ?? '';
  const owned       = c.req.query('owned') ?? '';
  const sort        = c.req.query('sort') ?? 'created_at';
  const order       = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';

  const allowedSort = ['created_at', 'updated_at', 'title', 'series', 'number', 'publish_date'];
  const safeSort = allowedSort.includes(sort) ? sort : 'created_at';

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    conditions.push('(title LIKE ? OR series LIKE ? OR writer LIKE ? OR artist LIKE ? OR isbn LIKE ? OR ean LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like);
  }
  if (read_status) { conditions.push('read_status = ?'); params.push(read_status); }
  if (owned !== '') { conditions.push('owned = ?'); params.push(owned === 'true' ? 1 : 0); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await paginate<Record<string, unknown>>(
    c.env.DB, 'comics', where, params, page, limit, `${safeSort} ${order}`
  );

  // Convertir owned (0/1) a boolean en la respuesta
  result.data = result.data.map(r => ({ ...r, owned: r['owned'] === 1 }));

  return c.json(result);
});

// GET /comics/:id
comics.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const comic = await c.env.DB
    .prepare(`
      SELECT c.*, col.title as collection_name, col.whakoom_id as collection_whakoom_id
      FROM comics c
      LEFT JOIN collections col ON c.collection_id = col.id
      WHERE c.id = ?
    `)
    .bind(id)
    .first<Record<string, unknown>>();

  if (!comic) return c.json({ error: 'No encontrado' }, 404);
  return c.json({ ...comic, owned: comic['owned'] === 1 });
});

// POST /comics
comics.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const str = (key: string) => { const v = body[key]; return (v === '' || v == null) ? null : String(v); };
  const num = (key: string) => { const v = body[key]; return (v == null || v === '') ? null : Number(v); };

  const result = await c.env.DB.prepare(`
    INSERT INTO comics (
      title, series, number, volume, isbn, ean,
      writer, artist, colorist, cover_artist,
      publisher, collection, publish_date, original_publisher, original_title,
      synopsis, genre, format, pages, language, cover_url,
      read_status, owned, rating, notes,
      collection_id, price, binding,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    str('title'),
    str('series'), num('number'), num('volume'),
    str('isbn'), str('ean'),
    str('writer'), str('artist'), str('colorist'), str('cover_artist'),
    str('publisher'), str('collection'), str('publish_date'),
    str('original_publisher'), str('original_title'),
    str('synopsis'), str('genre'), str('format'),
    num('pages'), str('language'), str('cover_url'),
    str('read_status') ?? 'unread',
    body['owned'] ? 1 : 0,
    num('rating'), str('notes'),
    num('collection_id'), num('price'), str('binding'),
    now(), now()
  ).run();

  const comic = await c.env.DB
    .prepare('SELECT * FROM comics WHERE id = ?')
    .bind(result.meta.last_row_id)
    .first<Record<string, unknown>>();

  return c.json({ ...comic, owned: comic?.['owned'] === 1 }, 201);
});

// PUT /comics/:id
comics.put('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Record<string, unknown>>();
  const str = (key: string) => { const v = body[key]; return (v === '' || v == null) ? null : String(v); };
  const num = (key: string) => { const v = body[key]; return (v == null || v === '') ? null : Number(v); };

  const existing = await c.env.DB
    .prepare('SELECT id FROM comics WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'No encontrado' }, 404);

  await c.env.DB.prepare(`
    UPDATE comics SET
      title=?, series=?, number=?, volume=?, isbn=?, ean=?,
      writer=?, artist=?, colorist=?, cover_artist=?,
      publisher=?, collection=?, publish_date=?, original_publisher=?, original_title=?,
      synopsis=?, genre=?, format=?, pages=?, language=?, cover_url=?,
      read_status=?, owned=?, rating=?, notes=?,
      collection_id=?, price=?, binding=?,
      updated_at=?
    WHERE id=?
  `).bind(
    str('title'),
    str('series'), num('number'), num('volume'),
    str('isbn'), str('ean'),
    str('writer'), str('artist'), str('colorist'), str('cover_artist'),
    str('publisher'), str('collection'), str('publish_date'),
    str('original_publisher'), str('original_title'),
    str('synopsis'), str('genre'), str('format'),
    num('pages'), str('language'), str('cover_url'),
    str('read_status') ?? 'unread',
    body['owned'] ? 1 : 0,
    num('rating'), str('notes'),
    num('collection_id'), num('price'), str('binding'),
    now(), id
  ).run();

  const comic = await c.env.DB
    .prepare('SELECT * FROM comics WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ ...comic, owned: comic?.['owned'] === 1 });
});

// DELETE /comics/:id
comics.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await c.env.DB
    .prepare('SELECT id FROM comics WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'No encontrado' }, 404);

  await c.env.DB.prepare('DELETE FROM comics WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

export { comics };
