import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { paginate, now } from '../db/helpers';

const books = new Hono<AppContext>();

books.use('*', requireAuth);

// GET /books/facets
books.get('/facets', async (c) => {
  const [authors, publishers, genres, sagas, priceRange] = await Promise.all([
    c.env.DB.prepare(
      "SELECT DISTINCT author FROM books WHERE author IS NOT NULL AND author != '' ORDER BY author"
    ).all<{ author: string }>(),
    c.env.DB.prepare(
      "SELECT DISTINCT publisher FROM books WHERE publisher IS NOT NULL AND publisher != '' ORDER BY publisher"
    ).all<{ publisher: string }>(),
    c.env.DB.prepare(
      "SELECT DISTINCT genre FROM books WHERE genre IS NOT NULL AND genre != '' ORDER BY genre"
    ).all<{ genre: string }>(),
    c.env.DB.prepare(
      "SELECT DISTINCT saga FROM books WHERE saga IS NOT NULL AND saga != '' ORDER BY saga"
    ).all<{ saga: string }>(),
    c.env.DB.prepare(
      "SELECT MIN(price) as min_price, MAX(price) as max_price FROM books WHERE price IS NOT NULL"
    ).first<{ min_price: number; max_price: number }>(),
  ]);

  return c.json({
    authors: authors.results.map(r => r.author),
    publishers: publishers.results.map(r => r.publisher),
    genres: genres.results.map(r => r.genre),
    sagas: sagas.results.map(r => r.saga),
    price: { min: priceRange?.min_price ?? 0, max: priceRange?.max_price ?? 100 },
  });
});

