import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { paginate, now } from '../db/helpers';

const books = new Hono<AppContext>();

books.use('*', requireAuth);

// GET /books
books.get('/', async (c) => {
  const page  = Math.max(1, Number(c.req.query('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 42)));
  const search      = c.req.query('search') ?? '';
  const read_status = c.req.query('read_status') ?? '';
  const owned       = c.req.query('owned') ?? '';
  const sort        = c.req.query('sort') ?? 'created_at';
  const order       = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';

  const allowedSort = ['created_at', 'updated_at', 'title', 'author', 'publish_date', 'saga'];
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

  const rating_min = c.req.query('rating_min') ?? '';
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
      cover_url, read_status, owned, rating, notes,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    body['title'] ?? null,
    body['isbn'] ?? null, body['isbn13'] ?? null, body['ean'] ?? null,
    body['author'] ?? null, body['translator'] ?? null, body['illustrator'] ?? null,
    body['publisher'] ?? null, body['publish_date'] ?? null, body['edition'] ?? null,
    body['original_title'] ?? null, body['original_language'] ?? null,
    body['synopsis'] ?? null, body['genre'] ?? null, body['subgenre'] ?? null,
    body['pages'] ?? null, body['language'] ?? null,
    body['saga'] ?? null, body['saga_number'] ?? null,
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
