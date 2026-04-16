import { Hono } from 'hono';
import { AppContext } from '../types';
import { requireAuth } from '../middleware/auth';

const stats = new Hono<AppContext>();

stats.use('*', requireAuth);

// Clasifica cada comic en uno de 7 buckets canonicos:
// grapa, rustica, cartone, lujo, integral, album, null.
// Se prefiere col.format (label curado de Whakoom en class="edition-type")
// porque c.binding/c.pages estaban contaminados con datos de la edicion padre.
// Para comics sin coleccion se cae a c.binding como fallback.
//
// LIKE con '_' matchea tildes ("rustica" → 'r_stica%' matchea 'rústica').
// El orden del CASE importa: integral/lujo/album van primero porque algunos
// tomos recopilatorios (Cartoné) tambien son Integrales y queremos etiquetarlos
// como 'integral', no como 'cartone'.
const CLASSIFIED_CTE = `
  WITH classified AS (
    SELECT
      LOWER(TRIM(c.publisher)) AS p,
      c.price,
      CASE
        WHEN col.format IS NOT NULL THEN
          CASE
            WHEN LOWER(col.format) LIKE '%integral%' THEN 'integral'
            WHEN LOWER(col.format) LIKE '%lujo%'     THEN 'lujo'
            WHEN LOWER(col.format) LIKE '%lbum%'     THEN 'album'
            WHEN LOWER(col.format) LIKE 'grapa%'     THEN 'grapa'
            WHEN LOWER(col.format) LIKE 'r_stica%'   THEN 'rustica'
            WHEN LOWER(col.format) LIKE 'softcover%' THEN 'rustica'
            WHEN LOWER(col.format) LIKE 'tapa blanda%' THEN 'rustica'
            WHEN LOWER(col.format) LIKE 'bolsillo%'  THEN 'rustica'
            WHEN LOWER(col.format) LIKE 'carton%'    THEN 'cartone'
            WHEN LOWER(col.format) LIKE 'tapa dura%' THEN 'cartone'
            WHEN LOWER(col.format) LIKE 'hardcover%' THEN 'cartone'
            ELSE 'null'
          END
        WHEN c.binding IS NOT NULL THEN
          CASE
            WHEN LOWER(c.binding) LIKE '%integral%' THEN 'integral'
            WHEN LOWER(c.binding) LIKE '%lujo%'     THEN 'lujo'
            WHEN LOWER(c.binding) LIKE '%lbum%'     THEN 'album'
            WHEN LOWER(c.binding) LIKE 'grapa%'     THEN 'grapa'
            WHEN LOWER(c.binding) LIKE 'r_stica%'   THEN 'rustica'
            WHEN LOWER(c.binding) LIKE 'carton%'    THEN 'cartone'
            WHEN LOWER(c.binding) LIKE 'tapa dura%' THEN 'cartone'
            WHEN LOWER(c.binding) LIKE 'tapa blanda%' THEN 'rustica'
            ELSE 'null'
          END
        ELSE 'null'
      END AS b
    FROM comics c
    LEFT JOIN collections col ON col.id = c.collection_id
  )
`;

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

