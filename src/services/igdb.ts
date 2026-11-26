import { Env } from '../types';

/**
 * IGDB (Twitch): fichas de juegos, portadas y fechas de salida.
 *
 * Se entra con una app de Twitch (IGDB_CLIENT_ID / IGDB_CLIENT_SECRET, tipo
 * "Confidencial") por client credentials: el token dura ~65 días y se pide
 * otro solo, sin intervención. Se guarda en `settings` para no pedir uno en
 * cada petición (cada Worker arranca sin memoria).
 */

const TOKEN_KEY = 'igdb_token';
const MARGIN_MS = 24 * 3600 * 1000;

/** Plataformas de PlayStation que cubre la sección, con su id en IGDB. */
export const PS_PLATFORMS = { PS1: 7, PS2: 8, PS3: 9, PS4: 48, PS5: 167, PSP: 38 } as const;
export type PsPlatform = keyof typeof PS_PLATFORMS;
/**
 * Los juegos de PS VR van en IGDB en su propia plataforma (PlayStation VR 165,
 * PlayStation VR2 390), no en PS4/PS5: sin ellas Moss o VR Worlds no salen.
 * Cuentan como la consola en la que se juegan.
 */
const VR_PLATFORMS: Record<number, PsPlatform> = { 165: 'PS4', 390: 'PS5' };
const PLATFORM_BY_ID = new Map<number, PsPlatform>([
  ...Object.entries(PS_PLATFORMS).map(([k, v]) => [v, k as PsPlatform] as [number, PsPlatform]),
  ...Object.entries(VR_PLATFORMS).map(([k, v]) => [Number(k), v] as [number, PsPlatform]),
]);
const PS_IDS = [...Object.values(PS_PLATFORMS), ...Object.keys(VR_PLATFORMS)].join(',');

/**
 * Tipos de ficha que son un juego que se compra: principal, pack, expansión
 * independiente, remake, remaster, versión ampliada y port. Fuera los DLC, las
 * expansiones que piden el juego base, episodios, temporadas, mods y updates.
 */
const GAME_TYPES = '0,3,4,8,9,10,11';
const GAME_TYPE_LABEL: Record<number, string> = {
  3: 'Pack', 4: 'Expansión independiente', 8: 'Remake', 9: 'Remaster', 10: 'Versión ampliada', 11: 'Port',
};

/** IGDB da los géneros en inglés. */
const GENRES_ES: Record<string, string> = {
  'Adventure': 'Aventura', 'Role-playing (RPG)': 'Rol', 'Shooter': 'Disparos', 'Platform': 'Plataformas',
  'Puzzle': 'Puzle', 'Racing': 'Conducción', 'Sport': 'Deportes', 'Fighting': 'Lucha',
  'Strategy': 'Estrategia', 'Real Time Strategy (RTS)': 'Estrategia en tiempo real',
  'Turn-based strategy (TBS)': 'Estrategia por turnos', 'Tactical': 'Táctica', 'Simulator': 'Simulación',
  "Hack and slash/Beat 'em up": "Hack and slash / Beat 'em up", 'Music': 'Música', 'Arcade': 'Arcade',
  'Indie': 'Indie', 'Point-and-click': 'Aventura gráfica', 'Visual Novel': 'Novela visual',
  'Card & Board Game': 'Cartas y tablero', 'Quiz/Trivia': 'Preguntas', 'Pinball': 'Pinball', 'MOBA': 'MOBA',
};

type IgdbEnv = Pick<Env, 'DB' | 'IGDB_CLIENT_ID' | 'IGDB_CLIENT_SECRET'>;

async function token(env: IgdbEnv): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(TOKEN_KEY)
    .first<{ value: string }>();
  if (row) {
    try {
      const t = JSON.parse(row.value) as { token: string; expires: number };
      if (t.expires - MARGIN_MS > Date.now()) return t.token;
    } catch { /* se pide otro */ }
  }
  if (!env.IGDB_CLIENT_ID || !env.IGDB_CLIENT_SECRET) throw new Error('Faltan IGDB_CLIENT_ID / IGDB_CLIENT_SECRET');

  const qs = new URLSearchParams({
    client_id: env.IGDB_CLIENT_ID, client_secret: env.IGDB_CLIENT_SECRET, grant_type: 'client_credentials',
  });
  const r = await fetch(`https://id.twitch.tv/oauth2/token?${qs}`, { method: 'POST' });
  const j = await r.json<{ access_token?: string; expires_in?: number }>().catch(() => ({} as { access_token?: string; expires_in?: number }));
  if (!r.ok || !j.access_token) throw new Error(`Twitch no da token para IGDB (${r.status})`);

  const value = JSON.stringify({ token: j.access_token, expires: Date.now() + Number(j.expires_in ?? 0) * 1000 });
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(TOKEN_KEY, value).run();
  return j.access_token;
}

