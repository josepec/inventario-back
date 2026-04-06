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

// Lookup by ISBN (for comics price enrichment too)
googleBooks.get('/isbn/:isbn', async (c) => {
  const isbn = c.req.param('isbn');
  const url = `${API}?q=isbn:${encodeURIComponent(isbn)}&maxResults=1`;
  const res = await fetch(url);
  if (!res.ok) return c.json({ data: null });

  const json = await res.json() as { items?: GBVolume[] };
  if (!json.items?.length) return c.json({ data: null });

  return c.json({ data: mapVolume(json.items[0]) });
});
