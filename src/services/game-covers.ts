import { Env } from '../types';
import { CoverOption, safeFetch, stripHtml } from './book-sources';
import { gameCovers } from './igdb';

/**
 * Portadas para elegir a mano en la ficha de un juego (el mismo selector que
 * libros). "De tu juego" (match 'isbn'): IGDB, la PS Store de tus copias
 * digitales y Amazon.es por el EAN de tus copias físicas (la carátula española,
 * con su PEGI). "Otras" (match 'other'): Amazon.es buscando por título y los
 * iconos de tus listas de trofeos.
 */

const MAX_STORE_PRODUCTS = 2;
const MAX_EANS = 2;
const MAX_AMAZON_BY_TITLE = 4;

/**
 * La carátula vertical (PORTRAIT_BANNER, ~1440×2160) y la cuadrada (MASTER)
 * de un producto de la PS Store, sacadas de su página web.
 */
async function storeCovers(productId: string): Promise<CoverOption[]> {
  const res = await safeFetch(`https://store.playstation.com/es-es/product/${encodeURIComponent(productId)}`, {
    headers: { Accept: 'text/html', 'Accept-Language': 'es-ES,es;q=0.9' },
  });
  if (!res?.ok) return [];
  const html = await res.text();
  const role = (r: string) =>
    html.match(new RegExp(`"role":"${r}","type":"IMAGE","url":"(https://image\\.api\\.playstation\\.com/[^"]+)"`))?.[1] ?? null;
  const out: CoverOption[] = [];
  const portrait = role('PORTRAIT_BANNER');
  const master = role('MASTER');
  if (portrait) out.push({ url: portrait, source: 'PlayStation Store', bytes: 0, match: 'isbn', note: 'Carátula' });
  if (master) out.push({ url: master, source: 'PlayStation Store', bytes: 0, match: 'isbn', note: 'Cuadrada' });
  return out;
}

/**
 * Imágenes de los primeros resultados de Amazon.es (sin patrocinados), a
 * tamaño completo: se quita el sufijo de miniatura ("._AC_UY218_").
 */
async function amazonCovers(query: string, max: number, match: CoverOption['match']): Promise<CoverOption[]> {
  const res = await safeFetch(`https://www.amazon.es/s?k=${encodeURIComponent(query)}&i=videogames`, {
    headers: { Accept: 'text/html', 'Accept-Language': 'es-ES,es;q=0.9' },
  });
  if (!res?.ok) return [];
  const html = await res.text();
  if (/No hay resultados para|No results for/i.test(html)) return [];
  const out: CoverOption[] = [];
  for (const b of html.split('data-component-type="s-search-result"').slice(1)) {
    if (out.length >= max) break;
    if (/AdHolder|s-sponsored/i.test(b.slice(0, 3000))) continue;
    const img = b.match(/<img[^>]*class="s-image"[^>]*>/i)?.[0];
    const src = img?.match(/\ssrc="([^"]+)"/i)?.[1];
    if (!src || !/media-amazon\.com\/images\/I\//.test(src)) continue;
    const url = src.replace(/\._[^/]*_\.(jpe?g|png|webp)$/i, '.$1');
    const title = stripHtml(b.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1]) ?? null;
    if (!out.some(o => o.url === url)) out.push({ url, source: 'Amazon.es', bytes: 0, match, note: title });
  }
  return out;
}

export async function gameCoverOptions(env: Env, gameId: number): Promise<CoverOption[] | null> {
  const game = await env.DB.prepare('SELECT id, title, igdb_id FROM games WHERE id = ?').bind(gameId)
    .first<{ id: number; title: string; igdb_id: number | null }>();
  if (!game) return null;
  const [copies, lists] = await Promise.all([
    env.DB.prepare('SELECT platform, ean, psn_product_id FROM game_copies WHERE game_id = ?').bind(gameId)
      .all<{ platform: string; ean: string | null; psn_product_id: string | null }>(),
    env.DB.prepare('SELECT icon_url FROM game_trophy_lists WHERE game_id = ? AND icon_url IS NOT NULL').bind(gameId)
      .all<{ icon_url: string }>(),
  ]);

  const products = [...new Set(copies.results.map(c => c.psn_product_id).filter((x): x is string => !!x))].slice(0, MAX_STORE_PRODUCTS);
  const eans = [...new Set(copies.results.map(c => c.ean).filter((x): x is string => !!x))].slice(0, MAX_EANS);
  const platform = copies.results.find(c => c.platform)?.platform ?? '';

  const safe = <T>(p: Promise<T[]>) => p.catch(err => { console.error('portadas:', err); return [] as T[]; });
  const groups = await Promise.all([
    game.igdb_id
      ? safe(gameCovers(env, game.igdb_id).then(cs => cs.map((c): CoverOption => ({
          url: c.url, source: 'IGDB', bytes: 0, match: 'isbn', note: c.regional ? 'Regional' : null,
        }))))
      : Promise.resolve([]),
    ...products.map(p => safe(storeCovers(p))),
    ...eans.map(e => safe(amazonCovers(e, 1, 'isbn'))),
    safe(amazonCovers(`${game.title} ${platform}`.trim(), MAX_AMAZON_BY_TITLE, 'other')),
  ]);

  const out: CoverOption[] = [];
  for (const o of [
    ...groups.flat(),
    ...lists.results.map((l): CoverOption => ({ url: l.icon_url, source: 'Trofeos de PSN', bytes: 0, match: 'other', note: 'Icono' })),
  ]) {
    // Lo mismo por dos caminos (el EAN y el título en Amazon) sale una vez, en el grupo bueno.
    if (!out.some(x => x.url === o.url)) out.push(o);
  }
  return out;
}