async function query<T>(env: IgdbEnv, endpoint: string, body: string): Promise<T[]> {
  const send = async (tk: string) => fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: 'POST',
    headers: { 'Client-ID': env.IGDB_CLIENT_ID!, Authorization: `Bearer ${tk}` },
    body,
  });
  let r = await send(await token(env));
  if (r.status === 401) {
    // Token revocado antes de tiempo: se olvida y se pide otro, una vez.
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(TOKEN_KEY).run();
    r = await send(await token(env));
  }
  if (!r.ok) throw new Error(`IGDB ${r.status} en ${endpoint}`);
  return r.json<T[]>();
}

// ── Tipos de IGDB (solo lo que se pide) ──────────────────────────────────────

interface IgdbGame {
  id: number;
  name: string;
  game_type?: number;
  first_release_date?: number;
  cover?: { image_id: string };
  platforms?: number[];
  summary?: string;
  url?: string;
  genres?: { name: string }[];
  involved_companies?: { company?: { name: string }; developer?: boolean; publisher?: boolean }[];
  franchises?: { name: string }[];
  collections?: { name: string }[];
  release_dates?: { date?: number; platform?: number; release_region?: { region: string } }[];
}

// ── Normalizado ──────────────────────────────────────────────────────────────

export interface IgdbSearchResult {
  igdb_id: number;
  title: string;
  year: number | null;
  cover_url: string | null;
  platforms: PsPlatform[];
  kind: string | null;            // Remaster, Remake... null = juego principal
}

export interface IgdbGameDetail {
  igdb_id: number;
  title: string;
  cover_url: string | null;
  summary: string | null;
  genres: string | null;
  developer: string | null;
  publisher: string | null;
  franchise: string | null;
  first_release_date: string | null;
  igdb_url: string | null;
  platforms: PsPlatform[];
  /** Fecha de salida por plataforma de PlayStation: europea si la hay, si no la mundial. */
  release_dates: Partial<Record<PsPlatform, string>>;
}

const cover = (c?: { image_id: string }, size = 't_cover_big_2x') =>
  c ? `https://images.igdb.com/igdb/image/upload/${size}/${c.image_id}.jpg` : null;
const isoDate = (unix?: number) => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : null);
const psPlatforms = (ids?: number[]) =>
  [...new Set((ids ?? []).map(id => PLATFORM_BY_ID.get(id)).filter((p): p is PsPlatform => !!p))]
    .sort((a, b) => Object.keys(PS_PLATFORMS).indexOf(a) - Object.keys(PS_PLATFORMS).indexOf(b));
/** El buscador de IGDB no admite comillas dentro del texto. */
const clean = (q: string) => q.replace(/["\\]/g, ' ').trim().slice(0, 100);

export async function searchGames(env: IgdbEnv, q: string): Promise<IgdbSearchResult[]> {
  const text = clean(q);
  if (!text) return [];
  const rows = await query<IgdbGame>(env, 'games',
    `search "${text}"; fields name,game_type,first_release_date,cover.image_id,platforms; ` +
    `where platforms = (${PS_IDS}) & game_type = (${GAME_TYPES}); limit 20;`);
  return rows.map(g => ({
    igdb_id: g.id,
    title: g.name,
    year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
    cover_url: cover(g.cover, 't_cover_small_2x'),
    platforms: psPlatforms(g.platforms),
    kind: g.game_type != null ? GAME_TYPE_LABEL[g.game_type] ?? null : null,
  }));
}

/**
 * Juegos cuyo nombre alternativo es exactamente ese (sin distinguir
 * mayúsculas). IGDB guarda así algunos títulos en castellano ("Ape Escape: La
 * Invasión de los Monos", comentario "Spanish title"); el buscador no los ve.
 */
export async function findByAlternativeName(env: IgdbEnv, name: string): Promise<number[]> {
  const text = clean(name);
  if (!text) return [];
  const rows = await query<{ game?: number }>(env, 'alternative_names', `fields game; where name ~ "${text}"; limit 5;`);
  return [...new Set(rows.map(r => r.game).filter((g): g is number => typeof g === 'number'))];
}

/**
 * Nombres alternativos de varios juegos a la vez (abreviaturas, títulos en
 * castellano: "Uncharted 2: El reino de los ladrones", "Skyrim", "GTA IV").
 * Pocas llamadas: hasta 500 nombres por petición.
 */
export async function alternativeNames(env: IgdbEnv, igdbIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const ids = [...new Set(igdbIds.filter(n => Number.isInteger(n) && n > 0))];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).join(',');
    for (let offset = 0; offset < 5000; offset += 500) {
      const rows = await query<{ game?: number; name?: string }>(env, 'alternative_names',
        `fields game,name; where game = (${chunk}); limit 500; offset ${offset};`);
      for (const r of rows) {
        if (typeof r.game !== 'number' || !r.name) continue;
        const list = out.get(r.game) ?? [];
        list.push(r.name);
        out.set(r.game, list);
      }
      if (rows.length < 500) break;
    }
  }
  return out;
}

