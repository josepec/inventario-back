import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { now, foldedLike } from '../db/helpers';
import { searchGames, gameDetail, PS_PLATFORMS } from '../services/igdb';
import { cleanEan, lookupGameBarcode } from '../services/game-barcode';

// Videojuegos: un juego (ficha de IGDB) con sus copias (plataforma + formato +
// edición). Ver migrations/0017_games.sql.
const games = new Hono<AppContext>();

games.use('*', requireAuth);

const PLATFORMS = Object.keys(PS_PLATFORMS);
const FORMATS = ['physical', 'digital'];
const STATUSES = ['pending', 'playing', 'completed', 'abandoned'];

type Body = Record<string, unknown>;
const str = (b: Body, k: string) => { const v = b[k]; return v === '' || v == null ? null : String(v).trim() || null; };
const num = (b: Body, k: string) => { const v = b[k]; if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const rating = (b: Body) => { const n = num(b, 'rating'); return n != null && n >= 1 && n <= 5 ? Math.round(n) : null; };

/** Las plataformas de un juego salen de sus copias, en el orden PS1 → PSP. */
const sortPlatforms = (csv: unknown) =>
  String(csv ?? '').split(',').filter(Boolean)
    .sort((a, b) => PLATFORMS.indexOf(a) - PLATFORMS.indexOf(b));

function shapeGame(r: Record<string, unknown>) {
  return {
    ...r,
    platforms: sortPlatforms(r['platforms']),
    formats: String(r['formats'] ?? '').split(',').filter(Boolean),
    copies_count: Number(r['copies_count'] ?? 0),
  };
}

function shapeCopy(r: Record<string, unknown>) {
  return { ...r, is_free: r['is_free'] === 1 };
}

const AGGREGATES = `
  (SELECT GROUP_CONCAT(DISTINCT platform) FROM game_copies WHERE game_id = g.id) AS platforms,
  (SELECT GROUP_CONCAT(DISTINCT format)   FROM game_copies WHERE game_id = g.id) AS formats,
  (SELECT COUNT(*)                        FROM game_copies WHERE game_id = g.id) AS copies_count`;

function copyValues(b: Body): { error: string } | { values: unknown[] } {
  const platform = str(b, 'platform');
  const format = str(b, 'format');
  if (!platform || !PLATFORMS.includes(platform)) return { error: `Plataforma no válida: ${platform ?? '(vacía)'}` };
  if (!format || !FORMATS.includes(format)) return { error: `Formato no válido: ${format ?? '(vacío)'}` };
  const source = str(b, 'source');
  return {
    values: [
      platform, format, str(b, 'edition'), str(b, 'ean'), str(b, 'psn_title_id'), str(b, 'psn_product_id'),
      num(b, 'price'), str(b, 'store'), str(b, 'acquired_at'), b['is_free'] ? 1 : 0,
      source && ['manual', 'scanner', 'psn'].includes(source) ? source : 'manual', str(b, 'notes'),
    ],
  };
}

const COPY_COLUMNS = 'platform, format, edition, ean, psn_title_id, psn_product_id, price, store, acquired_at, is_free, source, notes';

// ── IGDB ─────────────────────────────────────────────────────────────────────

// GET /games/igdb/search?q= — candidatos de IGDB en plataformas de PlayStation
games.get('/igdb/search', async (c) => {
  const q = c.req.query('q') ?? '';
  try {
    const results = await searchGames(c.env, q);
    // Marca los que ya están en la colección, para ofrecer "añadir copia".
    const ids = results.map(r => r.igdb_id);
    const owned = ids.length
      ? await c.env.DB.prepare(`SELECT id, igdb_id FROM games WHERE igdb_id IN (${ids.map(() => '?').join(',')})`)
          .bind(...ids).all<{ id: number; igdb_id: number }>()
      : { results: [] };
    const local = new Map(owned.results.map(r => [r.igdb_id, r.id]));
    return c.json({ data: results.map(r => ({ ...r, local_id: local.get(r.igdb_id) ?? null })) });
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502);
  }
});

