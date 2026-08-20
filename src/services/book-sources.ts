/**
 * Fuentes de metadatos de libros.
 *
 * Google Books cubre bien lo reciente y en catálogo, pero deja fuera ediciones
 * españolas antiguas o descatalogadas (librojuegos, tiradas de los 80-2000),
 * y muchas de las fichas que sí tiene vienen sin portada ni sinopsis.
 * Aquí se consultan varias fuentes en paralelo y se fusiona campo a campo.
 *
 * Cobertura observada sobre ISBNs españoles descatalogados:
 *   - Google Books  → ficha sí, portada no
 *   - Open Library  → ni ficha ni portada
 *   - CEGAL         → ficha completa si sigue en el catálogo del gremio
 *   - AbeBooks      → portada de casi todo lo que se ha vendido de segunda mano
 *   - Apple Books   → sólo lo que tiene edición digital
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

/**
 * Las fuentes se consultan en paralelo: una lenta no debe bloquear al resto.
 * Open Library ronda los 3 s de forma habitual, así que hay que dar margen.
 */
const TIMEOUT_MS = 8000;

/**
 * Ninguna de estas fuentes devuelve 404 cuando no tiene la portada: todas
 * responden 200 con una imagen de relleno, siempre del mismo tamaño exacto.
 * Sin filtrarlas acabas guardando un "image not available" como cubierta.
 */
const PLACEHOLDERS: { host: string; bytes: number }[] = [
  { host: 'cegal.es', bytes: 3963 },          // cartel de "sin cubierta"
  { host: 'books.google.com', bytes: 9103 },  // el PNG gris de "image not available"
];

/** Por debajo de esto no es una portada, es un pixel o un icono de error. */
const MIN_COVER_BYTES = 1500;

export interface BookMeta {
  googleId: string;
  title: string;
  subtitle: string | null;
  saga: string | null;
  sagaNumber: number | null;
  authors: string[];
  publisher: string | null;
  publishedDate: string | null;
  description: string | null;
  isbn: string | null;
  isbn13: string | null;
  pages: number | null;
  categories: string[];
  language: string | null;
  cover: string | null;
  price: number | null;
  currency: string | null;
  binding: string | null;
  /** Qué fuentes han aportado algo, para poder depurar desde el front. */
  sources: string[];
}

type Partial_ = Partial<BookMeta>;

// ── ISBN ──────────────────────────────────────────────────────────────────

export function cleanIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

function isbn10Valid(c: string): boolean {
  if (!/^\d{9}[\dX]$/.test(c)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += (c[i] === 'X' ? 10 : Number(c[i])) * (10 - i);
  }
  return sum % 11 === 0;
}

