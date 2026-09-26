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
    if (!contentType.startsWith('image/')) {
      return c.json({ error: `La URL no es una imagen (${contentType.split(';')[0]})` }, 422);
    }

    // Se lee entera en vez de pasar el stream: R2 exige saber la longitud, y hay
    // CDN que sirven sin Content-Length (Open Library → archive.org, en chunked)
    const data = await res.arrayBuffer();
    if (data.byteLength === 0) return c.json({ error: 'La imagen está vacía' }, 502);
    const ext = contentType.includes('png') ? 'png'
      : contentType.includes('webp') ? 'webp'
      : contentType.includes('gif') ? 'gif'
      : 'jpg';

    // Key: sin prefijo redundante — la ruta /covers/ ya lo provee
    const key = body.key
      ? `${body.key}.${ext}`
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    await c.env.COVERS.put(key, data, {
      httpMetadata: { contentType },
    });

    return c.json({ key, url: `/covers/${key}` });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// POST /covers/upload-file — subir una imagen propia (foto o escaneo) a R2
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

covers.post('/upload-file', requireAuth, async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) return c.json({ error: 'Falta el fichero' }, 400);
  if (!file.type.startsWith('image/')) return c.json({ error: 'No es una imagen' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'La imagen pasa de 8 MB' }, 413);

  const ext = file.type.includes('png') ? 'png' : file.type.includes('webp') ? 'webp' : 'jpg';
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await c.env.COVERS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  return c.json({ key, url: `/covers/${key}` });
});

// DELETE /covers/:key — borrar imagen de R2
covers.delete('/:key{.+}', requireAuth, async (c) => {
  const key = c.req.param('key');
  await c.env.COVERS.delete(key);
  return c.json({ ok: true });
});

export { covers };
