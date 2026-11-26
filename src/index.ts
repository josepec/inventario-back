import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AppContext, Env } from './types';
import { resyncTrackedCollections, refreshWantedReleaseMonths } from './cron';
import { refreshWishlist } from './services/game-releases';
import { syncTrophies } from './services/trophies';
import { auth } from './routes/auth';
import { comics } from './routes/comics';
import { books } from './routes/books';
import { stats } from './routes/stats';
import { scan } from './routes/scan';
import { whakoom } from './routes/whakoom';
import { collections } from './routes/collections';
import { covers } from './routes/covers';
import { googleBooks } from './routes/google-books';
import { wanted } from './routes/wanted';
import { games } from './routes/games';

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
    // Permite previews de Pages (deploy URLs únicas y alias de rama).
    // El proyecto de Pages se llama "inventario" → inventario-cb7.pages.dev.
    if (origin.endsWith('.inventario-front.pages.dev')) return origin;
    if (origin === 'https://inventario-cb7.pages.dev' || origin.endsWith('.inventario-cb7.pages.dev')) return origin;
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
app.route('/wanted', wanted);
app.route('/games', games);

// Health check
app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// 404
app.notFound((c) => c.json({ error: 'Ruta no encontrada' }, 404));

// Worker con fetch (Hono) + scheduled (Cron Trigger).
// El cron refresca a diario el catálogo de las colecciones con tracking para que
// las novedades aparezcan sin tener que entrar en cada colección manualmente,
// y la fecha de salida de la lista "Lo quiero" (por si la editorial la retrasa).
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Un solo cron ("0,30 6 * * *", ver wrangler.toml): a y media, trofeos.
    if (new Date(event.scheduledTime).getUTCMinutes() >= 30) {
      ctx.waitUntil(syncTrophies(env).then(
        r => console.log('trofeos:', JSON.stringify(r)),
        e => console.error('trofeos:', e),
      ));
      return;
    }
    ctx.waitUntil(resyncTrackedCollections(env).finally(() => refreshWantedReleaseMonths(env)));
    // "Lo quiero" de videojuegos: las fechas de salida cambian (retrasos, fecha concreta).
    ctx.waitUntil(refreshWishlist(env).then(
      r => console.log('lo quiero (juegos):', JSON.stringify(r)),
      e => console.error('lo quiero (juegos):', e),
    ));
  },
};
