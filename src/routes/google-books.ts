import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';
import { isIsbn, lookupByIsbn, searchBooks, findCover, normalizeScan, toIsbn13 } from '../services/book-sources';

export const googleBooks = new Hono<AppContext>();
googleBooks.use('*', requireAuth);

// Search books — acepta texto libre o un ISBN suelto
googleBooks.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return c.json({ data: [], total: 0 });

  const key = c.env.GOOGLE_BOOKS_KEY;

  // Un ISBN pegado en el buscador (o llegado del escáner) no funciona como
  // texto libre en Google: hay que resolverlo por la vía de ISBN.
  if (isIsbn(q)) {
    const { data, error } = await lookupByIsbn(q, key);
    return c.json({ data: data ? [data] : [], total: data ? 1 : 0, error });
  }

  const startIndex = Number(c.req.query('start') ?? '0');
  const maxResults = Math.min(Number(c.req.query('limit') ?? '20'), 40);

  const { items, total, error } = await searchBooks(q, { start: startIndex, limit: maxResults, key });
  return c.json({ data: items, total, error });
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

// Lookup by ISBN — Google Books + Open Library + CEGAL + Apple Books en paralelo,
// portada de los CDN por ISBN y, si nadie da precio, Amazon.es / Casa del Libro
googleBooks.get('/isbn/:isbn', async (c) => {
  const isbn = normalizeScan(c.req.param('isbn'));

  const { data, error } = await lookupByIsbn(isbn, c.env.GOOGLE_BOOKS_KEY);
  if (!data) return c.json({ data: null, error });

  if (!data.price) {
    const extPrice = await amazonPrice(isbn) ?? await casaDelLibroPrice(isbn);
    if (extPrice) {
      data.price = extPrice;
      data.currency = 'EUR';
      data.sources.push('scraper');
    }
  }

  return c.json({ data, error });
});

// Buscar sólo portada por ISBN — para rellenar fichas ya guardadas
googleBooks.get('/cover/:isbn', async (c) => {
  const isbn = normalizeScan(c.req.param('isbn'));
  if (!isIsbn(isbn)) return c.json({ cover: null, error: 'ISBN no válido' });

  // Los CDN indexan unas veces por ISBN-10 y otras por ISBN-13: se prueban ambos.
  const cover = await findCover(toIsbn13(isbn), isbn.length === 10 ? isbn : null);
  return c.json({ cover });
});

// Editorial price lookup — for comics without valid ISBN (grapas)
googleBooks.get('/editorial-price', async (c) => {
  const title = c.req.query('title') ?? '';
  const publisher = c.req.query('publisher') ?? '';
  if (!title) return c.json({ price: null });

  const price = await editorialPrice(title, publisher);
  return c.json({ price, currency: price ? 'EUR' : null });
});
