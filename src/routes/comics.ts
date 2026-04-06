import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { paginate, now } from '../db/helpers';

const comics = new Hono<AppContext>();

comics.use('*', requireAuth);

// GET /comics/facets — valores distintos para filtros
comics.get('/facets', async (c) => {
  const [authors, publishers, priceRange] = await Promise.all([
    c.env.DB.prepare(
      "SELECT DISTINCT json_extract(value, '$.name') as name FROM comics, json_each(comics.authors) WHERE json_extract(value, '$.name') IS NOT NULL ORDER BY name"
    ).all<{ name: string }>(),
    c.env.DB.prepare(
      "SELECT DISTINCT publisher FROM comics WHERE publisher IS NOT NULL AND publisher != '' ORDER BY publisher"
    ).all<{ publisher: string }>(),
    c.env.DB.prepare(
      "SELECT MIN(price) as min_price, MAX(price) as max_price FROM comics WHERE price IS NOT NULL"
    ).first<{ min_price: number; max_price: number }>(),
  ]);

  // Fallback: also include writer/artist for comics without structured authors
  const legacyAuthors = await c.env.DB.prepare(
    "SELECT DISTINCT writer as name FROM comics WHERE writer IS NOT NULL AND writer != '' AND authors IS NULL UNION SELECT DISTINCT artist as name FROM comics WHERE artist IS NOT NULL AND artist != '' AND authors IS NULL ORDER BY name"
  ).all<{ name: string }>();

  const allAuthors = [...new Set([
    ...authors.results.map(r => r.name),
    ...legacyAuthors.results.map(r => r.name),
  ])].sort();

  return c.json({
    authors: allAuthors,
    publishers: publishers.results.map(r => r.publisher),
    price: { min: priceRange?.min_price ?? 0, max: priceRange?.max_price ?? 100 },
  });
});