function isbn13Valid(c: string): boolean {
  if (!/^\d{13}$/.test(c)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(c[i]) * (i % 2 ? 3 : 1);
  return sum % 10 === 0;
}

/**
 * Los códigos de barras de libro llevan a veces un add-on de 5 dígitos con el
 * precio (EAN-13 + 5). Algunos lectores lo concatenan al ISBN.
 */
export function normalizeScan(raw: string): string {
  const c = cleanIsbn(raw);
  if (c.length === 18 && isbn13Valid(c.slice(0, 13))) return c.slice(0, 13);
  return c;
}

export function isIsbn(raw: string): boolean {
  const c = normalizeScan(raw);
  return isbn10Valid(c) || (isbn13Valid(c) && /^97[89]/.test(c));
}

/**
 * Amazon indexa sus portadas por ISBN-10, así que hace falta la conversión
 * inversa. Solo existe para el prefijo 978; los 979 no tienen equivalente.
 */
export function toIsbn10(raw: string): string | null {
  const c = normalizeScan(raw);
  if (isbn10Valid(c)) return c;
  if (!isbn13Valid(c) || !c.startsWith('978')) return null;

  const core = c.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(core[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : String(check));
}

export function toIsbn13(raw: string): string | null {
  const c = normalizeScan(raw);
  if (isbn13Valid(c)) return c;
  if (!isbn10Valid(c)) return null;
  const core = '978' + c.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + String((10 - (sum % 10)) % 10);
}

// ── Utilidades ────────────────────────────────────────────────────────────

async function safeFetch(url: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(url, {
      ...init,
      headers: { 'User-Agent': UA, ...(init.headers as Record<string, string> ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

function stripHtml(s: string | null | undefined): string | null {
  if (!s) return null;
  const text = s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
  return text || null;
}

/**
 * Google Books no tiene campo de serie: la mete entre paréntesis en el título.
 * p.ej. "Los misterios de la taberna Kamogawa (Taberna Kamogawa 1)"
 */
export function extractSeries(raw: string): { title: string; saga: string | null; sagaNumber: number | null } {
  const m = raw.match(/\s*\(([^)]+?)\s*[,#\-]?\s*(?:[Vv]ol\.?\s*|#\s*|[Nn]º\s*)?(\d+)\s*\)\s*$/);
  if (m) return { title: raw.replace(m[0], '').trim(), saga: m[1].trim(), sagaNumber: Number(m[2]) };
  return { title: raw, saga: null, sagaNumber: null };
}

// ── Portadas ──────────────────────────────────────────────────────────────

/**
 * Comprueba por HEAD que la URL devuelve una imagen de verdad. Sin esto el
 * front acaba pintando cuadros rotos: cada CDN falla a su manera (404 limpio
 * en AbeBooks, placeholder con 200 en CEGAL).
 */
async function coverExists(url: string): Promise<boolean> {
  const res = await safeFetch(url, { method: 'HEAD' });
  if (!res || !res.ok) return false;

  const len = Number(res.headers.get('content-length') ?? '0');
  if (PLACEHOLDERS.some(p => url.includes(p.host) && len === p.bytes)) return false;

  // Sin content-length no podemos descartarla; se acepta y que decida el navegador.
  return len === 0 || len >= MIN_COVER_BYTES;
}

/**
 * Candidatas de portada por ISBN, de mejor a peor.
 *
 * CEGAL va la última a propósito: solo sirve las imágenes bajo /marcadas/, que
 * llevan una marca de agua diagonal enorme más el logo de todostuslibros. Las
 * otras rutas del CDN devuelven el placeholder, así que no hay version limpia.
 * Vale como último recurso, pero cualquier otra fuente es preferible.
 */
function coverCandidates(isbn13: string | null, isbn10: string | null): string[] {
  const urls: string[] = [];

  // Amazon indexa por ISBN-10 y devuelve la cubierta de la edicion exacta, sin
  // marcas. Cuando no la tiene responde 200 con un GIF de 43 bytes, que cae
  // por debajo de MIN_COVER_BYTES.
  if (isbn10) urls.push(`https://m.media-amazon.com/images/P/${isbn10}.jpg`);
  if (isbn13) urls.push(`https://pictures.abebooks.com/isbn/${isbn13}-es._SL500_.jpg`);
  if (isbn10) urls.push(`https://pictures.abebooks.com/isbn/${isbn10}-es._SL500_.jpg`);
  if (isbn13) urls.push(`https://covers.openlibrary.org/b/isbn/${isbn13}-L.jpg?default=false`);
  if (isbn10) urls.push(`https://covers.openlibrary.org/b/isbn/${isbn10}-L.jpg?default=false`);

  // CEGAL: prefijo = 7 primeros dígitos, fichero = ISBN-13 sin dígito de control
  if (isbn13) urls.push(`https://static.cegal.es/imagenes/marcadas/${isbn13.slice(0, 7)}/${isbn13.slice(0, 12)}.gif`);

  return urls;
}

/**
 * Primera portada de la lista que exista de verdad. Se comprueban todas en
 * paralelo pero se respeta el orden de preferencia al elegir.
 */
export async function firstWorkingCover(candidates: (string | null)[]): Promise<string | null> {
  const urls = [...new Set(candidates.filter((u): u is string => !!u))];
  const checks = await Promise.all(urls.map(async url => (await coverExists(url)) ? url : null));
  return checks.find(u => u !== null) ?? null;
}

/** Primera portada que exista de verdad para un ISBN, o null. */
export async function findCover(isbn13: string | null, isbn10: string | null): Promise<string | null> {
  return firstWorkingCover(coverCandidates(isbn13, isbn10));
}

// ── Google Books ──────────────────────────────────────────────────────────

interface GBVolume {
  id: string;
  volumeInfo: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    industryIdentifiers?: { type: string; identifier: string }[];
    pageCount?: number;
    categories?: string[];
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
    language?: string;
  };
  saleInfo?: {
    listPrice?: { amount: number; currencyCode: string };
    retailPrice?: { amount: number; currencyCode: string };
  };
}

const GB_API = 'https://www.googleapis.com/books/v1/volumes';

/**
 * Sin API key Google aplica una cuota anónima *por IP*. Como los Workers salen
 * por IPs compartidas, esa cuota está agotada casi siempre y la API responde
 * 429, que antes se traducía en "no se encontraron resultados". La key es
 * gratuita: wrangler secret put GOOGLE_BOOKS_KEY
 */
function gbUrl(params: Record<string, string>, key?: string): string {
  const qs = new URLSearchParams(params);
  if (key) qs.set('key', key);
  return `${GB_API}?${qs}`;
}

export function mapGoogleVolume(v: GBVolume): BookMeta {
  const info = v.volumeInfo;
  const ids = info.industryIdentifiers ?? [];
  const isbn13 = ids.find(i => i.type === 'ISBN_13')?.identifier ?? null;
  const isbn10 = ids.find(i => i.type === 'ISBN_10')?.identifier ?? null;
  const price = v.saleInfo?.retailPrice?.amount ?? v.saleInfo?.listPrice?.amount ?? null;
  const cover = info.imageLinks?.thumbnail
    ?.replace('http://', 'https://')
    ?.replace(/zoom=\d/, 'zoom=0') ?? null;

  const series = extractSeries(info.title ?? '');

  return {
    googleId: v.id,
    title: series.title,
    subtitle: info.subtitle ?? null,
    saga: series.saga,
    sagaNumber: series.sagaNumber,
    authors: info.authors ?? [],
    publisher: info.publisher ?? null,
    publishedDate: info.publishedDate ?? null,
    description: info.description ?? null,
    isbn: isbn10,
    isbn13,
    pages: info.pageCount ?? null,
    categories: info.categories ?? [],
    language: info.language ?? null,
    cover,
    price,
    currency: v.saleInfo?.retailPrice?.currencyCode ?? v.saleInfo?.listPrice?.currencyCode ?? null,
    binding: null,
    sources: ['google'],
  };
}

export interface GoogleSearchResult {
  items: BookMeta[];
  total: number;
  error: string | null;
}

export async function googleSearch(
  q: string, opts: { start?: number; limit?: number; key?: string } = {}
): Promise<GoogleSearchResult> {
  const url = gbUrl({
    q,
    startIndex: String(opts.start ?? 0),
    maxResults: String(opts.limit ?? 20),
    printType: 'books',
    country: 'ES',
  }, opts.key);

  // Google devuelve 503 de forma esporádica (~1 de cada 5 consultas por ISBN)
  // aunque tenga la ficha. Un solo reintento lo resuelve casi siempre.
  let res = await safeFetch(url);
  if (!res || res.status >= 500) {
    await new Promise(r => setTimeout(r, 300));
    res = await safeFetch(url);
  }

  if (!res) return { items: [], total: 0, error: 'Google Books no responde' };
  if (!res.ok) {
    const detail = res.status === 429
      ? 'Google Books ha agotado la cuota (falta GOOGLE_BOOKS_KEY)'
      : `Google Books ha devuelto ${res.status}`;
    return { items: [], total: 0, error: detail };
  }

  const json = await res.json() as { totalItems?: number; items?: GBVolume[] };
  return {
    items: (json.items ?? []).map(mapGoogleVolume),
    total: json.totalItems ?? 0,
    error: null,
  };
}

async function googleByIsbn(isbn: string, key?: string): Promise<{ data: BookMeta | null; error: string | null }> {
  const res = await googleSearch(`isbn:${isbn}`, { limit: 1, key });
  return { data: res.items[0] ?? null, error: res.error };
}

// ── Open Library ──────────────────────────────────────────────────────────

interface OLDetails {
  title?: string;
  subtitle?: string;
  authors?: { name?: string }[];
  publishers?: string[];
  publish_date?: string;
  number_of_pages?: number;
  description?: string | { value?: string };
  covers?: number[];
  isbn_10?: string[];
  isbn_13?: string[];
  languages?: { key?: string }[];
  subjects?: string[];
  series?: string[];
}

async function openLibraryByIsbn(isbn: string): Promise<Partial_ | null> {
  const res = await safeFetch(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=details`
  );
  if (!res || !res.ok) return null;

  const json = await res.json() as Record<string, { details?: OLDetails }>;
  const entry = json[`ISBN:${isbn}`];
  const d = entry?.details;
  if (!d) return null;

  const desc = typeof d.description === 'string' ? d.description : d.description?.value ?? null;

  // Open Library codifica la serie como "Nombre de la serie -- 2"
  let saga: string | null = null;
  let sagaNumber: number | null = null;
  const rawSeries = d.series?.[0];
  if (rawSeries) {
    const m = rawSeries.match(/^(.*?)\s*--\s*(\d+)\s*$/);
    saga = (m ? m[1] : rawSeries).trim();
    sagaNumber = m ? Number(m[2]) : null;
  }

  return {
    title: d.title,
    subtitle: d.subtitle ?? null,
    authors: (d.authors ?? []).map(a => a.name).filter((n): n is string => !!n),
    publisher: d.publishers?.[0] ?? null,
    publishedDate: d.publish_date ?? null,
    description: stripHtml(desc),
    isbn: d.isbn_10?.[0] ?? null,
    isbn13: d.isbn_13?.[0] ?? null,
    pages: d.number_of_pages ?? null,
    categories: d.subjects ?? [],
    language: d.languages?.[0]?.key?.replace('/languages/', '') ?? null,
    saga,
    sagaNumber,
    sources: ['openlibrary'],
  };
}

// ── CEGAL (todostuslibros.com) ────────────────────────────────────────────

/**
 * Buscador de la red de librerías españolas. Es la fuente más fiable para el
 * ISBN español en catálogo: trae editorial, encuadernación, páginas y PVP.
 * No hay API pública, pero la ficha lleva un JSON-LD de schema.org/Book.
 */
async function cegalByIsbn(isbn: string): Promise<Partial_ | null> {
  const res = await safeFetch(
    `https://www.todostuslibros.com/busquedas?keyword=${encodeURIComponent(isbn)}`,
    { headers: { Accept: 'text/html' }, redirect: 'follow' }
  );
  if (!res || !res.ok) return null;

  const html = await res.text();

  // El primer JSON-LD es el breadcrumb; el que interesa es el de @type Book.
  const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  let book: any = null;
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const found = arr.find((x: any) => x['@type'] === 'Book');
      if (found) { book = found; break; }
    } catch {
      // Bloque no parseable: se ignora y se prueba el siguiente.
    }
  }
  if (!book) return null;

  const example = Array.isArray(book.workExample) ? book.workExample[0] : book.workExample;
  const price = Number(example?.offers?.[0]?.Price ?? example?.offers?.[0]?.price ?? 0);

  // La editorial sólo está en el HTML, no en el JSON-LD.
  const pubMatch = html.match(/<dt>\s*Editorial:\s*<\/dt>\s*<dd>[\s\S]*?>([^<]+)<\/a>/);

  const pages = Number(example?.numberOfPages ?? 0);
  const langMap: Record<string, string> = { spa: 'es', cat: 'ca', eng: 'en', glg: 'gl', eus: 'eu' };
  const lang = example?.inLanguage as string | undefined;

  return {
    title: book.name ?? undefined,
    authors: book.author?.name ? [book.author.name] : [],
    publisher: pubMatch ? pubMatch[1].trim() : null,
    publishedDate: typeof example?.datePublished === 'string' ? example.datePublished.slice(0, 10) : null,
    description: stripHtml(book.description),
    pages: pages > 0 ? pages : null,
    language: lang ? (langMap[lang] ?? lang) : null,
    binding: example?.bookFormat ?? null,
    price: price > 0 ? price : null,
    currency: price > 0 ? (example?.offers?.[0]?.priceCurrency ?? 'EUR') : null,
    sources: ['cegal'],
  };
}

/**
 * Búsqueda por texto en CEGAL. Es la mejor red de seguridad para títulos en
 * castellano, que es justo donde Open Library flojea. Cada resultado del
 * listado lleva los datos en atributos data-gtm-*, más estables de parsear
 * que el maquetado.
 */
async function cegalSearch(q: string, limit: number): Promise<BookMeta[]> {
  const res = await safeFetch(
    `https://www.todostuslibros.com/busquedas?keyword=${encodeURIComponent(q)}`,
    { headers: { Accept: 'text/html' }, redirect: 'follow' }
  );
  if (!res || !res.ok) return [];

  const html = await res.text();
  const items: BookMeta[] = [];

  // El <li> reparte sus atributos en varias líneas, así que se trocea por el
  // primer data-gtm de cada ficha en vez de por la etiqueta.
  const blocks = html.split('data-gtm-titulo="').slice(1);
  for (const block of blocks.slice(0, limit)) {
    const attr = (name: string) => block.match(new RegExp(`data-gtm-${name}="([^"]*)"`))?.[1] ?? null;

    const isbn13 = cleanIsbn(attr('isbn') ?? '');
    const title = stripHtml(block.slice(0, block.indexOf('"')));
    if (!title || !isbn13Valid(isbn13)) continue;

    const price = Number(attr('precio') ?? '0');
    const author = stripHtml(block.match(/<p class="author">([\s\S]*?)<\/p>/)?.[1]);
    const synopsis = stripHtml(block.match(/<p class="synopsis[^"]*">([\s\S]*?)<\/p>/)?.[1]);

    const series = extractSeries(title);
    items.push({
      googleId: `cegal:${isbn13}`,
      title: series.title,
      subtitle: null,
      saga: series.saga,
      sagaNumber: series.sagaNumber,
      // CEGAL lista traductores junto al autor separados por "/"
      authors: author ? author.split('/').map(a => a.trim()).filter(Boolean) : [],
      publisher: stripHtml(attr('editorial')),
      publishedDate: null,
      description: synopsis,
      isbn: null,
      isbn13,
      pages: null,
      categories: [],
      language: 'es',
      cover: `https://static.cegal.es/imagenes/marcadas/${isbn13.slice(0, 7)}/${isbn13.slice(0, 12)}.gif`,
      price: price > 0 ? price : null,
      currency: price > 0 ? 'EUR' : null,
      binding: null,
      sources: ['cegal'],
    });
  }

  return items;
}

// ── Apple Books (iTunes Search API) ───────────────────────────────────────

/**
 * Sin key ni cuota. Sólo cubre lo que tiene edición digital, pero cuando la
 * tiene aporta la portada de mayor resolución de todas las fuentes y una
 * sinopsis en castellano.
 */
async function appleByIsbn(isbn13: string): Promise<Partial_ | null> {
  const res = await safeFetch(`https://itunes.apple.com/lookup?isbn=${isbn13}&country=ES`);
  if (!res || !res.ok) return null;

  const json = await res.json() as { results?: any[] };
  const r = json.results?.[0];
  if (!r) return null;

  // artworkUrl100 acaba en /100x100bb.jpg; el CDN sirve cualquier tamaño.
  const cover = typeof r.artworkUrl100 === 'string'
    ? r.artworkUrl100.replace(/\/\d+x\d+bb\.jpg$/, '/1200x1200bb.jpg')
    : null;

  const series = extractSeries(r.trackName ?? '');

  return {
    title: series.title || undefined,
    saga: series.saga,
    sagaNumber: series.sagaNumber,
    authors: r.artistName ? [r.artistName] : [],
    description: stripHtml(r.description),
    publishedDate: typeof r.releaseDate === 'string' ? r.releaseDate.slice(0, 10) : null,
    categories: Array.isArray(r.genres) ? r.genres.filter((g: string) => g !== 'Libros') : [],
    cover,
    price: typeof r.price === 'number' && r.price > 0 ? r.price : null,
    currency: r.currency ?? null,
    sources: ['apple'],
  };
}

// ── Fusión ────────────────────────────────────────────────────────────────

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  return Array.isArray(v) && v.length === 0;
}

/**
 * Fusiona campo a campo: gana el primer aporte no vacío en el orden recibido.
 * Nunca se pisa un valor bueno con uno vacío de una fuente posterior.
 */
function merge(parts: (Partial_ | null)[]): BookMeta {
  const out: BookMeta = {
    googleId: '', title: '', subtitle: null, saga: null, sagaNumber: null, authors: [],
    publisher: null, publishedDate: null, description: null, isbn: null, isbn13: null,
    pages: null, categories: [], language: null, cover: null, price: null, currency: null,
    binding: null, sources: [],
  };

  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) {
      if (k === 'sources') continue;
      if (isEmpty(v)) continue;
      if (!isEmpty(out[k as keyof BookMeta])) continue;
      (out as any)[k] = v;
    }
    out.sources.push(...(part.sources ?? []));
  }

  // El precio y su moneda tienen que venir de la misma fuente.
  if (out.price !== null && out.currency === null) out.currency = 'EUR';
  return out;
}

/**
 * Ficha completa por ISBN consultando todas las fuentes en paralelo.
 * El orden del merge marca la prioridad de cada campo.
 */
export async function lookupByIsbn(
  raw: string, key?: string
): Promise<{ data: BookMeta | null; error: string | null }> {
  const isbn = normalizeScan(raw);
  if (!isIsbn(isbn)) return { data: null, error: 'ISBN no válido' };

  const isbn13 = toIsbn13(isbn);
  const isbn10 = toIsbn10(isbn);

  const [google, ol, cegal, apple] = await Promise.all([
    googleByIsbn(isbn, key),
    openLibraryByIsbn(isbn).catch(() => null),
    cegalByIsbn(isbn).catch(() => null),
    isbn13 ? appleByIsbn(isbn13).catch(() => null) : Promise.resolve(null),
  ]);

  if (!google.data && !ol && !cegal && !apple) {
    return { data: null, error: google.error };
  }

  // CEGAL antes que Google para editorial/precio/encuadernación: es el dato
  // del gremio español y Google suele traer la edición equivocada.
  const data = merge([
    google.data,
    cegal,
    ol,
    apple,
  ]);

  // Google gana en título/sinopsis, pero CEGAL es mejor para lo editorial.
  if (cegal?.publisher) data.publisher = cegal.publisher;
  if (cegal?.binding) data.binding = cegal.binding;
  if (cegal?.price) { data.price = cegal.price; data.currency = cegal.currency ?? 'EUR'; }

  data.isbn13 = data.isbn13 ?? isbn13;
  data.isbn = data.isbn ?? isbn10;

  // La portada se resuelve aparte y SIEMPRE se verifica, incluida la de Google:
  // para las fichas sin cubierta devuelve un PNG de "image not available" con
  // HTTP 200, que si te fías del merge acaba guardado como si fuera la portada.
  const googleCover = google.data?.cover ?? null;
  const appleCover = apple?.cover ?? null;
  data.cover = await firstWorkingCover([
    googleCover,                                 // la de la edición que dio los datos
    appleCover,                                  // 1200x1200, la de más resolución
    ...coverCandidates(data.isbn13, data.isbn),  // Amazon, AbeBooks, OpenLibrary, CEGAL
  ]);
  if (data.cover && data.cover !== googleCover && data.cover !== appleCover) {
    data.sources.push('cover-cdn');
  }

  data.sources = [...new Set(data.sources)];
  return { data, error: google.error };
}

/**
 * En un listado no se puede resolver la portada a fondo de cada resultado: un
 * Worker del plan Free tiene un tope de 50 subpeticiones por request, así que
 * sólo se comprueba la que ya trae cada ficha y se descarta si es un
 * placeholder. La buena se busca al seleccionar el libro, vía lookupByIsbn.
 */
const MAX_LISTING_COVER_CHECKS = 30;

async function verifyListingCovers(items: BookMeta[]): Promise<BookMeta[]> {
  await Promise.all(items.slice(0, MAX_LISTING_COVER_CHECKS).map(async item => {
    if (item.cover && !(await coverExists(item.cover))) item.cover = null;
  }));
  return items;
}

/**
 * Búsqueda por texto. Si Google falla o no devuelve nada, se cae a Open
 * Library para no dejar al usuario con un "no hay resultados" que en realidad
 * era un error de cuota.
 */
export async function searchBooks(
  q: string, opts: { start?: number; limit?: number; key?: string } = {}
): Promise<{ items: BookMeta[]; total: number; error: string | null }> {
  const google = await googleSearch(q, opts);
  if (google.items.length > 0) {
    return { ...google, items: await verifyListingCovers(google.items) };
  }

  const limit = opts.limit ?? 20;

  const res = await safeFetch(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}` +
    `&fields=key,title,subtitle,author_name,publisher,first_publish_year,isbn,cover_i,number_of_pages_median,language` +
    `&limit=${limit}&offset=${opts.start ?? 0}`
  );

  const json = res && res.ok
    ? await res.json() as { numFound?: number; docs?: any[] }
    : { docs: [] };
  const items: BookMeta[] = (json.docs ?? []).map(d => ({
    googleId: `ol:${d.key}`,
    title: d.title ?? '',
    subtitle: d.subtitle ?? null,
    saga: null,
    sagaNumber: null,
    authors: d.author_name ?? [],
    publisher: d.publisher?.[0] ?? null,
    publishedDate: d.first_publish_year ? String(d.first_publish_year) : null,
    description: null,
    isbn: (d.isbn ?? []).find((i: string) => i.length === 10) ?? null,
    isbn13: (d.isbn ?? []).find((i: string) => i.length === 13) ?? null,
    pages: d.number_of_pages_median ?? null,
    categories: [],
    language: d.language?.[0] ?? null,
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    price: null,
    currency: null,
    binding: null,
    sources: ['openlibrary'],
  }));

  if (items.length > 0) {
    return { items: await verifyListingCovers(items), total: json.numFound ?? items.length, error: google.error };
  }

  // Último recurso: CEGAL. Open Library indexa poco en castellano, así que un
  // título español sin edición inglesa sólo aparece aquí.
  const cegal = await cegalSearch(q, limit).catch(() => []);
  return { items: await verifyListingCovers(cegal), total: cegal.length, error: google.error };
}
