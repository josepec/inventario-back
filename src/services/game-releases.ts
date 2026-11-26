import { Env } from '../types';
import { IgdbRelease, releaseCalendar, releaseInfo } from './igdb';

/**
 * Videojuegos, fase 5: calendario de lanzamientos y "Lo quiero" (migrations/0021).
 *
 * El calendario sale de IGDB (lo que sale en PS4/PS5 en Europa o en todo el
 * mundo) y se guarda en settings 12 horas: así abrir Novedades no llama a IGDB
 * cada vez y apenas lee D1 (una fila).
 */

const CACHE_KEY = 'game_releases';
const CACHE_HOURS = 12;
/** Desde hace dos semanas (lo que acaba de salir) hasta dentro de seis meses. */
const PAST_DAYS = 14;
const FUTURE_DAYS = 183;

export interface WishlistRow {
  id: number;
  igdb_id: number;
  title: string;
  cover_url: string | null;
  platforms: string | null;
  franchise: string | null;
  release_date: string | null;
  release_precision: number | null;
  notes: string | null;
  added_at: string;
}

/** Un lanzamiento con lo que importa de tu colección: si lo tienes, si lo quieres, si es de tus sagas. */
export interface AnnotatedRelease extends IgdbRelease {
  owned_id: number | null;
  wanted: boolean;
  my_saga: string | null;
}

async function calendar(env: Env): Promise<IgdbRelease[]> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(CACHE_KEY).first<{ value: string }>();
  if (row) {
    try {
      const c = JSON.parse(row.value) as { at: number; data: IgdbRelease[] };
      if (Date.now() - c.at < CACHE_HOURS * 3600 * 1000) return c.data;
    } catch { /* se vuelve a pedir */ }
  }
  const now = Math.floor(Date.now() / 1000);
  const data = await releaseCalendar(env, now - PAST_DAYS * 86400, now + FUTURE_DAYS * 86400);
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(CACHE_KEY, JSON.stringify({ at: Date.now(), data })).run();
  return data;
}

/** Las sagas de tu colección (franquicia de IGDB), en minúsculas para comparar. */
async function context(env: Env) {
  const [owned, wanted, sagas] = await Promise.all([
    env.DB.prepare('SELECT id, igdb_id FROM games WHERE igdb_id IS NOT NULL').all<{ id: number; igdb_id: number }>(),
    env.DB.prepare('SELECT igdb_id FROM game_wishlist').all<{ igdb_id: number }>(),
    env.DB.prepare("SELECT DISTINCT franchise FROM games WHERE franchise IS NOT NULL AND franchise != ''").all<{ franchise: string }>(),
  ]);
  return {
    owned: new Map(owned.results.map(r => [r.igdb_id, r.id])),
    wanted: new Set(wanted.results.map(r => r.igdb_id)),
    sagas: new Map(sagas.results.map(r => [r.franchise.toLowerCase(), r.franchise])),
  };
}

export async function annotatedCalendar(env: Env): Promise<AnnotatedRelease[]> {
  const [data, ctx] = await Promise.all([calendar(env), context(env)]);
  return data.map(r => ({
    ...r,
    owned_id: ctx.owned.get(r.igdb_id) ?? null,
    wanted: ctx.wanted.has(r.igdb_id),
    my_saga: r.sagas.map(s => ctx.sagas.get(s.toLowerCase())).find(Boolean) ?? null,
  }));
}

export async function listWishlist(env: Env): Promise<WishlistRow[]> {
  // Lo que ya tienes (dado de alta por cualquier camino: a mano, escáner, PSN) sale de la lista.
  await env.DB.prepare('DELETE FROM game_wishlist WHERE igdb_id IN (SELECT igdb_id FROM games WHERE igdb_id IS NOT NULL)').run();
  const rows = await env.DB.prepare(`
    SELECT * FROM game_wishlist
    ORDER BY release_date IS NULL, release_date, added_at DESC`).all<WishlistRow>();
  return rows.results;
}

/** Añade (o actualiza) un juego de IGDB en "Lo quiero" con su salida en PlayStation. */
export async function addToWishlist(env: Env, igdbId: number): Promise<WishlistRow | null> {
  const [r] = await releaseInfo(env, [igdbId]);
  if (!r) return null;
  await upsert(env, [r]);
  return env.DB.prepare('SELECT * FROM game_wishlist WHERE igdb_id = ?').bind(igdbId).first<WishlistRow>();
}

async function upsert(env: Env, rows: IgdbRelease[]): Promise<void> {
  if (!rows.length) return;
  await env.DB.prepare(`
    INSERT INTO game_wishlist (igdb_id, title, cover_url, platforms, franchise, release_date, release_precision)
    SELECT json_extract(value, '$.igdb_id'), json_extract(value, '$.title'), json_extract(value, '$.cover_url'),
      json_extract(value, '$.platforms'), json_extract(value, '$.franchise'),
      json_extract(value, '$.date'), json_extract(value, '$.precision')
    FROM json_each(?) WHERE true
    ON CONFLICT(igdb_id) DO UPDATE SET
      title = excluded.title, cover_url = COALESCE(excluded.cover_url, game_wishlist.cover_url),
      platforms = excluded.platforms, franchise = COALESCE(excluded.franchise, game_wishlist.franchise),
      release_date = excluded.release_date, release_precision = excluded.release_precision,
      updated_at = datetime('now')`)
    .bind(JSON.stringify(rows.map(r => ({
      igdb_id: r.igdb_id, title: r.title, cover_url: r.cover_url, platforms: r.platforms.join(',') || null,
      franchise: r.sagas[0] ?? null, date: r.date, precision: r.precision,
    })))).run();
}

/**
 * Cron diario: vuelve a pedir la salida de todo "Lo quiero" (los retrasos y
 * las fechas concretas llegan tarde). Una llamada a IGDB y una escritura.
 */
export async function refreshWishlist(env: Env): Promise<{ checked: number }> {
  const ids = await env.DB.prepare('SELECT igdb_id FROM game_wishlist').all<{ igdb_id: number }>();
  if (!ids.results.length) return { checked: 0 };
  const rows = await releaseInfo(env, ids.results.map(r => r.igdb_id));
  await upsert(env, rows);
  return { checked: rows.length };
}
