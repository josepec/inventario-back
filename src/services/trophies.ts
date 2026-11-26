import { Env } from '../types';
import { alternativeNames } from './igdb';

/**
 * Listas de trofeos de PSN → game_trophy_lists (migrations/0018).
 *
 * El Worker Trofeos es el único que se autentica con Sony: por RPC da un token
 * de acceso y las fechas de los platinos que ya conoce. Con el token se lee
 * aquí la lista completa de juegos con trofeos (1-2 llamadas a PSN).
 *
 * El plan gratuito permite 50 consultas a D1 por invocación y hay cientos de
 * listas, así que todo se escribe en bloque: cada paso es UNA consulta que
 * recorre un JSON con json_each. Una sincronización entera son ~8 consultas.
 */

const PSN_API = 'https://m.np.playstation.com/api';

type Tipo = 'platinum' | 'gold' | 'silver' | 'bronze';

interface TituloPsn {
  npServiceName: string;
  npCommunicationId: string;
  trophyTitleName: string;
  trophyTitleIconUrl?: string;
  trophyTitlePlatform: string;
  progress: number;
  earnedTrophies: Record<Tipo, number>;
  definedTrophies: Record<Tipo, number>;
  lastUpdatedDateTime?: string;
}

/** Plataformas que cuentan: PS Vita fuera (decisión del usuario), PSP y PS1/PS2 no tienen trofeos. */
const PLATFORMS = ['PS3', 'PS4', 'PS5'];

export function listPlatforms(raw: string): string[] {
  return raw.split(',').map(p => p.trim().toUpperCase()).filter(p => PLATFORMS.includes(p))
    .sort((a, b) => PLATFORMS.indexOf(a) - PLATFORMS.indexOf(b));
}

/**
 * Clave para comparar títulos de PSN con los de IGDB: sin mayúsculas, tildes,
 * marcas, sufijos de plataforma ni puntuación. NFKD convierte además los
 * números romanos de un solo carácter que usa PSN ("FINAL FANTASY Ⅱ" → "II");
 * sin eso se perdían y FF II, III y IV acababan en el FF I.
 *   "FINAL FANTASY TACTICS - The Ivalice Chronicles" ≡ "Final Fantasy Tactics: The Ivalice Chronicles"
 *   "Marvel's Spider-Man 2 (PS5)" ≡ "Marvel’s Spider-Man 2"
 */
export function titleKey(title: string): string {
  return title
    .replace(/[™®©]/g, '')          // antes de NFKD, que haría de ™ "TM"
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^trofeos de\s+/, '')
    .replace(/∀/g, 'a')
    .replace(/\s*[([]?\b(?:ps[345]|playstation\s*[345]|ps\s?vita)\b[)\]]?\s*(?:edition)?\s*$/i, '')
    .replace(/\s+trophies$/i, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

async function psnTitles(token: string): Promise<TituloPsn[]> {
  const all: TituloPsn[] = [];
  for (let offset = 0; ;) {
    const res = await fetch(`${PSN_API}/trophy/v1/users/me/trophyTitles?limit=800&offset=${offset}`, {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'es-ES' },
    });
    if (!res.ok) throw new Error(`PSN ${res.status} al leer las listas de trofeos`);
    const page = await res.json<{ trophyTitles: TituloPsn[]; totalItemCount: number }>();
    all.push(...page.trophyTitles);
    offset += page.trophyTitles.length;
    if (!page.trophyTitles.length || offset >= page.totalItemCount) return all;
  }
}

export interface TrophySyncResult {
  lists: number;
  linked: number;
  platinumsApplied: number;
  /** Listas a las que se les ha sacado la fecha del primer trofeo, y las que faltan. */
  firstDates: number;
  firstDatesPending: number;
}

/**
 * Enlaza las listas sin decidir cuyo título coincide con el de un juego: primero
 * con su título; las que sigan sueltas, con sus nombres alternativos de IGDB
 * (muchas listas de PSN van en castellano o abreviadas). Si una clave sirve
 * para dos juegos de la colección, no se adivina cuál es.
 */
