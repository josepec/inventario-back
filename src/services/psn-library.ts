import { Env } from '../types';
import { titleKey, linkListsToGame } from './trophies';
import { searchGames, gameDetail, findByAlternativeName, IgdbSearchResult } from './igdb';
import { parseProductTitle } from './game-barcode';

/**
 * Compras de la PlayStation Store → juegos digitales y DLC (fase 3).
 *
 * Fuente: la API de "entitlements" de la tienda (la que usaba la PS3 y sigue
 * viva). Da TODO lo que hay en la cuenta, con la fecha de compra:
 *   - PS4GD / PSGD (activos): juegos de PS4 / PS5 (y apps, demos, artbooks);
 *   - PS4AC, PSAC, PS4AL, PSAL: DLC (contenido y licencias);
 *   - "…-ATHOME": marca de los regalos de Play At Home (2020-2021);
 *   - ids NPxx0nnnn: juegos de PSN de PS3 (sin package_type, inactivos);
 *   - PS4MISC (temas, avatares), PSTRACK, descuentos y PS Plus: se ignoran.
 * La biblioteca GraphQL (getPurchasedGameList) da lo mismo de PS4/PS5 sin
 * fechas y nada de PS3, así que no se usa.
 *
 * El token lo da el Worker Trofeos por RPC (ver services/trophies.ts).
 */

const ENTITLEMENTS = 'https://commerce.api.np.km.playstation.net/commerce/api/v1/users/me/internal_entitlements';

interface Entitlement {
  id: string;
  product_id?: string;
  active_date?: string;
  active_flag: boolean;
  entitlement_type: number;
  serviceType?: number;
  game_meta?: { name?: string; package_type?: string; icon_url?: string };
  entitlement_attributes?: { platform_id?: string }[];
}

export type PsnPlatform = 'PS3' | 'PS4' | 'PS5';
export type PsnKind = 'game' | 'app' | 'demo' | 'extra';

export interface PsnCopy {
  platform: PsnPlatform;
  title_id: string;
  product_id: string;
  acquired_at: string | null;
  is_free: boolean;
  icon_url: string | null;
  name: string;
}

export interface PsnCandidate {
  key: string;
  title: string;
  kind: PsnKind;
  copies: PsnCopy[];
  dlc_count: number;
  /** Todas sus copias ya están importadas. */
  imported: boolean;
  /** Juego de la colección con el que se juntaría (por titleId o por título). */
  game_id: number | null;
  game_title: string | null;
}

export interface PsnDlc {
  entitlement_id: string;
  title_id: string;
  name: string;
  platform: PsnPlatform | null;
  acquired_at: string | null;
  icon_url: string | null;
}

const titleIdOf = (id: string) => id.split('-')[1] ?? '';
const day = (iso?: string) => (iso ? iso.slice(0, 10) : null);
export const cleanName = (s: string) => s.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();

const APP = /^(spotify|youtube|hbo|netflix|sharefactory|reproductor multimedia|media player|twitch|plex|disney\+|prime video|apple tv|vidzone|adhocparty|crunchyroll|dazn|movistar|eyecreate|singstar.*viewer)/i;
const DEMO = /\bdemo\b|demostraci[oó]n|\btrial\b|teaser|versi[oó]n de prueba|\bbeta\b/i;
const EXTRA = /artbook|soundtrack|banda sonora|^the art of\b/i;
/** Lo que nunca es un juego en las entradas de PS3 (claves, packs de inicio...). */
const PS3_NOT = /demo|trial|prueba|beta|teaser|key activation|clave|viewer|theme|tema|avatar|pack de inicio|starter|database|season|pase|soundtrack|artbook|expansion/i;
const DLC_TYPES = ['PS4AC', 'PSAC', 'PS4AL', 'PSAL'];

function kindOf(name: string): PsnKind {
  if (APP.test(name)) return 'app';
  if (DEMO.test(name)) return 'demo';
  if (EXTRA.test(name)) return 'extra';
  return 'game';
}

