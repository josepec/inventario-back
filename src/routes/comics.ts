import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { paginate, now } from '../db/helpers';
import { fetchNewTitles, enrichWithOwnership, flattenNewTitles, fetchOwnedWhakoomIds } from './whakoom';

const comics = new Hono<AppContext>();

comics.use('*', requireAuth);

// GET /comics/upcoming-mine — novedades de este mes que me interesan.
// Combina dos fuentes y EXCLUYE lo que ya tengo en la coleccion:
//  1) wanted_comics.release_month = mes actual (wishlist explicita)
//  2) Scrape de Whakoom /newtitles/YYYYMM filtrando a issues de colecciones
//     con tracking=1 (cruzando whakoom_comic_id contra collections.issues JSON).
comics.get('/upcoming-mine', async (c) => {
  const now_ = new Date();
  const year = now_.getUTCFullYear();
  const mon = String(now_.getUTCMonth() + 1).padStart(2, '0');
  const yyyymm = `${year}${mon}`;
  const month = `${year}-${mon}`;

  // Pre-fetch: IDs ya en la coleccion (se calcula cruzando collections.issues con comics.number)
  const ownedSet = await fetchOwnedWhakoomIds(c.env.DB);

  // 1) Wanted list de este mes (excluyendo los ya comprados)
  interface WantedRow {
    whakoom_comic_id: string;
    title: string;
    series: string | null;
    number: string | null;
    cover_url: string | null;
    publisher: string | null;
    collection_whakoom_id: string | null;
    release_month: string | null;
  }
  const wantedRows = await c.env.DB.prepare(
    `SELECT whakoom_comic_id, title, series, number, cover_url, publisher,
            collection_whakoom_id, release_month
       FROM wanted_comics
      WHERE release_month = ?
      ORDER BY series, number`
  ).bind(month).all<WantedRow>();

  const wantedItems = wantedRows.results
    .filter(r => !ownedSet.has(r.whakoom_comic_id))
    .map(r => ({
      ...r,
      source: 'wanted' as const,
      release_week: null as string | null,
      release_week_start: null as string | null,
      owned: false,
      wanted: true,
    }));

  // 2) Novedades de Whakoom cruzadas con colecciones trackeadas
  let trackedItems: Array<Record<string, unknown> & { source: 'tracked'; owned: boolean; wanted: boolean }> = [];
  try {
    const groups = await fetchNewTitles(c.env, yyyymm);
    if (groups && groups.length > 0) {
      const trackedIssueIds = await c.env.DB.prepare(
        `SELECT DISTINCT json_extract(issue.value, '$.id') AS id, collections.id AS collection_id, collections.tracking AS tracking_mode
           FROM collections, json_each(collections.issues) AS issue
          WHERE collections.tracking >= 1
            AND collections.issues IS NOT NULL`
      ).all<{ id: string; collection_id: number; tracking_mode: number }>();
      const trackedSet = new Set(trackedIssueIds.results.map(r => r.id));
      const trackedCollMap = new Map(trackedIssueIds.results.map(r => [r.id, r.collection_id]));
      const trackedModeMap = new Map(trackedIssueIds.results.map(r => [r.id, r.tracking_mode]));

      const flat = flattenNewTitles(groups);
      const filtered = flat.filter(it =>
        trackedSet.has(it.whakoom_comic_id) && !ownedSet.has(it.whakoom_comic_id)
      );
      const enriched = await enrichWithOwnership(c.env.DB, filtered);
      trackedItems = enriched.map(it => ({
        ...it,
        source: 'tracked' as const,
        tracking_mode: trackedModeMap.get(String(it.whakoom_comic_id)) ?? 1,
        local_collection_id: trackedCollMap.get(String(it.whakoom_comic_id)) ?? (it as unknown as { local_collection_id?: number | null }).local_collection_id ?? null,
      }));
    }
  } catch {
    // Si el scraper falla, devolvemos al menos la wanted list
  }

  // Dedupe: wanted gana si aparece en ambas fuentes
  const wantedIds = new Set(wantedItems.map(i => String(i.whakoom_comic_id)));
  const merged = [
    ...wantedItems,
    ...trackedItems.filter(i => !wantedIds.has(String(i.whakoom_comic_id))),
  ];

  return c.json({ month, items: merged });
});

