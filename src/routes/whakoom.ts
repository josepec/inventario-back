import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';

const whakoom = new Hono<AppContext>();

whakoom.use('*', requireAuth);

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
};

// Cookie de sesión en memoria (se renueva en cada cold start)
let sessionCookie = '';

async function login(user: string, pass: string): Promise<string> {
  // 1. GET login page para obtener cookies y __VIEWSTATE
  const loginPageRes = await fetch('https://www.whakoom.com/login', {
    headers: BROWSER_HEADERS,
    redirect: 'manual',
  });

  const loginHtml = await loginPageRes.text();

  const setCookies = loginPageRes.headers.getAll?.('set-cookie')
    ?? [loginPageRes.headers.get('set-cookie') ?? ''];
  let cookies = setCookies
    .filter(Boolean)
    .map(c => c.split(';')[0])
    .join('; ');

  // Extraer campos ASP.NET WebForms
  const viewStateMatch = loginHtml.match(/name="__VIEWSTATE"[^>]+value="([^"]+)"/i)
    ?? loginHtml.match(/id="__VIEWSTATE"[^>]+value="([^"]+)"/i);
  const viewState = viewStateMatch ? viewStateMatch[1] : '';

  const viewStateGenMatch = loginHtml.match(/name="__VIEWSTATEGENERATOR"[^>]+value="([^"]+)"/i);
  const viewStateGen = viewStateGenMatch ? viewStateGenMatch[1] : '';

  // 2. POST login con credenciales
  const body = new URLSearchParams();
  if (viewState) body.set('__VIEWSTATE', viewState);
  if (viewStateGen) body.set('__VIEWSTATEGENERATOR', viewStateGen);
  body.set('username', user);
  body.set('userpassw', pass);
  body.set('remember', 'true');

  const loginRes = await fetch('https://www.whakoom.com/login', {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookies,
      'Sec-Fetch-Site': 'same-origin',
      'Referer': 'https://www.whakoom.com/login',
    },
    body: body.toString(),
    redirect: 'manual',
  });

  // 3. Recoger cookies de sesión
  const authCookies = loginRes.headers.getAll?.('set-cookie')
    ?? [loginRes.headers.get('set-cookie') ?? ''];
  const allCookies = [...setCookies, ...authCookies]
    .filter(Boolean)
    .map(c => c.split(';')[0]);

  const cookieMap = new Map<string, string>();
  for (const c of allCookies) {
    const name = c.split('=')[0];
    cookieMap.set(name, c);
  }

  return [...cookieMap.values()].join('; ');
}

async function ensureSession(env: { WHAKOOM_USER: string; WHAKOOM_PASS: string }): Promise<string> {
  if (sessionCookie && sessionCookie.includes('.WHAKOOMUSER=') && !sessionCookie.includes('.WHAKOOMUSER=;')) {
    return sessionCookie;
  }
  sessionCookie = await login(env.WHAKOOM_USER, env.WHAKOOM_PASS);
  return sessionCookie;
}