async function fetchEntitlements(token: string): Promise<Entitlement[]> {
  const all: Entitlement[] = [];
  for (let start = 0; start < 5000; start += 450) {
    const res = await fetch(`${ENTITLEMENTS}?start=${start}&size=450&fields=game_meta,non_game_meta,reward_meta,cloud_meta,conceptMeta`, {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'es-ES' },
    });
    if (!res.ok) throw new Error(`PSN ${res.status} al leer las compras`);
    const page = await res.json<{ entitlements?: Entitlement[] }>();
    all.push(...(page.entitlements ?? []));
    if ((page.entitlements?.length ?? 0) < 450) return all;
  }
  return all;
}

/** Clasifica las compras en juegos (agrupados por título) y DLC. Puro: se prueba sin red. */
export function classify(ents: Entitlement[]): { candidates: Omit<PsnCandidate, 'imported' | 'game_id' | 'game_title'>[]; dlcs: PsnDlc[] } {
  const freeTitles = new Set(ents.filter(e => /-ATHOME$/.test(e.id)).map(e => titleIdOf(e.id)));
  const copies: (PsnCopy & { kind: PsnKind })[] = [];
  const dlcs: PsnDlc[] = [];

  // PS4 / PS5
  for (const e of ents) {
    const pt = e.game_meta?.package_type;
    if (!e.active_flag || !pt) continue;
    const name = cleanName(e.game_meta?.name ?? '');
    if (!name) continue;
    const platform: PsnPlatform = pt.startsWith('PS4') ? 'PS4' : 'PS5';
    if (pt === 'PS4GD' || pt === 'PSGD') {
      copies.push({
        platform, title_id: titleIdOf(e.id), product_id: e.product_id ?? e.id, acquired_at: day(e.active_date),
        is_free: freeTitles.has(titleIdOf(e.id)), icon_url: e.game_meta?.icon_url ?? null, name, kind: kindOf(name),
      });
    } else if (DLC_TYPES.includes(pt)) {
      dlcs.push({ entitlement_id: e.id, title_id: titleIdOf(e.id), name, platform, acquired_at: day(e.active_date), icon_url: e.game_meta?.icon_url ?? null });
    }
  }
  // Pases de temporada: van sin package_type, pero con el titleId del juego.
  for (const e of ents) {
    const name = cleanName(e.game_meta?.name ?? '');
    if (e.active_flag && !e.game_meta?.package_type && e.entitlement_type === 1 && e.serviceType === 0
        && /season pass|pase de temporada|expansion pass/i.test(name)) {
      const tid = titleIdOf(e.id);
      dlcs.push({ entitlement_id: e.id, title_id: tid, name, platform: tid.startsWith('PPSA') ? 'PS5' : 'PS4', acquired_at: day(e.active_date), icon_url: null });
    }
  }
  // PS3: los juegos de PSN (NPxx0nnnn, no los 9nnnn de demos). El primero de
  // cada titleId es el juego; los demás del mismo titleId, sus DLC.
  const ps3Seen = new Set<string>();
  for (const e of [...ents].sort((a, b) => (a.active_date ?? '').localeCompare(b.active_date ?? ''))) {
    const tid = titleIdOf(e.id);
    if (e.game_meta?.package_type || !/^NP[A-Z]{2}0\d{4}_00$/.test(tid)) continue;
    const name = cleanName(e.game_meta?.name ?? '');
    if (!name || PS3_NOT.test(`${name} ${e.id.split('-')[2] ?? ''}`)) continue;
    if (ps3Seen.has(tid)) {
      dlcs.push({ entitlement_id: e.id, title_id: tid, name, platform: 'PS3', acquired_at: day(e.active_date), icon_url: null });
      continue;
    }
    ps3Seen.add(tid);
    copies.push({
      platform: 'PS3', title_id: tid, product_id: e.product_id ?? e.id, acquired_at: day(e.active_date),
      is_free: freeTitles.has(tid), icon_url: null, name, kind: kindOf(name),
    });
  }

  // Un juego por título: PS4 + PS5 (cross-gen o compras aparte) y PS3 juntos.
  const groups = new Map<string, (PsnCopy & { kind: PsnKind })[]>();
  for (const c of copies) {
    const k = titleKey(c.name);
    const g = groups.get(k) ?? [];
    // Mismo titleId dos veces (bundle y suelto): una sola copia.
    if (!g.some(x => x.title_id === c.title_id)) g.push(c);
    groups.set(k, g);
  }
  const dlcByTitle = new Map<string, number>();
  for (const d of dlcs) dlcByTitle.set(d.title_id, (dlcByTitle.get(d.title_id) ?? 0) + 1);

  const order: Record<PsnPlatform, number> = { PS3: 0, PS4: 1, PS5: 2 };
  const candidates = [...groups.entries()].map(([key, g]) => {
    g.sort((a, b) => order[a.platform] - order[b.platform]);
    // El nombre de la versión más nueva suele ser el bueno ("Front Mission 1st: Remake").
    const main = g[g.length - 1];
    return {
      key, title: main.name, kind: main.kind,
      copies: g.map(({ kind: _k, ...c }) => c),
      dlc_count: g.reduce((n, c) => n + (dlcByTitle.get(c.title_id) ?? 0), 0),
    };
  }).sort((a, b) => (b.copies[0].acquired_at ?? '').localeCompare(a.copies[0].acquired_at ?? ''));

  return { candidates, dlcs };
}

