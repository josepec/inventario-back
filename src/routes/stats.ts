import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';

const stats = new Hono<AppContext>();

stats.use('*', requireAuth);

// Basic stats (legacy)
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

// Get stats_start_date setting
stats.get('/settings/stats-start', async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'stats_start_date'").first<{ value: string }>();
  return c.json({ date: row?.value ?? null });
});

// Set stats_start_date to today
stats.post('/settings/stats-start', async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('stats_start_date', ?) ON CONFLICT(key) DO UPDATE SET value = ?"
  ).bind(today, today).run();
  return c.json({ date: today });
});

// Rich dashboard stats
stats.get('/dashboard', async (c) => {
  const db = c.env.DB;

  // Check if monthly tracking is active
  const statsStartRow = await db.prepare("SELECT value FROM settings WHERE key = 'stats_start_date'").first<{ value: string }>();
  const statsStartDate = statsStartRow?.value ?? null;

  const [
    totals,
    monthlyAdded,
    monthlyRead,
    byPublisher,
    byRating,
    collections,
    recentComics,
    totalSpent,
    yearSummary,
    prevYearSummary,
  ] = await Promise.all([
    // Totals
    db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) as read,
        SUM(CASE WHEN read_status = 'unread' THEN 1 ELSE 0 END) as unread,
        SUM(CASE WHEN read_status = 'reading' THEN 1 ELSE 0 END) as reading,
        (SELECT COUNT(*) FROM collections) as collections
      FROM comics
    `).first<Record<string, number>>(),

    // Monthly added (last 12 months, only after stats_start_date)
    statsStartDate
      ? db.prepare(`
          SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
          FROM comics
          WHERE created_at >= ? AND created_at >= date('now', '-12 months')
          GROUP BY month ORDER BY month
        `).bind(statsStartDate).all<{ month: string; count: number }>()
      : Promise.resolve({ results: [] as { month: string; count: number }[] }),

    // Monthly read (only after stats_start_date)
    statsStartDate
      ? db.prepare(`
          SELECT strftime('%Y-%m', updated_at) as month, COUNT(*) as count
          FROM comics
          WHERE read_status = 'read' AND updated_at >= ? AND updated_at >= date('now', '-12 months')
          GROUP BY month ORDER BY month
        `).bind(statsStartDate).all<{ month: string; count: number }>()
      : Promise.resolve({ results: [] as { month: string; count: number }[] }),

    // By publisher (top 10)
    db.prepare(`
      SELECT COALESCE(publisher, 'Desconocida') as publisher, COUNT(*) as count
      FROM comics
      GROUP BY publisher ORDER BY count DESC LIMIT 10
    `).all<{ publisher: string; count: number }>(),

    // By rating
    db.prepare(`
      SELECT rating, COUNT(*) as count FROM comics
      WHERE rating IS NOT NULL
      GROUP BY rating ORDER BY rating
    `).all<{ rating: number; count: number }>(),

    // Collection progress (incomplete collections, sorted by most progress)
    db.prepare(`
      SELECT c.id, c.title, c.total_issues, c.cover_url, c.rating,
        (SELECT COUNT(*) FROM comics WHERE collection_id = c.id) as owned
      FROM collections c
      WHERE c.total_issues > 0
        AND (SELECT COUNT(*) FROM comics WHERE collection_id = c.id) < c.total_issues
      ORDER BY (CAST((SELECT COUNT(*) FROM comics WHERE collection_id = c.id) AS REAL) / c.total_issues) DESC
      LIMIT 8
    `).all<{ id: number; title: string; total_issues: number; cover_url: string | null; rating: number | null; owned: number }>(),

    // Recent comics (last 6)
    db.prepare(`
      SELECT id, title, cover_url, rating, created_at
      FROM comics ORDER BY created_at DESC LIMIT 6
    `).all<{ id: number; title: string; cover_url: string | null; rating: number | null; created_at: string }>(),

    // Total spent
    db.prepare(`
      SELECT COALESCE(SUM(price), 0) as total, AVG(price) as avg
      FROM comics WHERE price IS NOT NULL
    `).first<{ total: number; avg: number }>(),

    // Current year summary
    db.prepare(`
      SELECT
        COUNT(*) as added,
        SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) as read,
        COALESCE(SUM(price), 0) as spent
      FROM comics
      WHERE strftime('%Y', created_at) = strftime('%Y', 'now')
    `).first<{ added: number; read: number; spent: number }>(),

    // Previous year summary
    db.prepare(`
      SELECT
        COUNT(*) as added,
        SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) as read,
        COALESCE(SUM(price), 0) as spent
      FROM comics
      WHERE strftime('%Y', created_at) = CAST(strftime('%Y', 'now') AS INTEGER) - 1
    `).first<{ added: number; read: number; spent: number }>(),
  ]);

  // Monthly spending (current + previous month) — only if tracking active
  let thisMonthSpent = 0;
  let prevMonthSpent = 0;
  if (statsStartDate) {
    const [thisM, prevM] = await Promise.all([
      db.prepare(`
        SELECT COALESCE(SUM(price), 0) as spent FROM comics
        WHERE price IS NOT NULL AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
          AND created_at >= ?
      `).bind(statsStartDate).first<{ spent: number }>(),
      db.prepare(`
        SELECT COALESCE(SUM(price), 0) as spent FROM comics
        WHERE price IS NOT NULL AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', '-1 month')
          AND created_at >= ?
      `).bind(statsStartDate).first<{ spent: number }>(),
    ]);
    thisMonthSpent = thisM?.spent ?? 0;
    prevMonthSpent = prevM?.spent ?? 0;
  }

  return c.json({
    totals: {
      comics: totals?.total ?? 0,
      read: totals?.read ?? 0,
      unread: totals?.unread ?? 0,
      reading: totals?.reading ?? 0,
      collections: totals?.collections ?? 0,
    },
    monthly: {
      added: monthlyAdded.results,
      read: monthlyRead.results,
    },
    byPublisher: byPublisher.results,
    byRating: byRating.results,
    collections: collections.results,
    recentComics: recentComics.results,
    spending: {
      total: totalSpent?.total ?? 0,
      avg: totalSpent?.avg ? Math.round(totalSpent.avg * 100) / 100 : 0,
    },
    thisYear: yearSummary ?? { added: 0, read: 0, spent: 0 },
    prevYear: prevYearSummary ?? { added: 0, read: 0, spent: 0 },
    monthlySpending: { thisMonth: thisMonthSpent, prevMonth: prevMonthSpent },
    statsStartDate,
  });
});

export { stats };
