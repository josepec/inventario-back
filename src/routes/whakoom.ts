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
  // 1. GET login page para obtener cookies y token CSRF
  const loginPageRes = await fetch('https://www.whakoom.com/login', {
    headers: BROWSER_HEADERS,
    redirect: 'manual',
  });

  const loginHtml = await loginPageRes.text();

  // Recoger cookies iniciales
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

  // 3. Recoger cookies de sesión del response
  const authCookies = loginRes.headers.getAll?.('set-cookie')
    ?? [loginRes.headers.get('set-cookie') ?? ''];
  const allCookies = [...setCookies, ...authCookies]
    .filter(Boolean)
    .map(c => c.split(';')[0]);

  // Deduplicar por nombre de cookie
  const cookieMap = new Map<string, string>();
  for (const c of allCookies) {
    const name = c.split('=')[0];
    cookieMap.set(name, c);
  }

  return [...cookieMap.values()].join('; ');
}

async function fetchWithAuth(url: string, env: { WHAKOOM_USER: string; WHAKOOM_PASS: string }): Promise<Response> {
  // Intenta con la cookie cacheada
  if (sessionCookie) {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, 'Cookie': sessionCookie },
      redirect: 'manual',
    });
    const location = res.headers.get('location') ?? '';
    // Si no redirige al login, la sesión sigue viva
    if (!location.includes('/login')) {
      return res;
    }
  }

  // Login y reintentar
  sessionCookie = await login(env.WHAKOOM_USER, env.WHAKOOM_PASS);

  return fetch(url, {
    headers: { ...BROWSER_HEADERS, 'Cookie': sessionCookie },
    redirect: 'manual',
  });
}

// GET /whakoom/search?q=batman
whakoom.get('/search', async (c) => {
  const q = c.req.query('q') ?? '';
  if (!q.trim()) return c.json([]);

  const url = `https://www.whakoom.com/search?q=${encodeURIComponent(q)}&type=comics`;

  try {
    const response = await fetchWithAuth(url, c.env);

    // Si nos redirige, seguir manualmente con cookies
    let html: string;
    const location = response.headers.get('location');
    if (location) {
      const fullUrl = location.startsWith('http') ? location : `https://www.whakoom.com${location}`;
      const followRes = await fetch(fullUrl, {
        headers: { ...BROWSER_HEADERS, 'Cookie': sessionCookie },
      });
      html = await followRes.text();
    } else {
      html = await response.text();
    }

    if (html.includes('/login')) {
      return c.json({ error: 'No se pudo iniciar sesión en Whakoom' }, 502);
    }

    const results = parseSearch(html);
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
    const response = await fetchWithAuth(url, c.env);

    let html: string;
    const location = response.headers.get('location');
    if (location) {
      const fullUrl = location.startsWith('http') ? location : `https://www.whakoom.com${location}`;
      const followRes = await fetch(fullUrl, {
        headers: { ...BROWSER_HEADERS, 'Cookie': sessionCookie },
      });
      html = await followRes.text();
    } else {
      html = await response.text();
    }

    if (html.includes('/login')) {
      return c.json({ error: 'No se pudo iniciar sesión en Whakoom' }, 502);
    }

    const data = parseComic(html, id);
    return c.json(data);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseComic(html: string, id: string) {
  const og = (prop: string): string => {
    const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'));
    return m ? m[1].trim() : '';
  };

  const tag = (pattern: RegExp): string => {
    const m = html.match(pattern);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  };

  const title = og('title') || tag(/<h1[^>]*>(.*?)<\/h1>/s);
  const cover = og('image');
  const description = og('description')
    || tag(/<(?:p|div)[^>]*class=["'][^"']*(?:description|sinopsis)[^"']*["'][^>]*>(.*?)<\/(?:p|div)>/s);

  // Autores
  const authorMatches = [...html.matchAll(/href=["'][^"']*\/(?:author|autores?)\/[^"']*["'][^>]*>([^<]+)</gi)];
  const authors = [...new Set(authorMatches.map(m => m[1].trim()).filter(Boolean))];

  // Editorial
  const publisherMatch = html.match(/href=["'][^"']*\/(?:publisher|editorial)\/[^"']*["'][^>]*>([^<]+)</i);
  const publisher = publisherMatch ? publisherMatch[1].trim() : '';

  // Fecha
  const dateMatch = html.match(/(?:datePublished|published_time)["'\s]+content=["']([^"']+)["']/i)
    || html.match(/<time[^>]+datetime=["']([^"']+)["']/i);
  const date = dateMatch ? dateMatch[1].slice(0, 10) : '';

  // Serie
  const seriesMatch = html.match(/href=["'][^"']*\/(?:series|serie)\/[^"']*["'][^>]*>([^<]+)</i);
  const series = seriesMatch ? seriesMatch[1].trim() : '';

  // Número
  const numMatch = html.match(/(?:item_number|número|number)[^>]*>[\s#]*(\d+)/i);
  const number = numMatch ? numMatch[1] : '';

  // ISBN
  const isbnMatch = html.match(/isbn[^>]*>[\s]*([0-9\-X]{10,17})/i);
  const isbn = isbnMatch ? isbnMatch[1].replace(/-/g, '') : '';

  return {
    id,
    title,
    cover,
    description,
    authors,
    publisher,
    date,
    series,
    number,
    isbn,
    url: `https://www.whakoom.com/comics/${id}`,
  };
}

function parseSearch(html: string) {
  const results: { id: string; title: string; cover: string | null }[] = [];
  const seen = new Set<string>();

  const matches = [...html.matchAll(/href=["']([^"']*\/comics\/([a-zA-Z0-9]+))[^"']*["'][^>]*>([\s\S]*?)(?=href=|$)/gi)];

  for (const m of matches) {
    const id = m[2];
    if (seen.has(id) || id.length < 3) continue;
    seen.add(id);

    const fragment = m[3];
    const imgMatch = fragment.match(/<img[^>]+src=["']([^"']+)["']/i);
    const titleMatch = fragment.match(/<(?:h[1-6]|strong|span)[^>]*>([^<]{3,80})</i);

    results.push({
      id,
      title: titleMatch ? titleMatch[1].trim() : id,
      cover: imgMatch ? imgMatch[1] : null,
    });

    if (results.length >= 24) break;
  }

  return results;
}

export { whakoom };