async function autoLink(env: Env, onlyGameId?: number, extraNames: string[] = []): Promise<number> {
  const db = env.DB;
  const [lists, games] = await Promise.all([
    db.prepare('SELECT id, title FROM game_trophy_lists WHERE game_id IS NULL AND link_state IS NULL')
      .all<{ id: number; title: string }>(),
    (onlyGameId
      ? db.prepare('SELECT id, title, igdb_id FROM games WHERE id = ?').bind(onlyGameId)
      : db.prepare('SELECT id, title, igdb_id FROM games')
    ).all<{ id: number; title: string; igdb_id: number | null }>(),
  ]);
  if (!lists.results.length || !games.results.length) return 0;

  const keyMap = (names: { id: number; name: string }[]) => {
    const m = new Map<string, number>();
    for (const n of names) {
      const k = titleKey(n.name);
      if (!k) continue;
      const prev = m.get(k);
      m.set(k, prev === undefined || prev === n.id ? n.id : -1);
    }
    return m;
  };

  const byTitle = keyMap(games.results.map(g => ({ id: g.id, name: g.title })));
  const links = new Map<number, number>();
  for (const l of lists.results) {
    const id = byTitle.get(titleKey(l.title)) ?? 0;
    if (id > 0) links.set(l.id, id);
  }

  const rest = lists.results.filter(l => !links.has(l.id));
  const withIgdb = games.results.filter(g => g.igdb_id);
  // Nombres de más del juego recién dado de alta: el del producto escaneado
  // (Amazon.es lo da en castellano, como suelen ir las listas de PSN).
  const extra = onlyGameId ? extraNames.map(name => ({ id: onlyGameId, name })) : [];
  if (rest.length && (withIgdb.length || extra.length)) {
    try {
      const alt = withIgdb.length && env.IGDB_CLIENT_ID
        ? await alternativeNames(env, withIgdb.map(g => g.igdb_id!)) : new Map<number, string[]>();
      const byAlt = keyMap([
        ...withIgdb.flatMap(g => (alt.get(g.igdb_id!) ?? []).map(name => ({ id: g.id, name }))),
        ...extra,
      ]);
      for (const l of rest) {
        const k = titleKey(l.title);
        // El título de otro juego manda sobre el nombre alternativo de este.
        if (byTitle.has(k)) continue;
        const id = byAlt.get(k) ?? 0;
        if (id > 0) links.set(l.id, id);
      }
    } catch (err) {
      console.error('nombres alternativos de IGDB:', err);
    }
  }

  if (!links.size) return 0;
  await db.prepare(`
    UPDATE game_trophy_lists SET game_id = j.game_id, link_state = 'auto'
    FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.game_id') AS game_id FROM json_each(?)) AS j
    WHERE game_trophy_lists.id = j.id`)
    .bind(JSON.stringify([...links].map(([id, game_id]) => ({ id, game_id })))).run();
  return links.size;
}

/**
 * Platino → juego pasado, una sola vez por lista: si luego se cambia el estado
 * a mano, se respeta. Si el juego ya estaba pasado, se deja como está.
 */