/** Lee la cuenta y marca lo que ya está en la colección. */
export async function readPsnLibrary(env: Env): Promise<{ candidates: PsnCandidate[]; dlcs: PsnDlc[] }> {
  if (!env.TROFEOS) throw new Error('Falta el binding TROFEOS (wrangler.toml)');
  const ents = await fetchEntitlements(await env.TROFEOS.tokenAcceso());
  const { candidates, dlcs } = classify(ents);

  const [copies, games] = await Promise.all([
    env.DB.prepare('SELECT psn_title_id, game_id FROM game_copies WHERE psn_title_id IS NOT NULL')
      .all<{ psn_title_id: string; game_id: number }>(),
    env.DB.prepare('SELECT id, title FROM games').all<{ id: number; title: string }>(),
  ]);
  const byTitleId = new Map(copies.results.map(r => [r.psn_title_id, r.game_id]));
  const byKey = new Map<string, { id: number; title: string }>();
  for (const g of games.results) byKey.set(titleKey(g.title), g);
  const titleOf = new Map(games.results.map(g => [g.id, g.title]));

  return {
    dlcs,
    candidates: candidates.map(c => {
      const viaCopy = c.copies.map(x => byTitleId.get(x.title_id)).find(Boolean) ?? null;
      const viaTitle = byKey.get(c.key) ?? null;
      const gameId = viaCopy ?? viaTitle?.id ?? null;
      return {
        ...c,
        imported: c.copies.every(x => byTitleId.has(x.title_id)),
        game_id: gameId,
        game_title: gameId ? titleOf.get(gameId) ?? null : null,
      };
    }),
  };
}

// ── Importación ──────────────────────────────────────────────────────────────

/** Lo más habitual de los nombres de la tienda española, en el inglés de IGDB. */
export function toIgdbName(name: string): string {
  return name
    .replace(/edici[oó]n definitiva/i, 'Definitive Edition')
    .replace(/edici[oó]n completa/i, 'Complete Edition')
    .replace(/edici[oó]n (?:del )?juego del a[nñ]o/i, 'Game of the Year Edition')
    .replace(/edici[oó]n deluxe/i, 'Deluxe Edition')
    .replace(/\bremasterizad[oa]\b/i, 'Remastered')
    .replace(/([a-z])(\d)/gi, '$1 $2');            // "Patapon2" → "Patapon 2"
}

const STOP = new Set(['the', 'of', 'a', 'an', 'and', 'la', 'el', 'los', 'las', 'de', 'del', 'y']);
const words = (s: string) => new Set(s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/∀/g, 'a').replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w)));

/** 0-1: palabras en común (Jaccard); 1 si el título normalizado es el mismo. */
export function similarity(a: string, b: string): number {
  if (titleKey(a) === titleKey(b)) return 1;
  const A = words(a), B = words(b);
  let common = 0;
  A.forEach(w => { if (B.has(w)) common++; });
  return common / (A.size + B.size - common || 1);
}