// GET /games/barcode/:ean — del código de barras de un juego físico a candidatos
// de IGDB. Si ya hay una copia con ese EAN se devuelve su juego y nada más.
games.get('/barcode/:ean', async (c) => {
  const ean = cleanEan(c.req.param('ean'));
  if (ean.length < 8) return c.json({ error: 'Código de barras no válido' }, 400);

  const owned = await c.env.DB
    .prepare('SELECT g.id, g.title FROM game_copies gc JOIN games g ON g.id = gc.game_id WHERE gc.ean = ? LIMIT 1')
    .bind(ean).first<{ id: number; title: string }>();
  if (owned) return c.json({ ean, owned, product: null, data: [] });

  const product = await lookupGameBarcode(ean);
  if (!product) return c.json({ ean, owned: null, product: null, data: [] });

  try {
    let results = await searchGames(c.env, product.title);
    // Títulos traducidos ("Ratchet & Clank: Una Dimensión Aparte"): IGDB los
    // tiene en inglés, pero la parte de antes de los dos puntos suele bastar.
    const head = product.title.split(':')[0].trim();
    if (!results.length && head !== product.title && head.length >= 3) results = await searchGames(c.env, head);
    const ids = results.map(r => r.igdb_id);
    const local = ids.length
      ? await c.env.DB.prepare(`SELECT id, igdb_id FROM games WHERE igdb_id IN (${ids.map(() => '?').join(',')})`)
          .bind(...ids).all<{ id: number; igdb_id: number }>()
      : { results: [] };
    const map = new Map(local.results.map(r => [r.igdb_id, r.id]));
    return c.json({ ean, owned: null, product, data: results.map(r => ({ ...r, local_id: map.get(r.igdb_id) ?? null })) });
  } catch (err) {
    // Sin IGDB aún sirve el nombre del producto para buscarlo o darlo de alta a mano.
    return c.json({ ean, owned: null, product, data: [], error: String(err instanceof Error ? err.message : err) });
  }
});

// GET /games/igdb/:igdbId — ficha completa para rellenar el alta
games.get('/igdb/:igdbId', async (c) => {
  try {
    const d = await gameDetail(c.env, Number(c.req.param('igdbId')));
    if (!d) return c.json({ error: 'No está en IGDB' }, 404);
    return c.json(d);
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502);
  }
});

// ── Juegos ───────────────────────────────────────────────────────────────────

// GET /games/facets — para los filtros del listado
games.get('/facets', async (c) => {
  const [platforms, genres, franchises] = await Promise.all([
    c.env.DB.prepare('SELECT platform, COUNT(DISTINCT game_id) AS count FROM game_copies GROUP BY platform')
      .all<{ platform: string; count: number }>(),
    c.env.DB.prepare("SELECT genres FROM games WHERE genres IS NOT NULL AND genres != ''").all<{ genres: string }>(),
    c.env.DB.prepare("SELECT DISTINCT franchise FROM games WHERE franchise IS NOT NULL AND franchise != '' ORDER BY franchise")
      .all<{ franchise: string }>(),
  ]);
  const genreSet = new Set(genres.results.flatMap(r => r.genres.split(',').map(s => s.trim()).filter(Boolean)));
  return c.json({
    platforms: platforms.results.sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform)),
    genres: [...genreSet].sort((a, b) => a.localeCompare(b, 'es')),
    franchises: franchises.results.map(r => r.franchise),
  });
});

// GET /games — listado paginado con filtros
games.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 42)));
  const search = c.req.query('search') ?? '';
  const status = c.req.query('status') ?? '';
  const platform = c.req.query('platform') ?? '';
  const format = c.req.query('format') ?? '';
  const genre = c.req.query('genre') ?? '';
  const franchise = c.req.query('franchise') ?? '';
  const sort = c.req.query('sort') ?? 'created_at';
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';

  const allowedSort = ['created_at', 'updated_at', 'title', 'first_release_date', 'completed_at', 'rating'];
  const safeSort = allowedSort.includes(sort) ? sort : 'created_at';

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (search) {
    const text = foldedLike(['g.title', 'g.franchise', 'g.developer', 'g.publisher'], search);
    conditions.push(`(${text.sql} OR EXISTS (SELECT 1 FROM game_copies WHERE game_id = g.id AND ean = ?))`);
    params.push(...text.params, search.trim());
  }
  if (status && STATUSES.includes(status)) { conditions.push('g.status = ?'); params.push(status); }
  if (platform) { conditions.push('EXISTS (SELECT 1 FROM game_copies WHERE game_id = g.id AND platform = ?)'); params.push(platform); }
  if (format) { conditions.push('EXISTS (SELECT 1 FROM game_copies WHERE game_id = g.id AND format = ?)'); params.push(format); }
  if (genre) { conditions.push("(',' || REPLACE(g.genres, ', ', ',') || ',') LIKE ?"); params.push(`%,${genre},%`); }
  if (franchise) { conditions.push('g.franchise = ?'); params.push(franchise); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [count, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM games g ${where}`).bind(...params).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT g.*, ${AGGREGATES} FROM games g ${where}
       ORDER BY g.${safeSort} IS NULL, g.${safeSort} ${order}, g.id DESC LIMIT ? OFFSET ?`
    ).bind(...params, limit, (page - 1) * limit).all<Record<string, unknown>>(),
  ]);

  return c.json({ data: rows.results.map(shapeGame), total: count?.count ?? 0, page, limit });
});

// GET /games/:id — juego con sus copias
games.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const game = await c.env.DB.prepare(`SELECT g.*, ${AGGREGATES} FROM games g WHERE g.id = ?`).bind(id)
    .first<Record<string, unknown>>();
  if (!game) return c.json({ error: 'No encontrado' }, 404);
  const copies = await c.env.DB.prepare(
    'SELECT * FROM game_copies WHERE game_id = ? ORDER BY platform, format, id'
  ).bind(id).all<Record<string, unknown>>();
  return c.json({ ...shapeGame(game), copies: copies.results.map(shapeCopy) });
});

