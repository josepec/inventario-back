import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';

const whakoom = new Hono<AppContext>();

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

whakoom.use('*', requireAuth);

// ── Endpoints ─────────────────────────────────────────────────────────────────

// GET /whakoom/search?q=batman&page=1
whakoom.get('/search', async (c) => {
  const q = c.req.query('q') ?? '';
  if (!q.trim()) return c.json({ data: [], total: 0, page: 1, hasMore: false });
  const page = Math.max(1, Number(c.req.query('page') ?? 1));

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
      body: JSON.stringify({ q: q.trim(), ft: '0', fit: '', fp: '', fl: '', p: page }),
    });

    if (!res.ok) return c.json({ error: `Whakoom devolvió ${res.status}` }, 502);

    const json = await res.json<{ d: { itemsCount: number; nextPage: number; searchResult: string } }>();
    const results = parseSearchResults(json.d.searchResult);
    return c.json({
      data: results,
      total: json.d.itemsCount,
      page,
      hasMore: json.d.nextPage > page,
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /whakoom/comic/:id?type=comic|edition
whakoom.get('/comic/:id', async (c) => {
  const id = c.req.param('id');
  const type = c.req.query('type') ?? 'comic';
  const url = type === 'edition'
    ? `https://www.whakoom.com/ediciones/${id}`
    : `https://www.whakoom.com/comics/${id}`;

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

// Fetch + parse de /newtitles/YYYYMM reusable desde otros endpoints.
// Devuelve null si no se pudo (para que el caller decida que devolver).
export async function fetchNewTitles(
  env: { WHAKOOM_USER: string; WHAKOOM_PASS: string },
  yyyymm: string,
): Promise<Array<ReturnType<typeof parseNewTitles>[number]> | null> {
  if (!/^\d{6}$/.test(yyyymm)) return null;
  const month = `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}`;
  const res = await whakoomFetch(`https://www.whakoom.com/newtitles/${yyyymm}`, env);
  if (!res.ok) return null;
  const html = await res.text();
  if (html.includes('/login?ReturnUrl')) return null;
  return parseNewTitles(html, month);
}

// Enriquece items con flags owned/wanted consultando la DB local.
export async function enrichWithOwnership<T extends { whakoom_comic_id: string }>(
  db: D1Database,
  items: T[],
): Promise<Array<T & { owned: boolean; wanted: boolean }>> {
  const ids = items.map(i => i.whakoom_comic_id);
  const ownedSet = new Set<string>();
  const wantedSet = new Set<string>();

  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const ownedRows = await db
      .prepare(`SELECT whakoom_id FROM comics WHERE whakoom_id IN (${placeholders})`)
      .bind(...ids)
      .all<{ whakoom_id: string }>();
    for (const r of ownedRows.results) if (r.whakoom_id) ownedSet.add(r.whakoom_id);

    const wantedRows = await db
      .prepare(`SELECT whakoom_comic_id FROM wanted_comics WHERE whakoom_comic_id IN (${placeholders})`)
      .bind(...ids)
      .all<{ whakoom_comic_id: string }>();
    for (const r of wantedRows.results) wantedSet.add(r.whakoom_comic_id);
  }

  return items.map(i => ({
    ...i,
    owned: ownedSet.has(i.whakoom_comic_id),
    wanted: wantedSet.has(i.whakoom_comic_id),
  }));
}

// GET /whakoom/newtitles/:yyyymm — novedades del mes (formato YYYYMM, ej 202604)
whakoom.get('/newtitles/:yyyymm', async (c) => {
  const yyyymm = c.req.param('yyyymm');
  if (!/^\d{6}$/.test(yyyymm)) return c.json({ error: 'yyyymm debe ser YYYYMM' }, 400);

  try {
    const items = await fetchNewTitles(c.env, yyyymm);
    if (items === null) return c.json({ error: 'No se pudo obtener novedades de Whakoom' }, 502);
    const enriched = await enrichWithOwnership(c.env.DB, items);
    return c.json({ month: `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}`, items: enriched });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /whakoom/edition/:id — obtener info + todos los números de una edición
whakoom.get('/edition/:id', async (c) => {
  const id = c.req.param('id');

  try {
    // 1. Fetch la página base para obtener el slug
    const baseRes = await whakoomFetch(`https://www.whakoom.com/ediciones/${id}`, c.env);
    if (!baseRes.ok) return c.json({ error: `Whakoom devolvió ${baseRes.status}` }, 502);

    const baseHtml = await baseRes.text();
    if (baseHtml.includes('/login?ReturnUrl')) {
      return c.json({ error: 'No se pudo iniciar sesión en Whakoom' }, 502);
    }

    // 2. Extraer slug de la URL canónica (ediciones/ID/slug)
    const slugMatch = baseHtml.match(new RegExp(`ediciones/${id}/([a-z0-9_]+)`, 'i'));
    const slug = slugMatch ? slugMatch[1] : '';

    // 3. Parsear info base (autores, sinopsis, detalles edición)
    const data = parseEdition(baseHtml, id);

    // 4. Fetch /todos con slug para obtener todos los issues (paginado si hace falta)
    if (slug) {
      try {
        const todosRes = await whakoomFetch(
          `https://www.whakoom.com/ediciones/${id}/${slug}/todos`, c.env
        );
        if (todosRes.ok) {
          const todosHtml = await todosRes.text();
          if (!todosHtml.includes('/login?ReturnUrl')) {
            const todosData = parseEdition(todosHtml, id);
            if (todosData.issues.length > data.issues.length) {
              data.issues = todosData.issues;
            }
            // Paginar si faltan issues
            if (data.totalIssues > 0 && data.issues.length < data.totalIssues) {
              const seenIds = new Set(data.issues.map((i: { id: string }) => i.id));
              for (let pg = 2; pg <= 10 && data.issues.length < data.totalIssues; pg++) {
                try {
                  const pgRes = await whakoomFetch(
                    `https://www.whakoom.com/ediciones/${id}/${slug}/todos?page=${pg}`, c.env
                  );
                  if (!pgRes.ok) break;
                  const pgHtml = await pgRes.text();
                  if (pgHtml.includes('/login?ReturnUrl')) break;
                  const pgData = parseEdition(pgHtml, id);
                  if (pgData.issues.length === 0) break;
                  let added = 0;
                  for (const issue of pgData.issues) {
                    if (!seenIds.has(issue.id)) { seenIds.add(issue.id); data.issues.push(issue); added++; }
                  }
                  if (added === 0) break;
                } catch { break; }
              }
              data.issues.sort((a: { number: number }, b: { number: number }) => a.number - b.number);
            }
          }
        }
      } catch { /* usar issues de baseHtml como fallback */ }
    }

    return c.json(data);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseSearchResults(html: string) {
  const results: { id: string; title: string; cover: string | null; publisher: string; type: string }[] = [];
  const seen = new Set<string>();

  // Cada resultado de búsqueda es un div.sresult
  const blocks = [...html.matchAll(/<div class="sresult[\s\S]*?(?=<div class="sresult|<div class="sresult-series|$)/gi)];

  for (const block of blocks) {
    const fragment = block[0];

    // Extraer link a /comics/ID o /ediciones/ID
    const comicMatch = fragment.match(/href="\/comics\/([a-zA-Z0-9]+)[^"]*"/i);
    const editionMatch = fragment.match(/href="\/ediciones\/(\d+)[^"]*"/i);
    const linkMatch = comicMatch ?? editionMatch;
    if (!linkMatch) continue;

    const id = linkMatch[1];
    const type = comicMatch ? 'comic' : 'edition';
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

    results.push({ id, title, cover, publisher, type });
    if (results.length >= 24) break;
  }

  return results;
}

function extractEditionFields(section: string, fullHtml?: string): { pages: number | null; binding: string | null; price: number | null } {
  // Search in the specific section first, then fall back to the full HTML
  const searchIn = (text: string) => ({
    pages: text.match(/(\d+)\s*pp\b/i),
    binding: text.match(/\b(Cart[oó]n[eé]|Grapa|R[uú]stica|Tapa\s+dura|Tapa\s+blanda|Bolsillo|Lujo)\b/i),
    price: text.match(/PVP\s*([\d]+(?:[,.][\d]+)?)\s*(?:€|&euro;)/i),
  });

  const s = searchIn(section);
  const fb = fullHtml ? searchIn(fullHtml) : { pages: null, binding: null, price: null };

  const pagesMatch = s.pages ?? fb.pages;
  const bindingMatch = s.binding ?? fb.binding;
  const priceMatch = s.price ?? fb.price;

  return {
    pages: pagesMatch ? Number(pagesMatch[1]) : null,
    binding: bindingMatch ? bindingMatch[1] : null,
    price: priceMatch ? Number(priceMatch[1].replace(',', '.')) : null,
  };
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

  // Publisher: itemprop, o extraer del og:title "(Editorial)" al final
  const pubMatch = html.match(/itemprop="publisher"[^>]*>([\s\S]*?)<\//i);
  let publisher = pubMatch ? pubMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  if (!publisher) {
    const ogPubMatch = og('title').match(/\(([^)]+)\)\s*$/);
    if (ogPubMatch) publisher = ogPubMatch[1];
  }

  const isbn = itemprop('isbn');
  const dateRaw = html.match(/itemprop="datePublished"[^>]+content="([^"]+)"/i);
  const date = dateRaw ? dateRaw[1] : '';
  const language = itemprop('inLanguage');

  // "Sobre esta edición" — páginas, encuadernación, precio
  // NO fullHtml fallback: la página de un comic individual contiene datos de la
  // edición padre en sidebars, y fallar al fullHtml los propagaria como per-issue.
  // Si el comic no tiene su propia seccion "Sobre esta edicion", dejamos null.
  const aboutMatch = html.match(/class="about-this-edition"[\s\S]*?<p>([^<]+)<\/p>/i)
    ?? html.match(/class="about-edition"[\s\S]*?<p>([^<]+)<\/p>/i)
    ?? html.match(/Sobre esta edici[oó]n[\s\S]*?<p>([^<]+)<\/p>/i);
  const editionDetails = aboutMatch ? aboutMatch[1].trim() : '';
  const { pages, binding, price } = extractEditionFields(editionDetails);

  // Autores con roles desde la sección <h3 class="autores">
  const parseAuthors = (block: string): { name: string; role: string }[] => {
    const result: { name: string; role: string }[] = [];
    const re = /<a[^>]*>(?:<span[^>]*>)?([^<]+)(?:<\/span>)?<\/a>(?:(?:&nbsp;|\s)\(([^)]+)\))?/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
      result.push({ name: m[1].trim(), role: m[2]?.trim() ?? '' });
    }
    return result;
  };

  const authorsBlock = html.match(/<h3[^>]*>Autores<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
  const otherAuthorsBlock = html.match(/<h3[^>]*>Otros autores<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
  let structuredAuthors = [
    ...parseAuthors(authorsBlock ? authorsBlock[1] : ''),
    ...parseAuthors(otherAuthorsBlock ? otherAuthorsBlock[1] : ''),
  ];

  // Fallback: si no encontramos la sección de autores, usar meta books:author
  if (structuredAuthors.length === 0) {
    const authorUrls = [...html.matchAll(/books:author[^>]+content="[^"]*\/autores\/\d+\/([^"]+)"/gi)];
    structuredAuthors = authorUrls.map(m => ({
      name: m[1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      role: '',
    }));
  }

  const authors = structuredAuthors.map(a => a.name);

  // Serie: itemprop name h1 o fallback a og:title
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
  } else {
    series = og('title').replace(/\s*\([^)]+\)\s*$/, '');
  }

  // Referencia a la edición (link a /ediciones/ID en el HTML)
  const editionMatch = html.match(/href="\/ediciones\/(\d+)[^"]*"/i);
  const editionId = editionMatch ? editionMatch[1] : null;

  return {
    id,
    title: title || series + (number ? ` #${number}` : ''),
    cover,
    description,
    authors,
    structuredAuthors,
    publisher,
    date,
    series,
    number,
    isbn,
    language,
    pages,
    binding,
    price,
    editionId,
    url: `https://www.whakoom.com/comics/${id}`,
  };
}

interface NewTitleItem {
  whakoom_comic_id: string;
  title: string;
  series: string;
  number: string;
  cover_url: string;
  publisher: string | null;
  collection_whakoom_id: string | null;
  collection_slug: string | null;
  release_month: string;
}

function parseNewTitles(html: string, month: string): NewTitleItem[] {
  // Whakoom publica /newtitles/YYYYMM con un <ul class="v2-cover-list ... new-titles">
  // donde cada <li id="comic<ID>"> es un comic. Reutilizamos el mismo patron que
  // parseEdition() usa para issues (id="comic..."). Aqui no filtramos por
  // not-published porque toda la pagina son novedades por definicion.
  const items: NewTitleItem[] = [];
  const seen = new Set<string>();

  const listMatch = html.match(/<ul[^>]*class="[^"]*new-titles[^"]*"[\s\S]*?<\/ul>/i);
  const listHtml = listMatch ? listMatch[0] : html;

  const blocks = [...listHtml.matchAll(/<li[^>]*id="comic([^"]+)"[^>]*>[\s\S]*?<\/li>/gi)];

  for (const block of blocks) {
    const fragment = block[0];
    const whakoom_comic_id = block[1];
    if (seen.has(whakoom_comic_id)) continue;
    seen.add(whakoom_comic_id);

    // title attr de <a class="title">: "<Serie> (<Formato> [<Pages>pp]) [#N]"
    const titleAttrMatch = fragment.match(/<a[^>]*class="[^"]*title[^"]*"[^>]*title="([^"]+)"/i)
      ?? fragment.match(/title="([^"]+)"/i);
    const titleAttr = titleAttrMatch ? titleAttrMatch[1].trim() : '';

    // Numero: de <span class="issue-number"> o fallback al title attr
    const numSpan = fragment.match(/class="issue-number"[^>]*>([\s\S]*?)<\//i);
    let number = '';
    if (numSpan) {
      const m = numSpan[1].replace(/<[^>]*>/g, '').match(/#?(\d+)/);
      if (m) number = m[1];
    }
    if (!number) {
      const titleNumMatch = titleAttr.match(/#(\d+)/);
      if (titleNumMatch) number = titleNumMatch[1];
    }

    // Serie: <strong> dentro del <a>
    const seriesMatch = fragment.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
    let series = seriesMatch
      ? seriesMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
      : '';
    if (!series) {
      // Fallback: primera parte del title attr antes del parentesis
      const m = titleAttr.match(/^([^(]+)/);
      if (m) series = m[1].trim();
    }

    // Cover: <img src=...> (convertir thumb→small para consistencia con search)
    const imgMatch = fragment.match(/<img[^>]+src="([^"]+)"/i);
    let cover_url = imgMatch ? imgMatch[1] : '';
    if (cover_url) cover_url = cover_url.replace('/thumb/', '/small/');

    // href: /comics/<COMIC_ID>/<SLUG>/<NUMBER> — el slug permite identificar
    // la coleccion sin hacer un fetch adicional (matcheando contra collections.title
    // normalizado via json_each de issues).
    const hrefMatch = fragment.match(/href="\/comics\/[^/]+\/([^/"]+)\/\d+"/i);
    const collection_slug = hrefMatch ? hrefMatch[1] : null;

    items.push({
      whakoom_comic_id,
      title: titleAttr || (series + (number ? ` #${number}` : '')),
      series,
      number,
      cover_url,
      publisher: null,
      collection_whakoom_id: null,
      collection_slug,
      release_month: month,
    });
  }

  return items;
}

function parseEdition(html: string, id: string) {
  // Header info
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  const pubMatch = html.match(/class="publisher"[^>]*>\s*<a[^>]*>([^<]+)/i);
  const publisher = pubMatch ? pubMatch[1].trim() : '';

  const issuesCountMatch = html.match(/(\d+)\s*cómics/i);
  const totalIssues = issuesCountMatch ? Number(issuesCountMatch[1]) : 0;

  const typeMatch = html.match(/class="edition-type"[^>]*>([^<]+)/i);
  const format = typeMatch ? typeMatch[1].trim() : '';

  const statusMatch = html.match(/class="status\s*[^"]*"[^>]*>([^<]+)/i);
  const status = statusMatch ? statusMatch[1].trim() : '';

  const coverMatch = html.match(/data-item-img="([^"]+)"/i);
  const cover = coverMatch ? coverMatch[1] : '';

  // "Sobre esta edición" → edition details (format, size, etc.)
  const aboutEdMatch = html.match(/class="about-this-edition"[\s\S]*?<p>([^<]+)<\/p>/i)
    ?? html.match(/class="about-edition"[\s\S]*?<p>([^<]+)<\/p>/i)
    ?? html.match(/Sobre esta edici[oó]n[\s\S]*?<p>([^<]+)<\/p>/i);
  const editionDetails = aboutEdMatch ? aboutEdMatch[1].trim() : '';
  const { pages: editionPages, binding: editionBinding, price: editionPrice } = extractEditionFields(editionDetails, html);

  // Argumento (synopsis)
  const argMatch = html.match(/<h2>Argumento<\/h2>\s*<p>([\s\S]*?)<\/p>/i);
  let synopsis = '';
  if (argMatch && !argMatch[1].includes('No conocemos el argumento')) {
    synopsis = argMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  }

  // og:description as fallback
  const descMatch = html.match(/og:description["'][^>]+content=["']([^"']+)/i)
    ?? html.match(/content=["']([^"']+)["'][^>]+og:description/i);
  const description = synopsis || (descMatch ? descMatch[1].trim() : '');

  // Autores
  const parseAuthors = (block: string): { name: string; role: string }[] => {
    const authors: { name: string; role: string }[] = [];
    const re = /<a[^>]*>(?:<span[^>]*>)?([^<]+)(?:<\/span>)?<\/a>(?:(?:&nbsp;|\s)\(([^)]+)\))?/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
      authors.push({ name: m[1].trim(), role: m[2]?.trim() ?? '' });
    }
    return authors;
  };

  const authorsBlock = html.match(/<h3[^>]*>Autores<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
  const otherAuthorsBlock = html.match(/<h3[^>]*>Otros autores<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
  const authors = [
    ...parseAuthors(authorsBlock ? authorsBlock[1] : ''),
    ...parseAuthors(otherAuthorsBlock ? otherAuthorsBlock[1] : ''),
  ];

  // Parse issues from v2-cover-list
  const issues: { id: string; number: number; title: string; subtitle: string; cover: string; published: boolean; releaseDate: string | null }[] = [];
  const issueBlocks = [...html.matchAll(/<li[^>]*id="comic([^"]+)"[^>]*>[\s\S]*?<\/li>/gi)];

  for (const block of issueBlocks) {
    const fragment = block[0];
    const comicId = block[1];

    // Detect not-published class on the li element
    const liTag = fragment.match(/<li[^>]*>/i)?.[0] ?? '';
    const published = !liTag.includes('not-published');

    // Extract issue number from: 1) issue-number span, 2) href /comics/ID/slug/NUM, 3) title attr "#NUM"
    const numSpan = fragment.match(/class="issue-number"[^>]*>([\s\S]*?)<\//i);
    const numText = numSpan ? numSpan[1].replace(/<[^>]*>/g, '').trim() : '';
    let numMatch = numText.match(/#?(\d+)/);
    if (!numMatch) {
      // Fallback: extract from href like /comics/6FNHx/wonder_woman_2012-_2022/15
      const hrefMatch = fragment.match(/href="\/comics\/[^/]+\/[^/]+\/(\d+)"/i);
      if (hrefMatch) numMatch = hrefMatch;
    }
    if (!numMatch) {
      // Fallback: extract from title attr like "Wonder Woman (2012- 2022) #15 / 1"
      const titleAttr = fragment.match(/title="[^"]*#(\d+)/i);
      if (titleAttr) numMatch = titleAttr;
    }
    const num = numMatch ? Number(numMatch[1]) : 0;

    const titleM = fragment.match(/title="([^"]+)"/i);
    const issueTitle = titleM ? titleM[1].trim() : '';

    const subtitleM = fragment.match(/<span class="title">\s*([^<]+)/i);
    const subtitle = subtitleM ? subtitleM[1].trim() : '';

    const imgM = fragment.match(/<img[^>]+src="([^"]+)"/i);
    const issueCover = imgM ? imgM[1] : '';

    // Extract release date if present (usually shown for not-published items)
    const dateM = fragment.match(/class="release-date"[^>]*>([^<]+)/i)
      ?? fragment.match(/class="date"[^>]*>([^<]+)/i);
    const releaseDate = dateM ? dateM[1].trim() : null;

    issues.push({ id: comicId, number: num, title: issueTitle, subtitle, cover: issueCover, published, releaseDate });
  }

  // Sort by number ascending
  issues.sort((a, b) => a.number - b.number);

  return {
    id,
    title,
    publisher,
    totalIssues,
    format,
    status,
    cover,
    description,
    editionDetails,
    pages: editionPages,
    binding: editionBinding,
    price: editionPrice,
    synopsis,
    authors,
    issues,
    url: `https://www.whakoom.com/ediciones/${id}`,
  };
}

export { whakoom };
