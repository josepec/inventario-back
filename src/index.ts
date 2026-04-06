import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AppContext } from './types';
import { auth } from './routes/auth';
import { comics } from './routes/comics';
import { books } from './routes/books';
import { stats } from './routes/stats';
import { scan } from './routes/scan';
import { whakoom } from './routes/whakoom';
import { collections } from './routes/collections';
import { covers } from './routes/covers';
import { googleBooks } from './routes/google-books';

const app = new Hono<AppContext>();

// CORS — permite el front en dev y producción
app.use('*', cors({
  origin: (origin) => {
    const allowed = [
      'http://localhost:4200',
      'http://localhost:4201',
      'https://inventario-front.pages.dev',
      'https://inventario.josepec.eu',
    ];
    if (!origin || allowed.includes(origin)) return origin ?? '*';
    // Permite previews de Pages (deploy URLs únicas)
    if (origin.endsWith('.inventario-front.pages.dev')) return origin;
    return null;
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}));

// Rutas
app.route('/auth', auth);
app.route('/comics', comics);
app.route('/books', books);
app.route('/stats', stats);
app.route('/scan', scan);
app.route('/whakoom', whakoom);
app.route('/collections', collections);
app.route('/covers', covers);
app.route('/google-books', googleBooks);

// Health check
app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// 404
app.notFound((c) => c.json({ error: 'Ruta no encontrada' }, 404));

export default app;