function gameValues(b: Body) {
  const status = str(b, 'status');
  return [
    num(b, 'igdb_id'), str(b, 'title'), str(b, 'cover_url'), str(b, 'summary'), str(b, 'genres'),
    str(b, 'developer'), str(b, 'publisher'), str(b, 'franchise'), str(b, 'first_release_date'), str(b, 'igdb_url'),
    status && STATUSES.includes(status) ? status : 'pending',
    str(b, 'completed_at'), rating(b), str(b, 'notes'),
  ];
}

// POST /games — alta con sus copias. Si el juego de IGDB ya está, 409 con su
// id: el front ofrece añadirle la copia en vez de duplicarlo.
games.post('/', async (c) => {
  const body = await c.req.json<Body>();
  if (!str(body, 'title')) return c.json({ error: 'El título es obligatorio' }, 400);

  const igdbId = num(body, 'igdb_id');
  if (igdbId != null) {
    const dup = await c.env.DB.prepare('SELECT id FROM games WHERE igdb_id = ?').bind(igdbId).first<{ id: number }>();
    if (dup) return c.json({ error: 'Ya tienes este juego', id: dup.id }, 409);
  }

  const copies = Array.isArray(body['copies']) ? (body['copies'] as Body[]) : [];
  const copyRows = copies.map(copyValues);
  const bad = copyRows.find((r): r is { error: string } => 'error' in r);
  if (bad) return c.json({ error: bad.error }, 400);

  const t = now();
  const res = await c.env.DB.prepare(`
    INSERT INTO games (igdb_id, title, cover_url, summary, genres, developer, publisher, franchise,
      first_release_date, igdb_url, status, completed_at, rating, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(...gameValues(body), t, t).run();
  const gameId = res.meta.last_row_id;

  if (copyRows.length) {
    await c.env.DB.batch(copyRows.map(r => c.env.DB.prepare(
      `INSERT INTO game_copies (game_id, ${COPY_COLUMNS}, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(gameId, ...(r as { values: unknown[] }).values, t, t)));
  }

  return c.json({ id: gameId }, 201);
});

// PUT /games/:id — la ficha y el estado (las copias van por su ruta)
games.put('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Body>();
  if (!str(body, 'title')) return c.json({ error: 'El título es obligatorio' }, 400);
  const exists = await c.env.DB.prepare('SELECT id FROM games WHERE id = ?').bind(id).first();
  if (!exists) return c.json({ error: 'No encontrado' }, 404);

  await c.env.DB.prepare(`
    UPDATE games SET igdb_id=?, title=?, cover_url=?, summary=?, genres=?, developer=?, publisher=?, franchise=?,
      first_release_date=?, igdb_url=?, status=?, completed_at=?, rating=?, notes=?, updated_at=?
    WHERE id = ?
  `).bind(...gameValues(body), now(), id).run();
  return c.json({ ok: true });
});

// DELETE /games/:id — el juego y sus copias
games.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM game_copies WHERE game_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM games WHERE id = ?').bind(id),
  ]);
  return c.json({ ok: true });
});

// ── Copias ───────────────────────────────────────────────────────────────────

// POST /games/:id/copies
games.post('/:id{[0-9]+}/copies', async (c) => {
  const id = Number(c.req.param('id'));
  const exists = await c.env.DB.prepare('SELECT id FROM games WHERE id = ?').bind(id).first();
  if (!exists) return c.json({ error: 'No encontrado' }, 404);
  const r = copyValues(await c.req.json<Body>());
  if ('error' in r) return c.json({ error: r.error }, 400);
  const t = now();
  const res = await c.env.DB.prepare(
    `INSERT INTO game_copies (game_id, ${COPY_COLUMNS}, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, ...r.values, t, t).run();
  await c.env.DB.prepare('UPDATE games SET updated_at = ? WHERE id = ?').bind(t, id).run();
  return c.json({ id: res.meta.last_row_id }, 201);
});

// PUT /games/copies/:copyId
games.put('/copies/:copyId{[0-9]+}', async (c) => {
  const copyId = Number(c.req.param('copyId'));
  const r = copyValues(await c.req.json<Body>());
  if ('error' in r) return c.json({ error: r.error }, 400);
  const res = await c.env.DB.prepare(`
    UPDATE game_copies SET platform=?, format=?, edition=?, ean=?, psn_title_id=?, psn_product_id=?, price=?,
      store=?, acquired_at=?, is_free=?, source=?, notes=?, updated_at=? WHERE id = ?
  `).bind(...r.values, now(), copyId).run();
  if (!res.meta.changes) return c.json({ error: 'No encontrada' }, 404);
  return c.json({ ok: true });
});

// DELETE /games/copies/:copyId
games.delete('/copies/:copyId{[0-9]+}', async (c) => {
  await c.env.DB.prepare('DELETE FROM game_copies WHERE id = ?').bind(Number(c.req.param('copyId'))).run();
  return c.json({ ok: true });
});

export { games };
