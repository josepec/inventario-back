import { Env } from '../types';
import { matchIgdb } from './psn-library';
import { PS_PLATFORMS, PsPlatform } from './igdb';

/**
 * Lista de deseos de la PlayStation Store → "Lo quiero" (fase 5).
 *
 * La web de la biblioteca (library.playstation.com/wishlist) la pide a la API
 * GraphQL de la Store con la consulta storeRetrieveWishlist (sacada de su
 * código el 26/11/2026). Esa API trabaja con consultas persistidas: se manda
 * el nombre y el sha256 del texto de la consulta tal como lo imprime Apollo. El
 * texto exacto no se pudo confirmar desde el navegador, así que se prueban las
 * variantes razonables (con y sin los __typename que añade la caché de Apollo)
 * y, si ninguna vale, la consulta entera. El log dice cuál funcionó.
 *
 * El token lo da el Worker Trofeos por RPC, como en compras y trofeos.
 */

const GRAPHQL = 'https://web.np.playstation.com/api/graphql/v1/op';
const OPERATION = 'storeRetrieveWishlist';
/**
 * El hash que usa la web de verdad (sacado de su petición el 26/11/2026; la web
 * imprime la consulta a su manera y no sale de calcularlo). Si Sony lo cambia,
 * se prueban después las variantes calculadas y el log dice cuál valió.
 */
const KNOWN_HASH = '1fa88dd6c70279e3d914f7ba535b2558a7e45821d030cb2a63a8e450963d12c3';

/** La consulta de la web, sin lo de precios (no hace falta y es igual de válida para el hash: se prueba también la original). */
const QUERY_LINES = [
  'query storeRetrieveWishlist {',
  'storeWishlistSecure {',
  'id', 'name', 'platforms',
  'boxArt {', 'type', 'role', 'url', 'media {', 'role', 'type', 'url', '}', '}',
  'price {', 'basePrice', 'discountedPrice', 'discountText', 'isFree', 'isExclusive', 'isTiedToSubscription',
  'serviceBranding', 'upsellText', 'upsellServiceBranding', '}',
  '... on Product {', 'localizedStoreDisplayClassification', 'webctas {', 'price {', 'discountText', 'upsellText', '}', '}', '}',
  '__typename',
  '}',
  '}',
];

/** Como graphql-js print: dos espacios por nivel. */
function print(lines: string[]): string {
  let depth = 0;
  return lines.map(l => {
    if (l === '}') depth--;
    const s = '  '.repeat(depth) + l;
    if (l.endsWith('{')) depth++;
    return s;
  }).join('\n');
}

