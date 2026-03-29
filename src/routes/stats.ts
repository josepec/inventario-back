import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';

const stats = new Hono<AppContext>();

stats.use('*', requireAuth);

stats.get('/', async (c) => {
  const [comicsTotal, comicsRead, comicsOwned, booksTotal, booksRead, booksOwned] =
    await Promise.all([
      c.env.DB.prepare("SELECT COUNT(*) as n FROM comics").first<{ n: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) as n FROM comics WHERE read_status='read'").first<{ n: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) as n FROM comics WHERE owned=1").first<{ n: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) as n FROM books").first<{ n: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) as n FROM books WHERE read_status='read'").first<{ n: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) as n FROM books WHERE owned=1").first<{ n: number }>(),
    ]);

  return c.json({
    comics_total:  comicsTotal?.n ?? 0,
    comics_read:   comicsRead?.n ?? 0,
    comics_owned:  comicsOwned?.n ?? 0,
    books_total:   booksTotal?.n ?? 0,
    books_read:    booksRead?.n ?? 0,
    books_owned:   booksOwned?.n ?? 0,
  });
});

export { stats };