/**
 * El juego (y la plataforma) de un producto de Amazon por su ASIN: IGDB
 * enlaza cada edición de cada tienda de Amazon (Amazon.es incluida) con su
 * juego. Es la forma exacta de ir del código de barras al juego.
 */
export async function findByAsin(env: IgdbEnv, asin: string): Promise<{ igdb_id: number; platform: PsPlatform | null } | null> {
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null;
  const rows = await query<{ game?: number; platform?: number }>(env, 'external_games',
    `fields game,platform; where uid = "${asin}" & external_game_source = 20; limit 5;`);
  const r = rows.find(x => typeof x.game === 'number');
  return r ? { igdb_id: r.game!, platform: r.platform != null ? PLATFORM_BY_ID.get(r.platform) ?? null : null } : null;
}

/** Todas las portadas de un juego en IGDB (la principal y las regionales), a resolución original. */
export async function gameCovers(env: IgdbEnv, igdbId: number): Promise<{ url: string; regional: boolean }[]> {
  const rows = await query<{ image_id?: string; game_localization?: number }>(env, 'covers',
    `fields image_id,game_localization; where game = ${Math.trunc(igdbId)}; limit 20;`);
  return rows.filter(r => r.image_id).map(r => ({
    url: cover({ image_id: r.image_id! }, 't_original')!,
    regional: !!r.game_localization,
  }));
}

export async function gameDetail(env: IgdbEnv, id: number): Promise<IgdbGameDetail | null> {
  const [g] = await query<IgdbGame>(env, 'games',
    'fields name,summary,url,first_release_date,cover.image_id,platforms,genres.name,' +
    'involved_companies.company.name,involved_companies.developer,involved_companies.publisher,' +
    'franchises.name,collections.name,release_dates.date,release_dates.platform,release_dates.release_region.region; ' +
    `where id = ${Math.trunc(id)};`);
  if (!g) return null;

  const companies = (role: 'developer' | 'publisher') =>
    [...new Set((g.involved_companies ?? []).filter(c => c[role] && c.company?.name).map(c => c.company!.name))]
      .join(', ') || null;

  const release_dates: Partial<Record<PsPlatform, string>> = {};
  for (const region of ['europe', 'worldwide']) {
    for (const rd of g.release_dates ?? []) {
      const p = rd.platform != null ? PLATFORM_BY_ID.get(rd.platform) : undefined;
      if (p && rd.date && rd.release_region?.region === region && !release_dates[p]) {
        release_dates[p] = isoDate(rd.date)!;
      }
    }
  }

  return {
    igdb_id: g.id,
    title: g.name,
    cover_url: cover(g.cover),
    summary: g.summary ?? null,
    genres: (g.genres ?? []).map(x => GENRES_ES[x.name] ?? x.name).join(', ') || null,
    developer: companies('developer'),
    publisher: companies('publisher'),
    franchise: g.franchises?.[0]?.name ?? g.collections?.[0]?.name ?? null,
    first_release_date: isoDate(g.first_release_date),
    igdb_url: g.url ?? null,
    platforms: psPlatforms(g.platforms),
    release_dates,
  };
}

// ── Lanzamientos (fase 5: calendario y "Lo quiero") ─────────────────────────

/** Regiones de IGDB que valen para España: Europa y mundial. */
const REGION_EUROPE = 1;
const REGION_WORLDWIDE = 8;

export interface IgdbRelease {
  igdb_id: number;
  title: string;
  cover_url: string | null;
  platforms: PsPlatform[];
  /** YYYY-MM-DD; con precisión menor que el día, IGDB pone el último del periodo. */
  date: string | null;
  /** date_format de IGDB: 0 día, 1 mes, 2 año, 3-6 trimestre, 7 sin fecha. */
  precision: number;
  /** Expectación en IGDB (cuánta gente lo sigue): sirve para quitar el ruido. */
  hypes: number;
  kind: string | null;
  /** Franquicias y colecciones, para saber si es de una saga que tienes. */
  sagas: string[];
}

interface IgdbReleaseDate {
  date?: number;
  date_format?: number;
  platform?: number;
  release_region?: number;
}

