import { safeFetch, stripHtml } from './book-sources';
import { PsPlatform } from './igdb';

/**
 * Del código de barras de un juego físico al nombre del producto.
 *
 * Ningún catálogo de juegos se puede consultar por EAN gratis y con buena
 * cobertura de PAL España, así que se combinan dos:
 *   - el buscador de Amazon.es (como en libros, responde a los Workers): es el
 *     que mejor conoce las ediciones españolas y titula en castellano;
 *   - UPCitemdb (prueba gratuita, 100 consultas al día, sin clave): de reserva.
 * El título que dan es el del producto ("Assassins Creed - Playstation 3 - Pal
 * Spain..."), así que se limpia para buscarlo en IGDB y se aprovecha para sacar
 * la plataforma.
 */

export interface BarcodeProduct {
  /** Título tal cual lo da la tienda, para enseñarlo. */
  raw: string;
  /** Nombre del producto sin plataforma, región ni marca; conserva la edición
   *  ("God of War Ragnarök Edición Lanzamiento"). El front saca la edición
   *  comparándolo con el título de IGDB que se elija. */
  name: string;
  /** Lo que se busca en IGDB: el nombre sin la edición. */
  title: string;
  platform: PsPlatform | null;
  source: 'amazon' | 'upcitemdb';
  /** ASIN del producto en Amazon.es: IGDB lo tiene enlazado a su juego (exacto, sin depender del nombre). */
  asin?: string | null;
}

export function cleanEan(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** EAN-8, UPC-A (12) o EAN-13 con su dígito de control correcto. */
export function isValidEan(code: string): boolean {
  if (![8, 12, 13].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  // Desde la derecha, pesos 3,1,3,1... (vale para las tres longitudes)
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

// "PS5", "PS 4", "PlayStation 3", "Playstation2", "PSP", "PlayStation Portable", "PSX"
const PLATFORM_SRC = String.raw`\b(?:p(?:lay)?\s?s(?:tation)?\s?([1-5])|psp|playstation\s+portable|psx|psone|ps\s?one)\b`;
const PLATFORM_RE = new RegExp(PLATFORM_SRC, 'i');

function platformOf(text: string): PsPlatform | null {
  const m = text.match(PLATFORM_RE);
  if (!m) return null;
  if (m[1]) return `PS${m[1]}` as PsPlatform;
  return /psp|portable/i.test(m[0]) ? 'PSP' : 'PS1';
}

/** Lo que sobra en el título de un producto y no es parte del nombre del juego. */
const NOISE = [
  /\bpal\b/gi, /\bregion\s+free\b/gi, /\bimport(?:ación)?\b/gi, /\bespa[nñ]ol[a]?\b/gi, /\bspain\b/gi,
  /\b(?:video)?juego\b/gi, /\bvideo\s?game\b/gi, /\bcompletely\s+in\s+spanish\b/gi,
  /\bsony(?:\s+interactive(?:\s+entertainment)?)?\b/gi, /\bnuevo\b|\bprecintado\b/gi,
  /\b(?:restored|refurbished|renewed|reacondicionado|usado|used)\b/gi,
  /\bedici[oó]n\s+est[aá]ndar\b|\bstandard\s+edition\b/gi,
];

/** Ediciones y reediciones: se quitan para buscar en IGDB. */
const EDITION = [
  /(?<![\p{L}\d])edici[oó]n\s+[\p{L}\d]+(?:\s+(?:de|del)\s+[\p{L}\d]+)?/giu,
  /(?<![\p{L}\d])(?:game\s+of\s+the\s+year|[\p{L}\d']+)\s+edition\b/giu,
  /\bgoty\b/gi, /\b(?:platinum|essentials|greatest\s+hits|playstation\s+hits|ps\s+hits)\b/gi,
];

const tidy = (t: string) => t.replace(/\s+/g, ' ').replace(/^[\s:\-–,.]+|[\s:\-–,.]+$/g, '').trim();

export function parseProductTitle(raw: string): Omit<BarcodeProduct, 'source'> {
  const decoded = raw.replace(/&acute;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const text = (stripHtml(decoded) ?? decoded).replace(/[´`’]/g, "'");
  const platform = platformOf(text);

  let t = text
    .replace(/^\s*sony[^,]*,\s*/i, '')           // "Sony, Gran Turismo 7 ..." (Amazon)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');       // "(PS5)", "[Spanish Import]"
  // El nombre va delante: se corta en la plataforma o en el primer separador.
  const cut = t.search(new RegExp(String.raw`${PLATFORM_SRC}|\s[-–—|]\s|,`, 'i'));
  if (cut > 2) t = t.slice(0, cut);
  for (const re of NOISE) t = t.replace(re, ' ');
  const name = tidy(t) || text;

  let title = name;
  for (const re of EDITION) title = title.replace(re, ' ');
  title = tidy(title) || name;

  return { raw: text, name, title, platform };
}

// ── Fuentes ──────────────────────────────────────────────────────────────────

async function amazonTitle(ean: string): Promise<{ title: string; asin: string | null } | null> {
  const res = await safeFetch(`https://www.amazon.es/s?k=${ean}&i=videogames`, {
    headers: { Accept: 'text/html', 'Accept-Language': 'es-ES,es;q=0.9' },
  });
  if (!res || !res.ok) return null;
  const html = await res.text();
  if (html.length < 50000 && /captcha/i.test(html)) return null;
  // Sin coincidencias Amazon rellena con sugerencias que no son ese producto.
  if (/No hay resultados para|No results for/i.test(html)) return null;
  // El primer resultado de verdad (los patrocinados llevan AdHolder).
  const blocks = html.split('data-component-type="s-search-result"').slice(1);
  for (const b of blocks) {
    if (/AdHolder|s-sponsored/i.test(b.slice(0, 3000))) continue;
    const h2 = b.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
    const title = stripHtml(h2 ?? b.match(/<h2\b[^>]*aria-label="([^"]+)"/i)?.[1]);
    // El ASIN, del enlace al producto (/dp/B0...).
    const asin = b.match(/\/dp\/(B[0-9A-Z]{9})/)?.[1] ?? null;
    if (title) return { title, asin };
  }
  return null;
}

async function upcItemDbTitle(ean: string): Promise<string | null> {
  const res = await safeFetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${ean}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res || !res.ok) return null;
  const j = await res.json<{ items?: { title?: string; offers?: { title?: string }[] }[] }>().catch(() => null);
  const item = j?.items?.[0];
  return item?.title || item?.offers?.find(o => o.title)?.title || null;
}

/** Producto de un EAN, o null si ninguna fuente lo conoce. */
export async function lookupGameBarcode(ean: string): Promise<BarcodeProduct | null> {
  const [amazon, upc] = await Promise.all([
    amazonTitle(ean).catch(() => null),
    upcItemDbTitle(ean).catch(() => null),
  ]);
  // Amazon suele decir la plataforma; si no, se toma la de UPCitemdb.
  const a = amazon ? parseProductTitle(amazon.title) : null;
  const u = upc ? parseProductTitle(upc) : null;
  if (a) return { ...a, platform: a.platform ?? u?.platform ?? null, source: 'amazon', asin: amazon!.asin };
  if (u) return { ...u, source: 'upcitemdb' };
  return null;
}
