import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';

const covers = new Hono<AppContext>();

// GET /covers/:key — servir imagen desde R2 (público, sin auth)
covers.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const obj = await c.env.COVERS.get(key);
  if (!obj) return c.json({ error: 'Not found' }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(obj.body, { headers });
});

// POST /covers/upload — descargar imagen de URL y guardarla en R2
covers.post('/upload', requireAuth, async (c) => {
  const body = await c.req.json<{ url: string; key?: string }>();
  const url = body.url;
  if (!url) return c.json({ error: 'url requerida' }, 400);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/*,*/*;q=0.8',
      },
    });

    if (!res.ok) return c.json({ error: `No se pudo descargar: ${res.status}` }, 502);

    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const ext = contentType.includes('png') ? 'png'
      : contentType.includes('webp') ? 'webp'
      : contentType.includes('gif') ? 'gif'
      : 'jpg';

    // Key: sin prefijo redundante — la ruta /covers/ ya lo provee
    const key = body.key
      ? `${body.key}.${ext}`
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    await c.env.COVERS.put(key, res.body!, {
      httpMetadata: { contentType },
    });

    return c.json({ key, url: `/covers/${key}` });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// DELETE /covers/:key — borrar imagen de R2
covers.delete('/:key{.+}', requireAuth, async (c) => {
  const key = c.req.param('key');
  await c.env.COVERS.delete(key);
  return c.json({ ok: true });
});

export { covers };