/**
 * El juego de IGDB para un nombre de la tienda, o null si no hay uno claro:
 * mejor sin ficha (se crea con el nombre y el icono de PSN) que con la de otro
 * juego. Orden: título exacto (y de esa consola, que "Ratchet & Clank" son
 * dos), nombre alternativo exacto (títulos en castellano), y por último un
 * parecido alto de palabras.
 */
async function matchIgdb(env: Env, name: string, platform: PsnPlatform, boughtYear: number | null): Promise<number | null> {
  // Lo que salió después de comprarlo no puede ser ("Invasion!" de 2016 no es el "Invasion" de 2023);
  // un año de margen para las reservas.
  const possible = (r: IgdbSearchResult) => !boughtYear || !r.year || r.year <= boughtYear + 1;
  const variants = [name, toIgdbName(name), parseProductTitle(toIgdbName(name)).title]
    .filter((q, i, a) => q.length >= 2 && a.indexOf(q) === i);
  const seen: IgdbSearchResult[] = [];
  for (const v of variants) {
    const results = (await searchGames(env, v)).filter(possible);
    seen.push(...results);
    const exact = results.filter(r => titleKey(r.title) === titleKey(v));
    if (exact.length) return (exact.find(r => r.platforms.includes(platform)) ?? exact[0]).igdb_id;
  }
  const alt = await findByAlternativeName(env, name);
  if (alt.length) return alt[0];

  let best: IgdbSearchResult | null = null;
  let score = 0;
  for (const r of seen) {
    const s = Math.max(...variants.map(v => similarity(v, r.title))) + (r.platforms.includes(platform) ? 0.05 : 0);
    if (s > score) { score = s; best = r; }
  }
  return best && score >= 0.6 ? best.igdb_id : null;
}

/** Copia una imagen a R2; si falla, se queda la URL original. */
async function persistCover(env: Env, url: string | null, origin: string): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return url;
    const data = await res.arrayBuffer();
    if (!data.byteLength) return url;
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await env.COVERS.put(key, data, { httpMetadata: { contentType: type } });
    return `${origin}/covers/${key}`;
  } catch {
    return url;
  }
}

export interface ImportResult {
  game_id: number;
  title: string;
  created: boolean;
  copies_added: number;
  igdb: boolean;
}

/**
 * Da de alta (o completa) un juego con sus copias digitales. Si el juego ya
 * está (por titleId o por título), solo añade las copias que le falten.
 */