async function whakoomFetch(url: string, env: { WHAKOOM_USER: string; WHAKOOM_PASS: string }, options?: RequestInit): Promise<Response> {
  let cookie = await ensureSession(env);

  const res = await fetch(url, {
    ...options,
    headers: {
      ...BROWSER_HEADERS,
      ...(options?.headers as Record<string, string> ?? {}),
      'Cookie': cookie,
    },
    redirect: 'manual',
  });

  // Si redirige al login, renovar sesión y reintentar
  const location = res.headers.get('location') ?? '';
  if (location.includes('/login')) {
    sessionCookie = '';
    cookie = await ensureSession(env);
    return fetch(url, {
      ...options,
      headers: {
        ...BROWSER_HEADERS,
        ...(options?.headers as Record<string, string> ?? {}),
        'Cookie': cookie,
      },
    });
  }

  // Si fue redirect a otra página, seguirlo con cookies
  if (location) {
    const fullUrl = location.startsWith('http') ? location : `https://www.whakoom.com${location}`;
    return fetch(fullUrl, {
      headers: { ...BROWSER_HEADERS, 'Cookie': cookie },
    });
  }

  return res;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

// GET /whakoom/search?q=batman
whakoom.get('/search', async (c) => {
  const q = c.req.query('q') ?? '';
  if (!q.trim()) return c.json([]);

  try {
    const cookie = await ensureSession(c.env);

    const res = await fetch('https://www.whakoom.com/search.aspx/Query', {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookie,
        'Referer': `https://www.whakoom.com/search?q=${encodeURIComponent(q)}&type=comics`,
      },
      body: JSON.stringify({ q: q.trim(), ft: '0', fit: '', fp: '', fl: '', p: 1 }),
    });

    if (!res.ok) return c.json({ error: `Whakoom devolvió ${res.status}` }, 502);

    const json = await res.json<{ d: { itemsCount: number; searchResult: string } }>();
    const results = parseSearchResults(json.d.searchResult);
    return c.json(results);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /whakoom/comic/:id
whakoom.get('/comic/:id', async (c) => {
  const id = c.req.param('id');
  const url = `https://www.whakoom.com/comics/${id}`;

  try {
    const res = await whakoomFetch(url, c.env);
    if (!res.ok) return c.json({ error: `Whakoom devolvió ${res.status}` }, 502);

    const html = await res.text();
    if (html.includes('/login?ReturnUrl')) {
      return c.json({ error: 'No se pudo iniciar sesión en Whakoom' }, 502);
    }

    const data = parseComic(html, id);
    return c.json(data);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseSearchResults(html: string) {
  const results: { id: string; title: string; cover: string | null; publisher: string }[] = [];
  const seen = new Set<string>();

  // Cada resultado de búsqueda es un div.sresult
  const blocks = [...html.matchAll(/<div class="sresult[\s\S]*?(?=<div class="sresult|<div class="sresult-series|$)/gi)];

  for (const block of blocks) {
    const fragment = block[0];

    // Extraer link a /comics/ID o /ediciones/ID
    const linkMatch = fragment.match(/href="\/comics\/([a-zA-Z0-9]+)[^"]*"/i)
      ?? fragment.match(/href="\/ediciones\/(\d+)[^"]*"/i);
    if (!linkMatch) continue;

    const id = linkMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);

    // Título
    const titleMatch = fragment.match(/class="title"[^>]*>\s*<a[^>]*>([^<]+)/i);
    const title = titleMatch ? titleMatch[1].trim() : id;

    // Portada
    const imgMatch = fragment.match(/<img[^>]+src="([^"]+)"/i);
    let cover = imgMatch ? imgMatch[1] : null;
    // Convertir thumb a versión más grande
    if (cover) cover = cover.replace('/thumb/', '/small/');

    // Editorial
    const pubMatch = fragment.match(/class="pub"[^>]*>([^<]+)/i);
    const publisher = pubMatch ? pubMatch[1].trim() : '';

    results.push({ id, title, cover, publisher });
    if (results.length >= 24) break;
  }

  return results;
}

function parseComic(html: string, id: string) {
  // og tags
  const og = (prop: string): string => {
    const m = html.match(new RegExp(`property=["']og:${prop}["'][^>]+content=["']([^"']+)`, 'i'))
      ?? html.match(new RegExp(`content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'));
    return m ? m[1].trim() : '';
  };

  const title = og('title').replace(/\s*\([^)]+\)\s*$/, '') || '';
  const cover = og('image');
  const description = og('description');

  // Schema.org itemprop
  const itemprop = (prop: string): string => {
    const m = html.match(new RegExp(`itemprop="${prop}"[^>]+content="([^"]+)"`, 'i'))
      ?? html.match(new RegExp(`itemprop="${prop}"[^>]*>([^<]+)`, 'i'));
    return m ? m[1].trim() : '';
  };

  // Publisher puede tener tags anidados
  const pubMatch = html.match(/itemprop="publisher"[^>]*>([\s\S]*?)<\//i);
  const publisher = pubMatch ? pubMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  const isbn = itemprop('isbn').replace(/-\d+$/, ''); // Quitar sufijo de Whakoom
  const dateRaw = html.match(/itemprop="datePublished"[^>]+content="([^"]+)"/i);
  const date = dateRaw ? dateRaw[1] : '';
  const language = itemprop('inLanguage');

  // Autores desde meta books:author
  const authorUrls = [...html.matchAll(/books:author[^>]+content="[^"]*\/autores\/\d+\/([^"]+)"/gi)];
  const authors = authorUrls.map(m =>
    m[1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  );

  // Serie desde itemprop name h1
  const seriesMatch = html.match(/itemprop="name"[^>]*>([\s\S]*?)<\/h1/i);
  let series = '';
  let number = '';
  if (seriesMatch) {
    const raw = seriesMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    const numPart = raw.match(/#(\d+)\s*$/);
    if (numPart) {
      series = raw.replace(/#\d+\s*$/, '').trim();
      number = numPart[1];
    } else {
      series = raw;
    }
  }

  return {
    id,
    title: title || series + (number ? ` #${number}` : ''),
    cover,
    description,
    authors,
    publisher,
    date,
    series,
    number,
    isbn,
    language,
    url: `https://www.whakoom.com/comics/${id}`,
  };
}

export { whakoom };
