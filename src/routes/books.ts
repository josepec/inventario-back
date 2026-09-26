import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { D1Database } from '@cloudflare/workers-types';
import { paginate, now, foldedLike, foldSql, foldText } from '../db/helpers';

const books = new Hono<AppContext>();

books.use('*', requireAuth);

/**
 * "Canción de Hielo y Fuego" y "Canción de hielo y fuego" partían la saga en dos.
 * Si ya hay otra saga que sólo cambia en mayúsculas, tildes o espacios, se usa su
 * nombre. `exclude` descarta filas (el propio libro, o la saga que se renombra)
 * para que un cambio de mayúsculas intencionado no se revierta contra sí mismo.
 */
async function canonicalSaga(
  db: D1Database, raw: unknown, exclude: { id?: number; saga?: string } = {}
): Promise<string | null> {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  const hit = await db.prepare(
    `SELECT saga FROM books WHERE ${foldSql('saga')} = ? AND id IS NOT ? AND saga IS NOT ? LIMIT 1`
  ).bind(foldText(name), exclude.id ?? null, exclude.saga ?? null).first<{ saga: string }>();
  return hit?.saga ?? name;
}

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

// GET /books/sagas — saga browse list
books.get('/sagas', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT saga,
           COUNT(*) as total,
           SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) as read_count,
           MIN(saga_number) as min_num, MAX(saga_number) as max_num,
           GROUP_CONCAT(cover_url, '|||') as covers
    FROM books
    WHERE saga IS NOT NULL AND saga != ''
    GROUP BY saga
    ORDER BY saga ASC
  `).all<{ saga: string; total: number; read_count: number; min_num: number | null; max_num: number | null; covers: string | null }>();

  const sagas = rows.results.map(r => ({
    name: r.saga,
    total: r.total,
    read: r.read_count,
    covers: (r.covers || '').split('|||').filter(Boolean).slice(0, 4),
  }));

  return c.json(sagas);
});

// PATCH /books/sagas — renombrar una saga en todos sus libros. Si el nombre nuevo
// ya existe se fusionan; sin nombre nuevo se quita la saga (y su número) de los libros.
books.patch('/sagas', async (c) => {
  const body = await c.req.json<{ from?: string; to?: string | null }>();
  if (!body.from) return c.json({ error: 'Falta la saga' }, 400);

  const to = await canonicalSaga(c.env.DB, body.to, { saga: body.from });
  const res = to
    ? await c.env.DB.prepare('UPDATE books SET saga = ?, updated_at = ? WHERE saga = ?')
        .bind(to, now(), body.from).run()
    : await c.env.DB.prepare('UPDATE books SET saga = NULL, saga_number = NULL, updated_at = ? WHERE saga = ?')
        .bind(now(), body.from).run();
  return c.json({ ok: true, saga: to, updated: res.meta.changes });
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
    const text = foldedLike(['title', 'author', 'publisher', 'saga'], search);
    conditions.push(`(${text.sql} OR isbn LIKE ? OR isbn13 LIKE ? OR ean LIKE ?)`);
    const like = `%${search}%`;
    params.push(...text.params, like, like, like);
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
  body['saga'] = await canonicalSaga(c.env.DB, body['saga']);

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
  body['saga'] = await canonicalSaga(c.env.DB, body['saga'], { id });

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