// GET /comics — listado paginado con filtros
comics.get('/', async (c) => {
  const page  = Math.max(1, Number(c.req.query('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 42)));
  const search      = c.req.query('search') ?? '';
  const read_status = c.req.query('read_status') ?? '';
  const owned       = c.req.query('owned') ?? '';
  const sort        = c.req.query('sort') ?? 'created_at';
  const order       = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';
  const author      = c.req.query('author') ?? '';
  const publisher   = c.req.query('publisher') ?? '';
  const price_min   = c.req.query('price_min') ?? '';
  const price_max   = c.req.query('price_max') ?? '';
  const rating_min  = c.req.query('rating_min') ?? '';

  const allowedSort = ['created_at', 'updated_at', 'title', 'series', 'number', 'publish_date', 'price'];
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
  if (author) {
    conditions.push("(EXISTS (SELECT 1 FROM json_each(authors) WHERE json_extract(value, '$.name') = ?) OR writer = ? OR artist = ?)");
    params.push(author, author, author);
  }
  if (publisher) { conditions.push('publisher = ?'); params.push(publisher); }
  const no_price = c.req.query('no_price') ?? '';
  if (no_price === 'true') {
    conditions.push('(price IS NULL OR price = 0)');
  } else {
    if (price_min) { conditions.push('price >= ?'); params.push(Number(price_min)); }
    if (price_max) { conditions.push('price <= ?'); params.push(Number(price_max)); }
  }
  if (rating_min) { conditions.push('rating >= ?'); params.push(Number(rating_min)); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await paginate<Record<string, unknown>>(
    c.env.DB, 'comics', where, params, page, limit, `${safeSort} ${order}`
  );

  // Convertir owned (0/1) a boolean y parsear authors JSON
  result.data = result.data.map(r => ({
    ...r,
    owned: r['owned'] === 1,
    authors: r['authors'] ? JSON.parse(r['authors'] as string) : null,
  }));

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
  return c.json({
    ...comic,
    owned: comic['owned'] === 1,
    authors: comic['authors'] ? JSON.parse(comic['authors'] as string) : null,
  });
});

// POST /comics
comics.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const str = (key: string) => { const v = body[key]; return (v === '' || v == null) ? null : String(v); };
  const num = (key: string) => { const v = body[key]; return (v == null || v === '') ? null : Number(v); };
  const json = (key: string) => { const v = body[key]; return Array.isArray(v) ? JSON.stringify(v) : (typeof v === 'string' ? v : null); };

  // Upsert: buscar duplicado por ISBN o por título+colección
  const isbn = str('isbn');
  const title = str('title');
  const collectionId = num('collection_id');
  let existing: { id: number } | null = null;

  if (isbn) {
    existing = await c.env.DB
      .prepare('SELECT id FROM comics WHERE isbn = ?').bind(isbn).first<{ id: number }>();
  }
  if (!existing && title && collectionId) {
    existing = await c.env.DB
      .prepare('SELECT id FROM comics WHERE title = ? AND collection_id = ?')
      .bind(title, collectionId).first<{ id: number }>();
  }

  if (existing) {
    // Actualizar datos del cómic existente (preservar estado personal)
    await c.env.DB.prepare(`
      UPDATE comics SET
        title=?, series=?, number=COALESCE(?,number), volume=COALESCE(?,volume),
        isbn=COALESCE(?,isbn), ean=COALESCE(?,ean),
        writer=COALESCE(?,writer), artist=COALESCE(?,artist),
        colorist=COALESCE(?,colorist), cover_artist=COALESCE(?,cover_artist),
        publisher=COALESCE(?,publisher), collection=COALESCE(?,collection),
        publish_date=COALESCE(?,publish_date), original_publisher=COALESCE(?,original_publisher),
        original_title=COALESCE(?,original_title),
        synopsis=COALESCE(?,synopsis), genre=COALESCE(?,genre), format=COALESCE(?,format),
        pages=COALESCE(?,pages), language=COALESCE(?,language),
        cover_url=COALESCE(?,cover_url),
        collection_id=COALESCE(?,collection_id),
        price=COALESCE(?,price), binding=COALESCE(?,binding),
        authors=COALESCE(?,authors),
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
      num('collection_id'), num('price'), str('binding'),
      json('authors'),
      now(), existing.id
    ).run();

    const comic = await c.env.DB
      .prepare('SELECT * FROM comics WHERE id = ?').bind(existing.id).first<Record<string, unknown>>();
    return c.json({ ...comic, owned: comic?.['owned'] === 1, authors: comic?.['authors'] ? JSON.parse(comic['authors'] as string) : null });
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO comics (
      title, series, number, volume, isbn, ean,
      writer, artist, colorist, cover_artist,
      publisher, collection, publish_date, original_publisher, original_title,
      synopsis, genre, format, pages, language, cover_url,
      read_status, owned, rating, notes,
      collection_id, price, binding, authors,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    num('collection_id'), num('price'), str('binding'), json('authors'),
    now(), now()
  ).run();

  const comic = await c.env.DB
    .prepare('SELECT * FROM comics WHERE id = ?')
    .bind(result.meta.last_row_id)
    .first<Record<string, unknown>>();

  return c.json({ ...comic, owned: comic?.['owned'] === 1, authors: comic?.['authors'] ? JSON.parse(comic['authors'] as string) : null }, 201);
});

// PUT /comics/:id
comics.put('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Record<string, unknown>>();
  const str = (key: string) => { const v = body[key]; return (v === '' || v == null) ? null : String(v); };
  const num = (key: string) => { const v = body[key]; return (v == null || v === '') ? null : Number(v); };
  const json = (key: string) => { const v = body[key]; return Array.isArray(v) ? JSON.stringify(v) : (typeof v === 'string' ? v : null); };

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
      collection_id=?, price=?, binding=?, authors=?,
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
    num('collection_id'), num('price'), str('binding'), json('authors'),
    now(), id
  ).run();

  const comic = await c.env.DB
    .prepare('SELECT * FROM comics WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ ...comic, owned: comic?.['owned'] === 1, authors: comic?.['authors'] ? JSON.parse(comic['authors'] as string) : null });
});

// PATCH /comics/batch — bulk update fields (e.g. read_status)
comics.patch('/batch', async (c) => {
  const body = await c.req.json<{ ids: number[]; read_status?: string }>();
  const ids = body.ids;
  if (!ids?.length) return c.json({ error: 'ids requeridos' }, 400);

  if (body.read_status) {
    const placeholders = ids.map(() => '?').join(',');
    await c.env.DB.prepare(
      `UPDATE comics SET read_status = ?, updated_at = ? WHERE id IN (${placeholders})`
    ).bind(body.read_status, now(), ...ids).run();
  }

  return c.json({ ok: true, updated: ids.length });
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