export async function applyPlatinums(db: D1Database): Promise<number> {
  const due = await db.prepare(`
    SELECT l.id, l.game_id, l.platinum_at, l.last_played_at, g.status
    FROM game_trophy_lists l JOIN games g ON g.id = l.game_id
    WHERE l.earned_platinum > 0 AND l.platinum_applied = 0`)
    .all<{ id: number; game_id: number; platinum_at: string | null; last_played_at: string | null; status: string }>();
  if (!due.results.length) return 0;

  // El platino no puede ser posterior al último trofeo: sin fecha, esa vale.
  const toComplete = [...new Map(due.results
    .filter(r => r.status !== 'completed')
    .map(r => [r.game_id, { game_id: r.game_id, at: sqlDate(r.platinum_at ?? r.last_played_at) }])).values()];
  const stmts = [
    db.prepare(`UPDATE game_trophy_lists SET platinum_applied = 1
      WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(due.results.map(r => r.id))),
  ];
  if (toComplete.length) {
    // El trigger de 0017 respeta el completed_at y el completed_source que se le dan.
    stmts.unshift(db.prepare(`
      UPDATE games SET status = 'completed', completed_at = j.at, completed_source = 'platinum', updated_at = datetime('now')
      FROM (SELECT json_extract(value, '$.game_id') AS game_id, json_extract(value, '$.at') AS at FROM json_each(?)) AS j
      WHERE games.id = j.game_id AND games.status != 'completed'`).bind(JSON.stringify(toComplete)));
  }
  await db.batch(stmts);
  return toComplete.length;
}

/** "2024-03-01T18:22:10Z" → "2024-03-01 18:22:10" (UTC, como datetime('now')). */
function sqlDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}

export async function syncTrophies(env: Env): Promise<TrophySyncResult> {
  if (!env.TROFEOS) throw new Error('Falta el binding TROFEOS (wrangler.toml)');
  const token = await env.TROFEOS.tokenAcceso();
  const [titles, platinums] = await Promise.all([psnTitles(token), env.TROFEOS.platinos()]);

  const rows = titles
    .map(t => ({ t, platforms: listPlatforms(t.trophyTitlePlatform) }))
    .filter(x => x.platforms.length)
    .map(({ t, platforms }) => ({
      np: t.npCommunicationId,
      svc: t.npServiceName,
      title: t.trophyTitleName.trim(),
      icon: t.trophyTitleIconUrl ?? null,
      platforms: platforms.join(','),
      progress: Math.round(Number(t.progress) || 0),
      ep: t.earnedTrophies.platinum ?? 0, eg: t.earnedTrophies.gold ?? 0,
      es: t.earnedTrophies.silver ?? 0, eb: t.earnedTrophies.bronze ?? 0,
      dp: t.definedTrophies.platinum ?? 0, dg: t.definedTrophies.gold ?? 0,
      ds: t.definedTrophies.silver ?? 0, db: t.definedTrophies.bronze ?? 0,
      plat: t.earnedTrophies.platinum > 0 ? platinums[t.npCommunicationId]?.fecha ?? null : null,
      last: t.lastUpdatedDateTime ?? null,
    }));

  if (rows.length) {
    await env.DB.prepare(`
      INSERT INTO game_trophy_lists (
        np_communication_id, np_service_name, title, icon_url, platforms, progress,
        earned_platinum, earned_gold, earned_silver, earned_bronze,
        defined_platinum, defined_gold, defined_silver, defined_bronze,
        platinum_at, last_played_at, synced_at)
      SELECT
        json_extract(value, '$.np'), json_extract(value, '$.svc'), json_extract(value, '$.title'),
        json_extract(value, '$.icon'), json_extract(value, '$.platforms'), json_extract(value, '$.progress'),
        json_extract(value, '$.ep'), json_extract(value, '$.eg'), json_extract(value, '$.es'), json_extract(value, '$.eb'),
        json_extract(value, '$.dp'), json_extract(value, '$.dg'), json_extract(value, '$.ds'), json_extract(value, '$.db'),
        json_extract(value, '$.plat'), json_extract(value, '$.last'), datetime('now')
      FROM json_each(?) WHERE true
      ON CONFLICT(np_communication_id) DO UPDATE SET
        np_service_name = excluded.np_service_name, title = excluded.title, icon_url = excluded.icon_url,
        platforms = excluded.platforms, progress = excluded.progress,
        earned_platinum = excluded.earned_platinum, earned_gold = excluded.earned_gold,
        earned_silver = excluded.earned_silver, earned_bronze = excluded.earned_bronze,
        defined_platinum = excluded.defined_platinum, defined_gold = excluded.defined_gold,
        defined_silver = excluded.defined_silver, defined_bronze = excluded.defined_bronze,
        platinum_at = COALESCE(excluded.platinum_at, game_trophy_lists.platinum_at),
        last_played_at = excluded.last_played_at, synced_at = excluded.synced_at`)
      .bind(JSON.stringify(rows)).run();
  }

  const linked = await autoLink(env);
  const platinumsApplied = await applyPlatinums(env.DB);
  const first = await fillFirstTrophies(env.DB, token);
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('trophies_synced_at', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  return { lists: rows.length, linked, platinumsApplied, firstDates: first.done, firstDatesPending: first.pending };
}

/** Tras dar de alta un juego: le busca listas pendientes con su título (o los nombres que se den). */
export async function linkListsToGame(env: Env, gameId: number, extraNames: string[] = []): Promise<void> {
  const n = await autoLink(env, gameId, extraNames);
  if (n) await applyPlatinums(env.DB);
}

// ── Fechas estimadas (migrations/0020) ──────────────────────────────────────

/**
 * Llamadas a PSN por sincronización: el plan gratuito deja 50 subpeticiones por
 * invocación y la sincronización ya gasta unas pocas. La primera vez quedan
 * listas por hacer; se terminan en las siguientes (cron diario o el botón).
 */
const FIRST_TROPHY_BATCH = 35;

/**
 * La fecha del primer trofeo de las listas vinculadas a un juego (solo con
 * algún trofeo y sin fecha aún; no cambia, así que se pide una vez por lista).
 * Con ellas, la fecha de compra estimada de las copias físicas que no la tienen.
 */
async function fillFirstTrophies(db: D1Database, token: string): Promise<{ done: number; pending: number }> {
  const due = await db.prepare(`
    SELECT id, np_communication_id AS np, np_service_name AS svc FROM game_trophy_lists
    WHERE game_id IS NOT NULL AND first_earned_at IS NULL
      AND earned_platinum + earned_gold + earned_silver + earned_bronze > 0
    ORDER BY last_played_at DESC`).all<{ id: number; np: string; svc: string }>();

  const batch = due.results.slice(0, FIRST_TROPHY_BATCH);
  const found = (await Promise.all(batch.map(async l => {
    const at = await firstEarned(token, l.np, l.svc).catch(err => { console.error('primer trofeo', l.np, err); return null; });
    return at ? { id: l.id, at } : null;
  }))).filter((x): x is { id: number; at: string } => !!x);

  await db.batch([
    ...(found.length ? [db.prepare(`
      UPDATE game_trophy_lists SET first_earned_at = j.at
      FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.at') AS at FROM json_each(?)) AS j
      WHERE game_trophy_lists.id = j.id`).bind(JSON.stringify(found))] : []),
    estimateAcquired(db),
  ]);
  return { done: found.length, pending: due.results.length - found.length };
}

async function firstEarned(token: string, np: string, svc: string): Promise<string | null> {
  const res = await fetch(
    `${PSN_API}/trophy/v1/users/me/npCommunicationIds/${encodeURIComponent(np)}/trophyGroups/all/trophies?npServiceName=${encodeURIComponent(svc)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`PSN ${res.status}`);
  const j = await res.json<{ trophies?: { earned?: boolean; earnedDateTime?: string }[] }>();
  const dates = (j.trophies ?? []).filter(t => t.earned && t.earnedDateTime).map(t => t.earnedDateTime!).sort();
  return sqlDate(dates[0] ?? null);
}

/**
 * Copias físicas sin fecha de compra (o con una estimada): el primer trofeo de
 * las listas de su juego en esa plataforma. Un disco de PS4 en la PS5 da trofeos
 * de PS4, así que a una copia de PS5 le valen también las listas de PS4.
 */
function estimateAcquired(db: D1Database): D1PreparedStatement {
  return db.prepare(`
    UPDATE game_copies SET acquired_at = e.at, acquired_estimated = 1, updated_at = datetime('now')
    FROM (
      SELECT c.id, date(MIN(l.first_earned_at)) AS at
      FROM game_copies c JOIN game_trophy_lists l ON l.game_id = c.game_id
      WHERE c.format = 'physical' AND (c.acquired_at IS NULL OR c.acquired_estimated = 1)
        AND l.first_earned_at IS NOT NULL
        AND (instr(l.platforms, c.platform) > 0 OR (c.platform = 'PS5' AND instr(l.platforms, 'PS4') > 0))
      GROUP BY c.id
    ) AS e
    WHERE game_copies.id = e.id AND game_copies.acquired_at IS NOT e.at`);
}