// Rich dashboard stats — comics
stats.get('/dashboard', async (c) => {
  const db = c.env.DB;

  const statsStartRow = await db.prepare("SELECT value FROM settings WHERE key = 'stats_start_date'").first<{ value: string }>();
  const statsStartDate = statsStartRow?.value ?? null;

  const [
    totals, monthlyAdded, monthlyRead, byPublisher, byRating,
    collections, recentComics, totalSpent, yearSummary, prevYearSummary,
    priceByPubBinding, priceByPub, priceByBinding, unpricedGroups,
  ] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) as read,
        SUM(CASE WHEN read_status = 'unread' THEN 1 ELSE 0 END) as unread,
        SUM(CASE WHEN read_status = 'reading' THEN 1 ELSE 0 END) as reading,
        (SELECT COUNT(*) FROM collections) as collections
      FROM comics
    `).first<Record<string, number>>(),

    statsStartDate
      ? db.prepare(`
          SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
          FROM comics WHERE created_at >= ? AND created_at >= date('now', '-12 months')
          GROUP BY month ORDER BY month
        `).bind(statsStartDate).all<{ month: string; count: number }>()
      : Promise.resolve({ results: [] as { month: string; count: number }[] }),

    statsStartDate
      ? db.prepare(`
          SELECT strftime('%Y-%m', updated_at) as month, COUNT(*) as count
          FROM comics WHERE read_status = 'read' AND updated_at >= ? AND updated_at >= date('now', '-12 months')
          GROUP BY month ORDER BY month
        `).bind(statsStartDate).all<{ month: string; count: number }>()
      : Promise.resolve({ results: [] as { month: string; count: number }[] }),

    db.prepare(`
      SELECT COALESCE(publisher, 'Desconocida') as publisher, COUNT(*) as count
      FROM comics GROUP BY publisher ORDER BY count DESC LIMIT 10
    `).all<{ publisher: string; count: number }>(),

    db.prepare(`
      SELECT rating, COUNT(*) as count FROM comics WHERE rating IS NOT NULL GROUP BY rating ORDER BY rating
    `).all<{ rating: number; count: number }>(),

    db.prepare(`
      SELECT c.id, c.title, c.total_issues, c.cover_url, c.rating,
        (SELECT COUNT(*) FROM comics WHERE collection_id = c.id) as owned
      FROM collections c
      WHERE c.total_issues > 0
        AND c.tracking >= 1
        AND (SELECT COUNT(*) FROM comics WHERE collection_id = c.id) < c.total_issues
      ORDER BY (CAST((SELECT COUNT(*) FROM comics WHERE collection_id = c.id) AS REAL) / c.total_issues) DESC
      LIMIT 8
    `).all<{ id: number; title: string; total_issues: number; cover_url: string | null; rating: number | null; owned: number }>(),

    db.prepare(`SELECT id, title, cover_url, rating, created_at FROM comics ORDER BY created_at DESC LIMIT 8`
    ).all<{ id: number; title: string; cover_url: string | null; rating: number | null; created_at: string }>(),

    db.prepare(`SELECT COALESCE(SUM(price), 0) as total, AVG(price) as avg FROM comics WHERE price IS NOT NULL`
    ).first<{ total: number; avg: number }>(),

    db.prepare(`
      SELECT COUNT(*) as added, SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) as read, COALESCE(SUM(price), 0) as spent
      FROM comics WHERE strftime('%Y', created_at) = strftime('%Y', 'now')
    `).first<{ added: number; read: number; spent: number }>(),

    db.prepare(`
      SELECT COUNT(*) as added, SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) as read, COALESCE(SUM(price), 0) as spent
      FROM comics WHERE strftime('%Y', created_at) = CAST(strftime('%Y', 'now') AS INTEGER) - 1
    `).first<{ added: number; read: number; spent: number }>(),

    // Price estimation — aggregates for projecting unpriced comics.
    // Agrupa via CLASSIFIED_CTE (7 buckets canonicos derivados de col.format).
    // Fallback chain: (publisher+bucket) → publisher → bucket → global avg.
    db.prepare(`
      ${CLASSIFIED_CTE}
      SELECT p, b, AVG(price) a, COUNT(*) n
      FROM classified WHERE price IS NOT NULL AND price > 0
      GROUP BY p, b HAVING n >= 3
    `).all<{ p: string | null; b: string | null; a: number; n: number }>(),

    db.prepare(`
      ${CLASSIFIED_CTE}
      SELECT p, AVG(price) a, COUNT(*) n
      FROM classified WHERE price IS NOT NULL AND price > 0
      GROUP BY p HAVING n >= 3
    `).all<{ p: string | null; a: number; n: number }>(),

    db.prepare(`
      ${CLASSIFIED_CTE}
      SELECT b, AVG(price) a, COUNT(*) n
      FROM classified WHERE price IS NOT NULL AND price > 0
      GROUP BY b HAVING n >= 3
    `).all<{ b: string | null; a: number; n: number }>(),

    db.prepare(`
      ${CLASSIFIED_CTE}
      SELECT p, b, COUNT(*) c
      FROM classified WHERE price IS NULL OR price = 0
      GROUP BY p, b
    `).all<{ p: string | null; b: string | null; c: number }>(),
  ]);

  let thisMonthSpent = 0;
  let prevMonthSpent = 0;
  if (statsStartDate) {
    const [thisM, prevM] = await Promise.all([
      db.prepare(`SELECT COALESCE(SUM(price), 0) as spent FROM comics WHERE price IS NOT NULL AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND created_at >= ?`).bind(statsStartDate).first<{ spent: number }>(),
      db.prepare(`SELECT COALESCE(SUM(price), 0) as spent FROM comics WHERE price IS NOT NULL AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', '-1 month') AND created_at >= ?`).bind(statsStartDate).first<{ spent: number }>(),
    ]);
    thisMonthSpent = thisM?.spent ?? 0;
    prevMonthSpent = prevM?.spent ?? 0;
  }

  // Price estimation: project unpriced comics using grouped averages.
  // Fallback chain: (publisher+binding) → publisher → binding → global avg.
  const realTotal = totalSpent?.total ?? 0;
  const realAvg = totalSpent?.avg ?? 0;
  const totalComics = totals?.total ?? 0;
  const pbMap = new Map<string, number>();
  for (const r of priceByPubBinding.results) pbMap.set(`${r.p ?? ''}|${r.b ?? ''}`, r.a);
  const pMap = new Map<string, number>();
  for (const r of priceByPub.results) pMap.set(r.p ?? '', r.a);
  const bMap = new Map<string, number>();
  for (const r of priceByBinding.results) bMap.set(r.b ?? '', r.a);

  let estimatedMissing = 0;
  let missingCount = 0;
  for (const g of unpricedGroups.results) {
    const key = `${g.p ?? ''}|${g.b ?? ''}`;
    const est = pbMap.get(key) ?? pMap.get(g.p ?? '') ?? bMap.get(g.b ?? '') ?? realAvg;
    estimatedMissing += est * g.c;
    missingCount += g.c;
  }
  const estimatedTotal = realTotal + estimatedMissing;
  const estimatedAvg = totalComics > 0 ? estimatedTotal / totalComics : 0;
  const missingPct = totalComics > 0 ? (missingCount / totalComics) * 100 : 0;

  return c.json({
    totals: {
      comics: totals?.total ?? 0, read: totals?.read ?? 0,
      unread: totals?.unread ?? 0, reading: totals?.reading ?? 0,
      collections: totals?.collections ?? 0,
    },
    monthly: { added: monthlyAdded.results, read: monthlyRead.results },
    byPublisher: byPublisher.results,
    byRating: byRating.results,
    collections: collections.results,
    recentComics: recentComics.results,
    spending: {
      total: realTotal,
      avg: realAvg ? Math.round(realAvg * 100) / 100 : 0,
      estimatedTotal: Math.round(estimatedTotal),
      estimatedAvg: Math.round(estimatedAvg * 100) / 100,
      missingCount,
      missingPct: Math.round(missingPct * 10) / 10,
    },
    thisYear: yearSummary ?? { added: 0, read: 0, spent: 0 },
    prevYear: prevYearSummary ?? { added: 0, read: 0, spent: 0 },
    monthlySpending: { thisMonth: thisMonthSpent, prevMonth: prevMonthSpent },
    statsStartDate,
  });
});

