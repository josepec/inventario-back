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

function mapVolume(v: GBVolume) {
  const info = v.volumeInfo;
  const ids = info.industryIdentifiers ?? [];
  const isbn13 = ids.find(i => i.type === 'ISBN_13')?.identifier ?? null;
  const isbn10 = ids.find(i => i.type === 'ISBN_10')?.identifier ?? null;
  const price = v.saleInfo?.retailPrice?.amount ?? v.saleInfo?.listPrice?.amount ?? null;
  const cover = info.imageLinks?.thumbnail?.replace('http://', 'https://') ?? null;

  return {
    googleId: v.id,
    title: info.title ?? '',
    subtitle: info.subtitle ?? null,
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

// Lookup by ISBN — tries Google Books, then Casa del Libro for price
googleBooks.get('/isbn/:isbn', async (c) => {
  const isbn = c.req.param('isbn');
  const url = `${API}?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  const res = await fetch(url);

  let data: ReturnType<typeof mapVolume> | null = null;
  if (res.ok) {
    const json = await res.json() as { items?: GBVolume[] };
    if (json.items?.length) data = mapVolume(json.items[0]);
  }

  // If no price from Google Books, try Casa del Libro
  if ((!data || !data.price) && isbn) {
    const cdlPrice = await casaDelLibroPrice(isbn);
    if (cdlPrice) {
      if (data) {
        data.price = cdlPrice;
        data.currency = 'EUR';
      } else {
        data = {
          googleId: '', title: '', subtitle: null, authors: [],
          publisher: null, publishedDate: null, description: null,
          isbn: isbn.length === 10 ? isbn : null,
          isbn13: isbn.length === 13 ? isbn : null,
          pages: null, categories: [], language: null, cover: null,
          price: cdlPrice, currency: 'EUR',
        };
      }
    }
  }

  return c.json({ data });
});