/** Lo que hace la caché de Apollo (addTypename): __typename en cada selección salvo la raíz, sin repetirlo. */
function withTypename(lines: string[]): string[] {
  const out: string[] = [];
  const stack: { depth: number; has: boolean }[] = [];
  for (const l of lines) {
    if (l === '}') {
      const sel = stack.pop()!;
      if (sel.depth > 0 && !sel.has) out.push('__typename');
      out.push(l);
      continue;
    }
    if (l === '__typename' && stack.length) stack[stack.length - 1].has = true;
    out.push(l);
    if (l.endsWith('{')) stack.push({ depth: stack.length, has: false });
  }
  return out;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

interface StoreProduct {
  id: string;
  name: string;
  platforms?: string[];
  boxArt?: { url?: string; role?: string; media?: { role?: string; type?: string; url?: string }[] } | null;
}

export interface PsnWish {
  product_id: string;
  name: string;
  platforms: PsPlatform[];
  cover_url: string | null;
  igdb_id: number | null;
  owned_id: number | null;
  wanted: boolean;
}

async function fetchWishlist(token: string): Promise<StoreProduct[]> {
  const headers = {
    Authorization: `Bearer ${token}`, 'Accept-Language': 'es-ES', 'x-psn-store-locale-override': 'es-ES',
    'Content-Type': 'application/json',
  };
  const tried: string[] = [];
  const variants: [string, string | null][] = [
    ['web', null], ['typename', print(withTypename(QUERY_LINES))], ['plain', print(QUERY_LINES)],
  ];
  for (const [label, text] of variants) {
    const hash = text == null ? KNOWN_HASH : await sha256(text);
    const qs = new URLSearchParams({
      operationName: OPERATION, variables: '{}',
      extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
    });
    const res = await fetch(`${GRAPHQL}?${qs}`, { headers });
    const j = await res.json<{ data?: { storeWishlistSecure?: StoreProduct[] }; errors?: { message: string }[] }>().catch(() => null);
    if (res.ok && j?.data?.storeWishlistSecure) {
      console.log(`deseados PSN: hash ${label} ok (${hash})`);
      return j.data.storeWishlistSecure;
    }
    tried.push(`${label} ${res.status} ${j?.errors?.map(e => e.message).join('; ') ?? ''}`.trim());
    if (res.status === 401 || res.status === 403) break;   // el token no vale: no sirve seguir probando
  }
  // Último intento: la consulta entera (si la API no exige consultas registradas).
  const res = await fetch(GRAPHQL, {
    method: 'POST', headers,
    body: JSON.stringify({ operationName: OPERATION, variables: {}, query: print(withTypename(QUERY_LINES)) }),
  });
  const j = await res.json<{ data?: { storeWishlistSecure?: StoreProduct[] }; errors?: { message: string }[] }>().catch(() => null);
  if (res.ok && j?.data?.storeWishlistSecure) {
    console.log('deseados PSN: consulta entera ok');
    return j.data.storeWishlistSecure;
  }
  tried.push(`query ${res.status} ${j?.errors?.map(e => e.message).join('; ') ?? ''}`.trim());
  throw new Error(`PSN no da la lista de deseos (${tried.join(' | ')})`);
}

const STORE_PLATFORMS = new Set(Object.keys(PS_PLATFORMS));

function coverOf(p: StoreProduct): string | null {
  const media = p.boxArt?.media ?? [];
  return media.find(m => m.role === 'MASTER' && m.url)?.url ?? p.boxArt?.url ?? media.find(m => m.url)?.url ?? null;
}

/** Tus deseados de la PS Store, cada uno con su juego de IGDB (si se encuentra) y si ya lo tienes o lo quieres. */
export async function readPsnWishlist(env: Env): Promise<PsnWish[]> {
  if (!env.TROFEOS) throw new Error('Falta el binding TROFEOS (wrangler.toml)');
  const products = await fetchWishlist(await env.TROFEOS.tokenAcceso());

  const [owned, wanted] = await Promise.all([
    env.DB.prepare('SELECT id, igdb_id FROM games WHERE igdb_id IS NOT NULL').all<{ id: number; igdb_id: number }>(),
    env.DB.prepare('SELECT igdb_id FROM game_wishlist').all<{ igdb_id: number }>(),
  ]);
  const ownedBy = new Map(owned.results.map(r => [r.igdb_id, r.id]));
  const wantedIds = new Set(wanted.results.map(r => r.igdb_id));

  // Unas decenas como mucho: se buscan en IGDB de 4 en 4 (límite de IGDB: 4 por segundo).
  const out: PsnWish[] = [];
  for (let i = 0; i < products.length; i += 4) {
    out.push(...await Promise.all(products.slice(i, i + 4).map(async p => {
      const platforms = (p.platforms ?? []).filter(x => STORE_PLATFORMS.has(x)) as PsPlatform[];
      const igdb = await matchIgdb(env, p.name, platforms.includes('PS5') ? 'PS5' : platforms[0] ?? null, null)
        .catch(err => { console.error('deseados PSN, IGDB:', p.name, err); return null; });
      return {
        product_id: p.id, name: p.name, platforms, cover_url: coverOf(p),
        igdb_id: igdb, owned_id: igdb ? ownedBy.get(igdb) ?? null : null, wanted: igdb ? wantedIds.has(igdb) : false,
      };
    })));
  }
  return out;
}