// GET /books
books.get('/', async (c) => {
  const page  = Math.max(1, Number(c.req.query('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 42)));
  const search      = c.req.query('search') ?? '';
  const read_status = c.req.query('read_status') ?? '';
  const owned       = c.req.query('owned') ?? '';
  const sort        = c.req.query('sort') ?? 'created_at';
  const order       = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';
  const author      = c.req.query('author') ?? '';
  const publisher   = c.req.query('publisher') ?? '';
  const genre       = c.req.query('genre') ?? '';
  const saga        = c.req.query('saga') ?? '';
  const price_min   = c.req.query('price_min') ?? '';
  const price_max   = c.req.query('price_max') ?? '';
  const rating_min  = c.req.query('rating_min') ?? '';

  const allowedSort = ['created_at', 'updated_at', 'title', 'author', 'publish_date', 'saga', 'saga_number', 'price', 'pages'];
  const safeSort = allowedSort.includes(sort) ? sort : 'created_at';

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    conditions.push('(title LIKE ? OR author LIKE ? OR publisher LIKE ? OR isbn LIKE ? OR isbn13 LIKE ? OR ean LIKE ? OR saga LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like);
  }
  if (read_status) { conditions.push('read_status = ?'); params.push(read_status); }
  if (owned !== '') { conditions.push('owned = ?'); params.push(owned === 'true' ? 1 : 0); }
  if (author) { conditions.push('author = ?'); params.push(author); }
  if (publisher) { conditions.push('publisher = ?'); params.push(publisher); }
  if (genre) { conditions.push('genre = ?'); params.push(genre); }
  if (saga) { conditions.push('saga = ?'); params.push(saga); }

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
    c.env.DB, 'books', where, params, page, limit, `${safeSort} ${order}`
  );

  result.data = result.data.map(r => ({ ...r, owned: r['owned'] === 1 }));
  return c.json(result);
});

// GET /books/:id
books.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const book = await c.env.DB
    .prepare('SELECT * FROM books WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!book) return c.json({ error: 'No encontrado' }, 404);
  return c.json({ ...book, owned: book['owned'] === 1 });
});

// POST /books
books.post('/', async (c) => {
  const body = await c.req.json<Record<string, unknown>>();

  const result = await c.env.DB.prepare(`
    INSERT INTO books (
      title, isbn, isbn13, ean,
      author, translator, illustrator,
      publisher, publish_date, edition, original_title, original_language,
      synopsis, genre, subgenre, pages, language, saga, saga_number,
      price, binding,
      cover_url, read_status, owned, rating, notes,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    body['title'] ?? null,
    body['isbn'] ?? null, body['isbn13'] ?? null, body['ean'] ?? null,
    body['author'] ?? null, body['translator'] ?? null, body['illustrator'] ?? null,
    body['publisher'] ?? null, body['publish_date'] ?? null, body['edition'] ?? null,
    body['original_title'] ?? null, body['original_language'] ?? null,
    body['synopsis'] ?? null, body['genre'] ?? null, body['subgenre'] ?? null,
    body['pages'] ?? null, body['language'] ?? null,
    body['saga'] ?? null, body['saga_number'] ?? null,
    body['price'] ?? null, body['binding'] ?? null,
    body['cover_url'] ?? null,
    body['read_status'] ?? 'unread',
    body['owned'] ? 1 : 0,
    body['rating'] ?? null, body['notes'] ?? null,
    now(), now()
  ).run();

  const book = await c.env.DB
    .prepare('SELECT * FROM books WHERE id = ?')
    .bind(result.meta.last_row_id)
    .first<Record<string, unknown>>();
  return c.json({ ...book, owned: book?.['owned'] === 1 }, 201);
});

// PUT /books/:id
books.put('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Record<string, unknown>>();

  const existing = await c.env.DB
    .prepare('SELECT id FROM books WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'No encontrado' }, 404);

  await c.env.DB.prepare(`
    UPDATE books SET
      title=?, isbn=?, isbn13=?, ean=?,
      author=?, translator=?, illustrator=?,
      publisher=?, publish_date=?, edition=?, original_title=?, original_language=?,
      synopsis=?, genre=?, subgenre=?, pages=?, language=?, saga=?, saga_number=?,
      price=?, binding=?,
      cover_url=?, read_status=?, owned=?, rating=?, notes=?,
      updated_at=?
    WHERE id=?
  `).bind(
    body['title'] ?? null,
    body['isbn'] ?? null, body['isbn13'] ?? null, body['ean'] ?? null,
    body['author'] ?? null, body['translator'] ?? null, body['illustrator'] ?? null,
    body['publisher'] ?? null, body['publish_date'] ?? null, body['edition'] ?? null,
    body['original_title'] ?? null, body['original_language'] ?? null,
    body['synopsis'] ?? null, body['genre'] ?? null, body['subgenre'] ?? null,
    body['pages'] ?? null, body['language'] ?? null,
    body['saga'] ?? null, body['saga_number'] ?? null,
    body['price'] ?? null, body['binding'] ?? null,
    body['cover_url'] ?? null,
    body['read_status'] ?? 'unread',
    body['owned'] ? 1 : 0,
    body['rating'] ?? null, body['notes'] ?? null,
    now(), id
  ).run();

  const book = await c.env.DB
    .prepare('SELECT * FROM books WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ ...book, owned: book?.['owned'] === 1 });
});

// PATCH /books/batch — bulk update fields (e.g. read_status)
books.patch('/batch', async (c) => {
  const body = await c.req.json<{ ids: number[]; read_status?: string }>();
  const ids = body.ids;
  if (!ids?.length) return c.json({ error: 'ids requeridos' }, 400);

  if (body.read_status) {
    const placeholders = ids.map(() => '?').join(',');
    await c.env.DB.prepare(
      `UPDATE books SET read_status = ?, updated_at = ? WHERE id IN (${placeholders})`
    ).bind(body.read_status, now(), ...ids).run();
  }

  return c.json({ ok: true, updated: ids.length });
});

// DELETE /books/:id
books.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await c.env.DB
    .prepare('SELECT id FROM books WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'No encontrado' }, 404);

  await c.env.DB.prepare('DELETE FROM books WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

export { books };
