import { Hono } from 'hono';
import { Jwt } from 'hono/utils/jwt';
import { AppContext } from '../types';

// Simple bcrypt-compatible hash check via Web Crypto
// D1/Workers no tienen bcrypt nativo — usamos una comparación HMAC-SHA256
// En producción, usar un endpoint de hashing externo o Web Crypto con PBKDF2

async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  // El hash almacenado tiene formato: "pbkdf2:salt:hash"
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const salt = parts[1];
  const computed = await hashPassword(password, salt);
  return computed === parts[2];
}

export async function createPasswordHash(password: string): Promise<string> {
  const salt = btoa(crypto.getRandomValues(new Uint8Array(16)).join(''));
  const hash = await hashPassword(password, salt);
  return `pbkdf2:${salt}:${hash}`;
}

const auth = new Hono<AppContext>();

auth.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();

  if (!body.username || !body.password) {
    return c.json({ error: 'Usuario y contraseña requeridos' }, 400);
  }

  const user = await c.env.DB
    .prepare('SELECT * FROM users WHERE username = ?')
    .bind(body.username)
    .first<{ id: number; username: string; password: string; email: string | null }>();

  if (!user) {
    return c.json({ error: 'Credenciales incorrectas' }, 401);
  }

  const valid = await verifyPassword(body.password, user.password);
  if (!valid) {
    return c.json({ error: 'Credenciales incorrectas' }, 401);
  }

  const token = await Jwt.sign(
    { sub: user.id, username: user.username, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 },
    c.env.JWT_SECRET, 'HS256'
  );

  return c.json({
    token,
    user: { id: user.id, username: user.username, email: user.email }
  });
});

// Endpoint para crear el primer usuario / cambiar contraseña (proteger en prod)
auth.post('/setup', async (c) => {
  const body = await c.req.json<{ username: string; password: string; email?: string }>();
  if (!body.username || !body.password) {
    return c.json({ error: 'Faltan datos' }, 400);
  }

  const hash = await createPasswordHash(body.password);

  await c.env.DB
    .prepare('INSERT OR REPLACE INTO users (username, password, email) VALUES (?, ?, ?)')
    .bind(body.username, hash, body.email ?? null)
    .run();

  return c.json({ ok: true, message: `Usuario '${body.username}' creado/actualizado` });
});

export { auth };
