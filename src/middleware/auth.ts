import { MiddlewareHandler } from 'hono';
import { Jwt } from 'hono/utils/jwt';
import { AppContext, JwtPayload } from '../types';

export const requireApiKey: MiddlewareHandler<AppContext> = async (c, next) => {
  const key = c.req.header('X-Api-Key');
  if (!key || key !== c.env.ESP32_API_KEY) {
    return c.json({ error: 'API key inválida' }, 401);
  }
  await next();
};

export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'No autorizado' }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = await Jwt.verify(token, c.env.JWT_SECRET, 'HS256') as unknown as JwtPayload;
    c.set('jwtPayload', payload);
    await next();
  } catch {
    return c.json({ error: 'Token inválido o expirado' }, 401);
  }
};