// Rich dashboard stats — books
stats.get('/dashboard/books', async (c) => {
  const db = c.env.DB;

  const statsStartRow = await db.prepare("SELECT value FROM settings WHERE key = 'stats_start_date'").first<{ value: string }>();
  const statsStartDate = statsStartRow?.value ?? null;

  const [
    totals, monthlyAdded, monthlyRead, byPublisher, byGenre, byRating,
    bySaga, recentBooks, totalSpent, yearSummary, prevYearSummary,
  ] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) as read,
        SUM(CASE WHEN read_status = 'unread' THEN 1 ELSE 0 END) as unread,
        COUNT(DISTINCT saga) as sagas
      FROM books
    `).first<Record<string, number>>(),

    statsStartDate
      ? db.prepare(`
          SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
          FROM books WHERE created_at >= ? AND created_at >= date('now', '-12 months')
          GROUP BY month ORDER BY month
        `).bind(statsStartDate).all<{ month: string; count: number }>()
      : Promise.resolve({ results: [] as { month: string; count: number }[] }),

    statsStartDate
      ? db.prepare(`
          SELECT strftime('%Y-%m', updated_at) as month, COUNT(*) as count
          FROM books WHERE read_status = 'read' AND updated_at >= ? AND updated_at >= date('now', '-12 months')
          GROUP BY month ORDER BY month
        `).bind(statsStartDate).all<{ month: string; count: number }>()
      : Promise.resolve({ results: [] as { month: string; count: number }[] }),

    db.prepare(`
      SELECT COALESCE(publisher, 'Desconocida') as publisher, COUNT(*) as count
      FROM books GROUP BY publisher ORDER BY count DESC LIMIT 10
    `).all<{ publisher: string; count: number }>(),

    db.prepare(`
      SELECT COALESCE(genre, 'Sin genero') as genre, COUNT(*) as count
      FROM books GROUP BY genre ORDER BY count DESC LIMIT 10
    `).all<{ genre: string; count: number }>(),

    db.prepare(`
      SELECT rating, COUNT(*) as count FROM books WHERE rating IS NOT NULL GROUP BY rating ORDER BY rating
    `).all<{ rating: number; count: number }>(),

    db.prepare(`
      SELECT saga, COUNT(*) as count FROM books WHERE saga IS NOT NULL AND saga != '' GROUP BY saga ORDER BY count DESC LIMIT 8
    `).all<{ saga: string; count: number }>(),

    db.prepare(`SELECT id, title, cover_url, rating, created_at FROM books ORDER BY created_at DESC LIMIT 6`
    ).all<{ id: number; title: string; cover_url: string | null; rating: number | null; created_at: string }>(),

    db.prepare(`SELECT COALESCE(SUM(price), 0) as total, AVG(price) as avg FROM books WHERE price IS NOT NULL`
    ).first<{ total: number; avg: number }>(),

    db.prepare(`
      SELECT COUNT(*) as added, SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) as read, COALESCE(SUM(price), 0) as spent
      FROM books WHERE strftime('%Y', created_at) = strftime('%Y', 'now')
    `).first<{ added: number; read: number; spent: number }>(),

    db.prepare(`
      SELECT COUNT(*) as added, SUM(CASE WHEN read_status = 'read' THEN 1 ELSE 0 END) as read, COALESCE(SUM(price), 0) as spent
      FROM books WHERE strftime('%Y', created_at) = CAST(strftime('%Y', 'now') AS INTEGER) - 1
    `).first<{ added: number; read: number; spent: number }>(),
  ]);

  let thisMonthSpent = 0;
  let prevMonthSpent = 0;
  if (statsStartDate) {
    const [thisM, prevM] = await Promise.all([
      db.prepare(`SELECT COALESCE(SUM(price), 0) as spent FROM books WHERE price IS NOT NULL AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND created_at >= ?`).bind(statsStartDate).first<{ spent: number }>(),
      db.prepare(`SELECT COALESCE(SUM(price), 0) as spent FROM books WHERE price IS NOT NULL AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', '-1 month') AND created_at >= ?`).bind(statsStartDate).first<{ spent: number }>(),
    ]);
    thisMonthSpent = thisM?.spent ?? 0;
    prevMonthSpent = prevM?.spent ?? 0;
  }

  return c.json({
    totals: {
      books: totals?.total ?? 0, read: totals?.read ?? 0,
      unread: totals?.unread ?? 0, sagas: totals?.sagas ?? 0,
    },
    monthly: { added: monthlyAdded.results, read: monthlyRead.results },
    byPublisher: byPublisher.results,
    byGenre: byGenre.results,
    byRating: byRating.results,
    bySaga: bySaga.results,
    recentBooks: recentBooks.results,
    spending: { total: totalSpent?.total ?? 0, avg: totalSpent?.avg ? Math.round(totalSpent.avg * 100) / 100 : 0 },
    thisYear: yearSummary ?? { added: 0, read: 0, spent: 0 },
    prevYear: prevYearSummary ?? { added: 0, read: 0, spent: 0 },
    monthlySpending: { thisMonth: thisMonthSpent, prevMonth: prevMonthSpent },
    statsStartDate,
  });
});

export { stats };