/**
 * La salida en PlayStation que cuenta: la primera de Europa en PS4/PS5 (o VR) y,
 * si no hay, la primera mundial. Con `from`, solo las de esa fecha en adelante.
 */
function psRelease(rows: IgdbReleaseDate[], from?: number): IgdbReleaseDate | null {
  const ps = rows.filter(r => r.platform != null && PLATFORM_BY_ID.has(r.platform) && (from == null || (r.date ?? 0) >= from));
  for (const region of [REGION_EUROPE, REGION_WORLDWIDE]) {
    const inRegion = ps.filter(r => r.release_region === region).sort((a, b) => (a.date ?? Infinity) - (b.date ?? Infinity));
    if (inRegion.length) return inRegion[0];
  }
  return null;
}

/**
 * Lo que sale en PS4/PS5 entre dos fechas (unix), un elemento por juego. Solo
 * juegos que se compran (sin DLC ni temporadas). Unos cientos en 6 meses: 1-3
 * llamadas.
 */
export async function releaseCalendar(env: IgdbEnv, from: number, to: number): Promise<IgdbRelease[]> {
  type Row = IgdbReleaseDate & {
    game?: { id: number; name: string; game_type?: number; hypes?: number; cover?: { image_id: string };
      franchises?: { name: string }[]; collections?: { name: string }[] };
  };
  const rows: Row[] = [];
  for (let offset = 0; offset < 3000; offset += 500) {
    const page = await query<Row>(env, 'release_dates',
      'fields date,date_format,platform,release_region,game.name,game.game_type,game.hypes,game.cover.image_id,' +
      'game.franchises.name,game.collections.name; ' +
      `where platform = (${PS_IDS}) & date >= ${Math.trunc(from)} & date < ${Math.trunc(to)} ` +
      `& release_region = (${REGION_EUROPE},${REGION_WORLDWIDE}) & game.game_type = (${GAME_TYPES}); ` +
      `sort date asc; limit 500; offset ${offset};`);
    rows.push(...page);
    if (page.length < 500) break;
  }

  const byGame = new Map<number, Row[]>();
  for (const r of rows) if (r.game) byGame.set(r.game.id, [...(byGame.get(r.game.id) ?? []), r]);
  const out: IgdbRelease[] = [];
  for (const list of byGame.values()) {
    const g = list[0].game!;
    const rel = psRelease(list);
    if (!rel) continue;
    out.push({
      igdb_id: g.id,
      title: g.name,
      cover_url: cover(g.cover),
      platforms: psPlatforms(list.map(r => r.platform!).filter(p => p != null)),
      date: isoDate(rel.date),
      precision: rel.date_format ?? 0,
      hypes: g.hypes ?? 0,
      kind: g.game_type != null ? GAME_TYPE_LABEL[g.game_type] ?? null : null,
      sagas: [...(g.franchises ?? []), ...(g.collections ?? [])].map(x => x.name),
    });
  }
  return out.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
}

/**
 * Ficha y salida en PlayStation de varios juegos (los de "Lo quiero"): la
 * próxima salida desde hace un mes (un retraso o la de Europa, que va detrás) y,
 * si ya salió todo, la primera. Hasta 500 juegos por llamada.
 */
export async function releaseInfo(env: IgdbEnv, igdbIds: number[]): Promise<IgdbRelease[]> {
  const ids = [...new Set(igdbIds.filter(n => Number.isInteger(n) && n > 0))];
  const out: IgdbRelease[] = [];
  type G = IgdbGame & { hypes?: number; release_dates?: IgdbReleaseDate[] };
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await query<G>(env, 'games',
      'fields name,game_type,hypes,cover.image_id,platforms,first_release_date,franchises.name,collections.name,' +
      'release_dates.date,release_dates.date_format,release_dates.platform,release_dates.release_region; ' +
      `where id = (${ids.slice(i, i + 500).join(',')}); limit 500;`);
    const monthAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
    for (const g of rows) {
      const rel = psRelease(g.release_dates ?? [], monthAgo) ?? psRelease(g.release_dates ?? []);
      out.push({
        igdb_id: g.id,
        title: g.name,
        cover_url: cover(g.cover),
        platforms: psPlatforms(g.platforms),
        date: rel ? isoDate(rel.date) : isoDate(g.first_release_date),
        precision: rel ? rel.date_format ?? 0 : g.first_release_date ? 0 : 7,
        hypes: g.hypes ?? 0,
        kind: g.game_type != null ? GAME_TYPE_LABEL[g.game_type] ?? null : null,
        sagas: [...(g.franchises ?? []), ...(g.collections ?? [])].map(x => x.name),
      });
    }
  }
  return out;
}
