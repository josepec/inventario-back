import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { now, foldedLike } from '../db/helpers';
import { searchGames, gameDetail, PS_PLATFORMS } from '../services/igdb';
import { cleanEan, lookupGameBarcode } from '../services/game-barcode';
import { applyPlatinums, linkListsToGame, syncTrophies } from '../services/trophies';
import { importCandidate, linkDlcs, PsnCopy, PsnDlc, readPsnLibrary, saveDlcs } from '../services/psn-library';

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
    has_platinum: r['has_platinum'] === 1,
    trophy_progress: r['trophy_progress'] == null ? null : Number(r['trophy_progress']),
  };
}

function shapeCopy(r: Record<string, unknown>) {
  return { ...r, is_free: r['is_free'] === 1 };
}

const AGGREGATES = `
  (SELECT GROUP_CONCAT(DISTINCT platform) FROM game_copies WHERE game_id = g.id) AS platforms,
  (SELECT GROUP_CONCAT(DISTINCT format)   FROM game_copies WHERE game_id = g.id) AS formats,
  (SELECT COUNT(*)                        FROM game_copies WHERE game_id = g.id) AS copies_count,
  (SELECT MAX(earned_platinum > 0)        FROM game_trophy_lists WHERE game_id = g.id) AS has_platinum,
  (SELECT MAX(progress)                   FROM game_trophy_lists WHERE game_id = g.id) AS trophy_progress`;

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

// ── Trofeos (fase 2) ─────────────────────────────────────────────────────────

const TROPHY_LIST_COLUMNS = `l.id, l.np_communication_id, l.title, l.icon_url, l.platforms, l.progress,
  l.earned_platinum, l.earned_gold, l.earned_silver, l.earned_bronze,
  l.defined_platinum, l.defined_gold, l.defined_silver, l.defined_bronze,
  l.platinum_at, l.last_played_at, l.game_id, l.link_state`;

// GET /games/trophies/status — última sincronización y recuento de listas
games.get('/trophies/status', async (c) => {
  const [synced, counts] = await Promise.all([
    c.env.DB.prepare("SELECT value FROM settings WHERE key = 'trophies_synced_at'").first<{ value: string }>(),
    c.env.DB.prepare(`SELECT
        COUNT(*) AS total,
        SUM(game_id IS NOT NULL) AS linked,
        SUM(game_id IS NULL AND (link_state IS NULL OR link_state != 'ignored')) AS pending,
        SUM(link_state = 'ignored') AS ignored,
        SUM(earned_platinum > 0) AS platinums
      FROM game_trophy_lists`).first<Record<string, number | null>>(),
  ]);
  return c.json({
    synced_at: synced?.value ?? null,
    connected: !!c.env.TROFEOS,
    total: counts?.total ?? 0, linked: counts?.linked ?? 0, pending: counts?.pending ?? 0,
    ignored: counts?.ignored ?? 0, platinums: counts?.platinums ?? 0,
  });
});

// POST /games/trophies/sync — sin esperar al cron diario
games.post('/trophies/sync', async (c) => {
  try {
    return c.json(await syncTrophies(c.env));
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502);
  }
});

// GET /games/trophies/lists?state=pending|ignored|linked&q= — para enlazarlas
games.get('/trophies/lists', async (c) => {
  const state = c.req.query('state') ?? 'pending';
  const q = (c.req.query('q') ?? '').trim();
  const where = [
    state === 'ignored' ? "l.link_state = 'ignored'"
      : state === 'linked' ? 'l.game_id IS NOT NULL'
      : "l.game_id IS NULL AND (l.link_state IS NULL OR l.link_state != 'ignored')",
  ];
  const params: unknown[] = [];
  if (q) { const f = foldedLike(['l.title'], q); where.push(`(${f.sql})`); params.push(...f.params); }
  const rows = await c.env.DB.prepare(`
    SELECT ${TROPHY_LIST_COLUMNS}, g.title AS game_title
    FROM game_trophy_lists l LEFT JOIN games g ON g.id = l.game_id
    WHERE ${where.join(' AND ')}
    ORDER BY l.last_played_at DESC`).bind(...params).all();
  return c.json({ data: rows.results });
});

// PUT /games/trophies/lists/:id — { game_id } enlaza, { game_id: null } desenlaza,
// { ignored: true|false } la saca o la devuelve a pendientes
games.put('/trophies/lists/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Body>();
  if ('ignored' in body) {
    await c.env.DB.prepare(`UPDATE game_trophy_lists SET game_id = NULL, link_state = ? WHERE id = ?`)
      .bind(body['ignored'] ? 'ignored' : null, id).run();
    return c.json({ ok: true });
  }
  const gameId = num(body, 'game_id');
  if (gameId != null) {
    const g = await c.env.DB.prepare('SELECT id FROM games WHERE id = ?').bind(gameId).first();
    if (!g) return c.json({ error: 'Ese juego no existe' }, 404);
  }
  // Decisión del usuario: la sincronización ya no la vuelve a enlazar sola.
  await c.env.DB.prepare(`UPDATE game_trophy_lists SET game_id = ?, link_state = 'manual' WHERE id = ?`)
    .bind(gameId, id).run();
  if (gameId != null) await applyPlatinums(c.env.DB);
  return c.json({ ok: true });
});

