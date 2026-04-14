import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';

export const googleBooks = new Hono<AppContext>();
googleBooks.use('*', requireAuth);

const API = 'https://www.googleapis.com/books/v1/volumes';

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

// Google Books has no dedicated series field — series info is embedded in the title
// e.g. "Los misterios de la taberna Kamogawa (Taberna Kamogawa 1)"
function extractSeries(raw: string): { title: string; saga: string | null; sagaNumber: number | null } {
  const m = raw.match(/\s*\(([^)]+?)\s*[,#\-]?\s*(?:[Vv]ol\.?\s*|#\s*|[Nn]º\s*)?(\d+)\s*\)\s*$/);
  if (m) return { title: raw.replace(m[0], '').trim(), saga: m[1].trim(), sagaNumber: Number(m[2]) };
  return { title: raw, saga: null, sagaNumber: null };
}

function mapVolume(v: GBVolume) {
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
  };
}

// Search books
googleBooks.get('/search', async (c) => {
  const q = c.req.query('q') ?? '';
  if (!q) return c.json({ data: [], total: 0 });

  const startIndex = Number(c.req.query('start') ?? '0');
  const maxResults = Math.min(Number(c.req.query('limit') ?? '20'), 40);

  const url = `${API}?q=${encodeURIComponent(q)}&startIndex=${startIndex}&maxResults=${maxResults}&langRestrict=es&printType=books`;
  const res = await fetch(url);
  if (!res.ok) return c.json({ data: [], total: 0, error: 'Google Books API error' });

  const json = await res.json() as { totalItems: number; items?: GBVolume[] };
  return c.json({
    data: (json.items ?? []).map(mapVolume),
    total: json.totalItems ?? 0,
  });
});

// Validate ISBN format (10 or 13 digits, optionally with hyphens)
function isValidIsbn(isbn: string): boolean {
  const clean = isbn.replace(/[-\s]/g, '');
  return /^\d{10}$/.test(clean) || /^\d{13}$/.test(clean);
}

// Scrape price from Casa del Libro by ISBN
async function casaDelLibroPrice(isbn: string): Promise<number | null> {
  try {
    const res = await fetch(`https://www.casadellibro.com/libro-x/x/${isbn}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Casa del Libro shows price like: "12,95 €" or in JSON-LD
    const jsonLd = html.match(/"price"\s*:\s*"?([\d]+[,.]?\d*)/)
      ?? html.match(/([\d]+,\d{2})\s*€/);
    if (jsonLd) return Number(jsonLd[1].replace(',', '.'));
    return null;
  } catch {
    return null;
  }
}

// Scrape price from Amazon.es by ISBN — prefers RRP (a-text-price), falls back to selling price
async function amazonPrice(isbn: string): Promise<number | null> {
  try {
    const cleanIsbn = isbn.replace(/[-\s]/g, '');
    const res = await fetch(`https://www.amazon.es/s?k=${cleanIsbn}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'es-ES,es;q=0.9',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // 1. RRP / PVP (strikethrough price = a-text-price): "9,99 €"
    const rrp = html.match(/a-text-price[^>]*>.*?a-offscreen[^>]*>([\d]+[,.][\d]+)\s*€/s);
    if (rrp) {
      const price = Number(rrp[1].replace(',', '.'));
      if (price > 0 && price < 200) return price;
    }

    // 2. Selling price (a-price-whole + a-price-fraction)
    const whole = html.match(/a-price-whole[^>]*>(\d+)/);
    const fraction = html.match(/a-price-fraction[^>]*>(\d+)/);
    if (whole) {
      const price = Number(`${whole[1]}.${fraction ? fraction[1] : '00'}`);
      if (price > 0 && price < 200) return price;
    }
    return null;
  } catch {
    return null;
  }
}

// Scrape price from ECC Ediciones by comic slug
async function eccPrice(title: string): Promise<number | null> {
  try {
    // Build slug from title: lowercase, replace spaces/special chars with hyphens
    const slug = title
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const res = await fetch(`https://www.eccediciones.com/comic/${slug}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();

    // ECC embeds price in JSON data: "price":"13.99"
    const priceMatch = html.match(/"price"\s*:\s*"?([\d]+(?:[.,]\d+)?)"?/);
    if (priceMatch) {
      const price = Number(priceMatch[1].replace(',', '.'));
      if (price > 0 && price < 200) return price;
    }
    return null;
  } catch {
    return null;
  }
}

// Try editorial website for price (currently supports ECC)
async function editorialPrice(title: string, publisher: string): Promise<number | null> {
  const pub = (publisher || '').toLowerCase();
  if (pub.includes('ecc')) {
    return eccPrice(title);
  }
  // Panini uses anti-bot (queue-it), not supported
  return null;
}

// Lookup by ISBN — tries Google Books → Amazon.es → Casa del Libro
googleBooks.get('/isbn/:isbn', async (c) => {
  const isbn = c.req.param('isbn');
  const cleanIsbn = isbn.replace(/[-\s]/g, '');

  // Only proceed if ISBN is valid (10 or 13 digits)
  if (!isValidIsbn(cleanIsbn)) return c.json({ data: null });

  const url = `${API}?q=isbn:${encodeURIComponent(cleanIsbn)}&maxResults=1`;
  const res = await fetch(url);

  let data: ReturnType<typeof mapVolume> | null = null;
  if (res.ok) {
    const json = await res.json() as { items?: GBVolume[] };
    if (json.items?.length) data = mapVolume(json.items[0]);
  }

  // If no price from Google Books, try Amazon.es then Casa del Libro
  if (!data || !data.price) {
    const extPrice = await amazonPrice(cleanIsbn) ?? await casaDelLibroPrice(cleanIsbn);
    if (extPrice) {
      if (data) {
        data.price = extPrice;
        data.currency = 'EUR';
      } else {
        data = {
          googleId: '', title: '', subtitle: null, saga: null, sagaNumber: null, authors: [],
          publisher: null, publishedDate: null, description: null,
          isbn: cleanIsbn.length === 10 ? cleanIsbn : null,
          isbn13: cleanIsbn.length === 13 ? cleanIsbn : null,
          pages: null, categories: [], language: null, cover: null,
          price: extPrice, currency: 'EUR',
        };
      }
    }
  }

  return c.json({ data });
});

// Editorial price lookup — for comics without valid ISBN (grapas)
googleBooks.get('/editorial-price', async (c) => {
  const title = c.req.query('title') ?? '';
  const publisher = c.req.query('publisher') ?? '';
  if (!title) return c.json({ price: null });

  const price = await editorialPrice(title, publisher);
  return c.json({ price, currency: price ? 'EUR' : null });
});