export async function importCandidate(env: Env, c: Pick<PsnCandidate, 'title' | 'copies' | 'game_id'>, origin: string): Promise<ImportResult> {
  const db = env.DB;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let gameId = c.game_id;
  let title = c.title;
  let created = false;
  let igdb = false;

  if (gameId) {
    const g = await db.prepare('SELECT id, title FROM games WHERE id = ?').bind(gameId).first<{ id: number; title: string }>();
    if (!g) gameId = null; else title = g.title;
  }
  if (!gameId) {
    const newest = c.copies[c.copies.length - 1];
    const firstBought = c.copies.map(x => x.acquired_at).filter(Boolean).sort()[0];
    const hit = await matchIgdb(env, c.title, newest.platform, firstBought ? Number(firstBought.slice(0, 4)) : null);
    const d = hit ? await gameDetail(env, hit) : null;
    // Ya estaba con ese igdb_id (otro nombre en la tienda): se le suman las copias.
    const dup = d ? await db.prepare('SELECT id, title FROM games WHERE igdb_id = ?').bind(d.igdb_id).first<{ id: number; title: string }>() : null;
    if (dup) {
      gameId = dup.id; title = dup.title;
    } else {
      const cover = await persistCover(env, d?.cover_url ?? newest.icon_url, origin);
      title = d?.title ?? c.title;
      const res = await db.prepare(`
        INSERT INTO games (igdb_id, title, cover_url, summary, genres, developer, publisher, franchise,
          first_release_date, igdb_url, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
        .bind(d?.igdb_id ?? null, title, cover, d?.summary ?? null, d?.genres ?? null, d?.developer ?? null,
          d?.publisher ?? null, d?.franchise ?? null, d?.first_release_date ?? null, d?.igdb_url ?? null, now, now)
        .run();
      gameId = res.meta.last_row_id;
      created = true;
      igdb = !!d;
    }
  }

  const existing = await db.prepare('SELECT psn_title_id FROM game_copies WHERE game_id = ? AND psn_title_id IS NOT NULL')
    .bind(gameId).all<{ psn_title_id: string }>();
  const have = new Set(existing.results.map(r => r.psn_title_id));
  const toAdd = c.copies.filter(x => !have.has(x.title_id));
  if (toAdd.length) {
    await db.batch(toAdd.map(x => db.prepare(`
      INSERT INTO game_copies (game_id, platform, format, psn_title_id, psn_product_id, store, acquired_at, is_free, source, created_at, updated_at)
      VALUES (?, ?, 'digital', ?, ?, 'PlayStation Store', ?, ?, 'psn', ?, ?)`)
      .bind(gameId, x.platform, x.title_id, x.product_id, x.acquired_at, x.is_free ? 1 : 0, now, now)));
  }

  await linkListsToGame(env, gameId!);
  return { game_id: gameId!, title, created, copies_added: toAdd.length, igdb };
}

// ── DLC ──────────────────────────────────────────────────────────────────────

/** Guarda los DLC (sin duplicar) y enlaza los que no tienen juego. Unas 5 consultas. */
export async function saveDlcs(env: Env, dlcs: PsnDlc[]): Promise<{ saved: number; linked: number }> {
  if (dlcs.length) {
    await env.DB.prepare(`
      INSERT INTO game_dlcs (entitlement_id, psn_title_id, name, platform, acquired_at, icon_url)
      SELECT json_extract(value, '$.entitlement_id'), json_extract(value, '$.title_id'), json_extract(value, '$.name'),
             json_extract(value, '$.platform'), json_extract(value, '$.acquired_at'), json_extract(value, '$.icon_url')
      FROM json_each(?) WHERE true
      ON CONFLICT(entitlement_id) DO UPDATE SET name = excluded.name, icon_url = COALESCE(excluded.icon_url, game_dlcs.icon_url)`)
      .bind(JSON.stringify(dlcs)).run();
  }
  return { saved: dlcs.length, linked: await linkDlcs(env.DB) };
}

/**
 * Enlaza los DLC sueltos con su juego: por el titleId de una copia digital y,
 * si no, por el título del juego al principio del nombre de algún DLC del
 * mismo titleId (gana el título más largo: "Batman: Arkham Knight" antes que "Batman").
 */
export async function linkDlcs(db: D1Database): Promise<number> {
  const [loose, copies, games] = await Promise.all([
    db.prepare('SELECT id, psn_title_id, name FROM game_dlcs WHERE game_id IS NULL')
      .all<{ id: number; psn_title_id: string; name: string }>(),
    db.prepare('SELECT DISTINCT psn_title_id, game_id FROM game_copies WHERE psn_title_id IS NOT NULL')
      .all<{ psn_title_id: string; game_id: number }>(),
    db.prepare('SELECT id, title FROM games').all<{ id: number; title: string }>(),
  ]);
  if (!loose.results.length) return 0;
  const byTitleId = new Map(copies.results.map(r => [r.psn_title_id, r.game_id]));
  const keys = games.results.map(g => ({ id: g.id, key: titleKey(g.title) })).filter(g => g.key.length >= 4)
    .sort((a, b) => b.key.length - a.key.length);

  const groups = new Map<string, { id: number; name: string }[]>();
  for (const d of loose.results) groups.set(d.psn_title_id, [...(groups.get(d.psn_title_id) ?? []), d]);

  const links: { id: number; game_id: number }[] = [];
  for (const [tid, items] of groups) {
    let gameId = byTitleId.get(tid) ?? null;
    if (!gameId) {
      const names = items.map(i => titleKey(i.name));
      gameId = keys.find(g => names.some(n => n.startsWith(g.key)))?.id ?? null;
    }
    if (gameId) items.forEach(i => links.push({ id: i.id, game_id: gameId! }));
  }
  if (!links.length) return 0;
  await db.prepare(`
    UPDATE game_dlcs SET game_id = j.game_id
    FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.game_id') AS game_id FROM json_each(?)) AS j
    WHERE game_dlcs.id = j.id`).bind(JSON.stringify(links)).run();
  return links.length;
}