// ── Compras de PSN (fase 3) ──────────────────────────────────────────────────

// GET /games/psn/library — lo comprado en la Store, clasificado, para revisarlo
games.get('/psn/library', async (c) => {
  try {
    return c.json(await readPsnLibrary(c.env));
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502);
  }
});

// POST /games/psn/import — un juego (con sus copias digitales) por llamada:
// cada uno pide IGDB y la portada, y así no se pasa del límite de subpeticiones.
games.post('/psn/import', async (c) => {
  const body = await c.req.json<{ title?: string; copies?: PsnCopy[]; game_id?: number | null }>();
  const copies = (body.copies ?? []).filter(x =>
    x && typeof x.title_id === 'string' && ['PS3', 'PS4', 'PS5'].includes(x.platform));
  if (!body.title?.trim() || !copies.length) return c.json({ error: 'Faltan el título o las copias' }, 400);
  try {
    const r = await importCandidate(c.env, { title: body.title.trim(), copies, game_id: body.game_id ?? null },
      new URL(c.req.url).origin);
    return c.json(r);
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 502);
  }
});

// POST /games/psn/dlcs — { dlcs } todos de una vez; se enlazan con su juego
games.post('/psn/dlcs', async (c) => {
  const body = await c.req.json<{ dlcs?: PsnDlc[] }>();
  const dlcs = (body.dlcs ?? []).filter(d => d && typeof d.entitlement_id === 'string' && typeof d.name === 'string');
  return c.json(await saveDlcs(c.env, dlcs));
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
  const sort = c.req.query('sort') ?? 'acquired_at';
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';

  // "Recientes" = la última copia que se compró; sin fecha de compra, cuando se dio de alta.
  const SORTS: Record<string, string> = {
    acquired_at: 'COALESCE((SELECT MAX(acquired_at) FROM game_copies WHERE game_id = g.id), g.created_at)',
    created_at: 'g.created_at', updated_at: 'g.updated_at', title: 'g.title',
    first_release_date: 'g.first_release_date', completed_at: 'g.completed_at', rating: 'g.rating',
  };
  const sortExpr = SORTS[sort] ?? SORTS['acquired_at'];

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
  const ratingMin = Number(c.req.query('rating_min'));
  if (ratingMin > 0) { conditions.push('g.rating >= ?'); params.push(ratingMin); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [count, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM games g ${where}`).bind(...params).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT g.*, ${AGGREGATES} FROM games g ${where}
       ORDER BY ${sortExpr} IS NULL, ${sortExpr} ${order}, g.id DESC LIMIT ? OFFSET ?`
    ).bind(...params, limit, (page - 1) * limit).all<Record<string, unknown>>(),
  ]);

  return c.json({ data: rows.results.map(shapeGame), total: count?.count ?? 0, page, limit });
});

// PATCH /games/batch — { ids, status }: cambiar el estado de varios a la vez,
// como en libros. La fecha de "pasado" la ponen los triggers de 0017.
games.patch('/batch', async (c) => {
  const body = await c.req.json<{ ids?: unknown[]; status?: string }>();
  const ids = (body.ids ?? []).filter((x): x is number => Number.isInteger(x));
  if (!ids.length) return c.json({ error: 'ids requeridos' }, 400);
  if (!body.status || !STATUSES.includes(body.status)) return c.json({ error: 'Estado no válido' }, 400);
  const r = await c.env.DB.prepare(
    `UPDATE games SET status = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND status != ?`
  ).bind(body.status, now(), JSON.stringify(ids), body.status).run();
  return c.json({ ok: true, updated: r.meta.changes ?? 0 });
});

// GET /games/:id — juego con sus copias
games.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const game = await c.env.DB.prepare(`SELECT g.*, ${AGGREGATES} FROM games g WHERE g.id = ?`).bind(id)
    .first<Record<string, unknown>>();
  if (!game) return c.json({ error: 'No encontrado' }, 404);
  const [copies, lists, dlcs] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM game_copies WHERE game_id = ? ORDER BY platform, format, id')
      .bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT ${TROPHY_LIST_COLUMNS} FROM game_trophy_lists l WHERE l.game_id = ? ORDER BY l.platforms DESC`)
      .bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT id, name, platform, acquired_at, icon_url FROM game_dlcs WHERE game_id = ? ORDER BY acquired_at, name')
      .bind(id).all<Record<string, unknown>>(),
  ]);
  return c.json({
    ...shapeGame(game), copies: copies.results.map(shapeCopy), trophy_lists: lists.results, dlcs: dlcs.results,
  });
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

  // Listas de trofeos: la que se eligió al darlo de alta desde "Trofeos" y las
  // pendientes con el mismo título. Si falla, el juego ya está guardado.
  try {
    const listId = num(body, 'trophy_list_id');
    if (listId != null) {
      await c.env.DB.prepare(`UPDATE game_trophy_lists SET game_id = ?, link_state = 'manual' WHERE id = ?`)
        .bind(gameId, listId).run();
      await applyPlatinums(c.env.DB);
    }
    const extraNames = Array.isArray(body['extra_names'])
      ? (body['extra_names'] as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 5)
      : [];
    await linkListsToGame(c.env, gameId, extraNames);
    await linkDlcs(c.env.DB);
  } catch (err) {
    console.error('trofeos/DLC al dar de alta:', err);
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