// GET /comics/atrasados — colecciones con tracking=1 que tienen issues publicadas sin comprar
comics.get('/atrasados', async (c) => {
  interface AtrasadoRow {
    collection_id: number;
    collection_title: string;
    collection_cover: string | null;
    collection_whakoom_id: string | null;
    issue_number: number;
    issue_title: string;
    issue_cover: string | null;
    issue_release_date: string | null;
  }

  const rows = await c.env.DB.prepare(`
    SELECT
      co.id                                                    AS collection_id,
      co.title                                                 AS collection_title,
      co.cover_url                                             AS collection_cover,
      co.whakoom_id                                            AS collection_whakoom_id,
      CAST(json_extract(issue.value, '$.number') AS INTEGER)   AS issue_number,
      COALESCE(json_extract(issue.value, '$.title'), '')       AS issue_title,
      json_extract(issue.value, '$.cover')                     AS issue_cover,
      json_extract(issue.value, '$.releaseDate')               AS issue_release_date
    FROM collections co, json_each(co.issues) AS issue
    WHERE co.tracking = 1
      AND co.issues IS NOT NULL
      AND json_extract(issue.value, '$.published') = 1
      AND NOT EXISTS (
        SELECT 1 FROM comics c
        WHERE c.collection_id = co.id
          AND CAST(c.number AS INTEGER) = CAST(json_extract(issue.value, '$.number') AS INTEGER)
      )
    ORDER BY co.title, CAST(json_extract(issue.value, '$.number') AS INTEGER)
  `).all<AtrasadoRow>();

  // Agrupar por coleccion
  const map = new Map<number, {
    collection_id: number;
    collection_title: string;
    collection_cover: string | null;
    collection_whakoom_id: string | null;
    missing_issues: { number: number; title: string; cover: string | null; release_date: string | null }[];
  }>();

  for (const row of rows.results) {
    if (!map.has(row.collection_id)) {
      map.set(row.collection_id, {
        collection_id: row.collection_id,
        collection_title: row.collection_title,
        collection_cover: row.collection_cover,
        collection_whakoom_id: row.collection_whakoom_id,
        missing_issues: [],
      });
    }
    map.get(row.collection_id)!.missing_issues.push({
      number: row.issue_number,
      title: row.issue_title,
      cover: row.issue_cover,
      release_date: row.issue_release_date,
    });
  }

  // Segunda fuente: wanted_comics de meses pasados aún sin comprar
  const now_ = new Date();
  const currentMonth = `${now_.getUTCFullYear()}-${String(now_.getUTCMonth() + 1).padStart(2, '0')}`;

  interface WantedPastRow {
    whakoom_comic_id: string;
    title: string;
    series: string | null;
    number: string | null;
    cover_url: string | null;
    publisher: string | null;
    release_month: string | null;
  }

  const wantedPast = await c.env.DB.prepare(`
    SELECT whakoom_comic_id, title, series, number, cover_url, publisher, release_month
      FROM wanted_comics
     WHERE release_month IS NOT NULL
       AND release_month < ?
     ORDER BY release_month DESC, title
  `).bind(currentMonth).all<WantedPastRow>();

  return c.json({ data: Array.from(map.values()), wanted_past: wantedPast.results });
});

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

  // Upsert: buscar duplicado
  // Cuando viene con (collection_id + number) — flujo Whakoom — matchea SOLO por esa
  // pareja. No cae a ISBN porque Whakoom a veces devuelve el mismo ISBN para varios
  // números (ej. Rurouni Kenshin #4/#5) y sobreescribiría un cómic distinto.
  // Sin collection_id+number (alta manual / escaneo ISBN), matchea por ISBN o título.
  const isbn = str('isbn');
  const title = str('title');
  const collectionId = num('collection_id');
  const number = num('number');
  let existing: { id: number } | null = null;

  if (collectionId && number != null) {
    existing = await c.env.DB
      .prepare('SELECT id FROM comics WHERE collection_id = ? AND number = ?')
      .bind(collectionId, number).first<{ id: number }>();
  } else {
    if (isbn) {
      existing = await c.env.DB
        .prepare('SELECT id FROM comics WHERE isbn = ?').bind(isbn).first<{ id: number }>();
    }
    if (!existing && title && collectionId) {
      existing = await c.env.DB
        .prepare('SELECT id FROM comics WHERE title = ? AND collection_id = ?')
        .bind(title, collectionId).first<{ id: number }>();
    }
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
        whakoom_id=COALESCE(?,whakoom_id),
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
      str('whakoom_id'),
      now(), existing.id
    ).run();

    const whakoomId = str('whakoom_id');
    if (whakoomId) {
      await c.env.DB.prepare('DELETE FROM wanted_comics WHERE whakoom_comic_id = ?')
        .bind(whakoomId).run();
    }

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
      collection_id, price, binding, authors, whakoom_id,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    str('whakoom_id'),
    now(), now()
  ).run();

  const whakoomId = str('whakoom_id');
  if (whakoomId) {
    await c.env.DB.prepare('DELETE FROM wanted_comics WHERE whakoom_comic_id = ?')
      .bind(whakoomId).run();
  }

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
