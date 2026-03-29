import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireApiKey } from '../middleware/auth';
import { now } from '../db/helpers';

/**
 * POST /scan
 * Body: { code: "9788467927894", type: "comic" | "book" }
 *
 * El ESP32 llama a este endpoint con el código EAN/ISBN escaneado.
 * Si el item ya existe en la BD, devuelve el existente.
 * Si no existe, lo crea con datos mínimos (solo el EAN) para que el usuario
 * rellene el resto desde el front.
 * En el futuro aquí se integrará la búsqueda en Whakoom / OpenLibrary.
 */

const scan = new Hono<AppContext>();

scan.use('*', requireApiKey);

scan.post('/', async (c) => {
  const body = await c.req.json<{ code: string; type?: 'comic' | 'book' }>();

  if (!body.code) {
    return c.json({ error: 'Falta el código de barras' }, 400);
  }

  const code = body.code.trim();
  const itemType = body.type ?? 'book'; // por defecto asume libro

  if (itemType === 'comic') {
    // Buscar en cómics por ISBN o EAN
    const existing = await c.env.DB
      .prepare('SELECT * FROM comics WHERE isbn = ? OR ean = ? LIMIT 1')
      .bind(code, code)
      .first<Record<string, unknown>>();

    if (existing) {
      return c.json({
        action: 'found',
        type: 'comic',
        item: { ...existing, owned: existing['owned'] === 1 }
      });
    }

    // Crear nuevo cómic con datos mínimos
    const result = await c.env.DB.prepare(`
      INSERT INTO comics (title, ean, owned, read_status, created_at, updated_at)
      VALUES (?, ?, 1, 'unread', ?, ?)
    `).bind(`Cómic EAN: ${code}`, code, now(), now()).run();

    const created = await c.env.DB
      .prepare('SELECT * FROM comics WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<Record<string, unknown>>();

    return c.json({
      action: 'created',
      type: 'comic',
      item: { ...created, owned: true },
      message: 'Cómic creado con datos mínimos. Edítalo para completar la información.'
    }, 201);

  } else {
    // Buscar en libros por ISBN o EAN
    const existing = await c.env.DB
      .prepare('SELECT * FROM books WHERE isbn = ? OR isbn13 = ? OR ean = ? LIMIT 1')
      .bind(code, code, code)
      .first<Record<string, unknown>>();

    if (existing) {
      return c.json({
        action: 'found',
        type: 'book',
        item: { ...existing, owned: existing['owned'] === 1 }
      });
    }

    // Crear nuevo libro con datos mínimos
    const result = await c.env.DB.prepare(`
      INSERT INTO books (title, ean, isbn13, owned, read_status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'unread', ?, ?)
    `).bind(`Libro EAN: ${code}`, code, code, now(), now()).run();

    const created = await c.env.DB
      .prepare('SELECT * FROM books WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<Record<string, unknown>>();

    return c.json({
      action: 'created',
      type: 'book',
      item: { ...created, owned: true },
      message: 'Libro creado con datos mínimos. Edítalo para completar la información.'
    }, 201);
  }
});

export { scan };
