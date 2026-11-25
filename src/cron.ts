import { Env } from './types';
import { fetchEdition, whakoomFetch, extractDatePublished } from './routes/whakoom';
import { now } from './db/helpers';

// Resincroniza el catálogo de números (issues) de todas las colecciones con
// tracking activo desde Whakoom. Antes esto solo ocurría al abrir cada colección
// (lazy, una vez cada 24 h), lo que hacía que las "novedades" no aparecieran
// hasta visitar la colección. El cron lo hace de forma centralizada y proactiva.
export async function resyncTrackedCollections(
  env: Env,
): Promise<{ synced: number; failed: number; total: number }> {
  const { results } = await env.DB.prepare(
    `SELECT id, whakoom_id, title FROM collections
      WHERE tracking >= 1 AND whakoom_id IS NOT NULL AND whakoom_id != ''`
  ).all<{ id: number; whakoom_id: string; title: string }>();

  let synced = 0;
  let failed = 0;

  for (const col of results) {
    try {
      const ed = await fetchEdition(env, col.whakoom_id);
      if (!ed) { failed++; continue; }

      // No sobreescribir con arrays/valores vacíos: COALESCE(?, col) conserva
      // lo previo cuando el parseo no encontró datos (mismo criterio que el front).
      const issuesJson = ed.issues && ed.issues.length > 0 ? JSON.stringify(ed.issues) : null;
      const authorsJson = ed.structuredAuthors && ed.structuredAuthors.length > 0
        ? JSON.stringify(ed.structuredAuthors) : null;

      await env.DB.prepare(
        `UPDATE collections SET
           issues            = COALESCE(?, issues),
           authors           = COALESCE(?, authors),
           total_issues      = COALESCE(?, total_issues),
           format            = COALESCE(?, format),
           status            = COALESCE(?, status),
           edition_details   = COALESCE(?, edition_details),
           synopsis          = COALESCE(?, synopsis),
           whakoom_synced_at = ?,
           updated_at        = ?
         WHERE id = ?`
      ).bind(
        issuesJson,
        authorsJson,
        ed.totalIssues || null,
        ed.format || null,
        ed.status || null,
        ed.editionDetails || null,
        ed.synopsis || null,
        new Date().toISOString(),
        now(),
        col.id,
      ).run();

      synced++;
    } catch {
      failed++;
    }

    // Pequeña pausa entre peticiones para no saturar la sesión de Whakoom.
    await new Promise((r) => setTimeout(r, 800));
  }

  return { synced, failed, total: results.length };
}

// Refresca release_month de la lista "Lo quiero". El mes se guarda al marcarlo
// y antes no se tocaba nunca: si la editorial retrasaba la salida (El depravado,
// añadido para octubre y movido al 20/11), seguia en su mes viejo, desaparecia
// de "Mis novedades" del mes real y salia en Atrasados. Solo se mira lo de este
// mes en adelante o del mes pasado (un retraso tipico); lo mas antiguo ya salio.
// Si la ficha no trae fecha propia, se conserva la que habia.
export async function refreshWantedReleaseMonths(
  env: Env,
): Promise<{ checked: number; changed: number; failed: number }> {
  const d = new Date();
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const prevMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;

  const { results } = await env.DB.prepare(
    `SELECT whakoom_comic_id, comics_url_path, release_month FROM wanted_comics
      WHERE release_month IS NULL OR release_month >= ?`
  ).bind(prevMonth).all<{ whakoom_comic_id: string; comics_url_path: string | null; release_month: string | null }>();

  let changed = 0;
  let failed = 0;

  for (const w of results) {
    try {
      const path = w.comics_url_path || `/comics/${w.whakoom_comic_id}`;
      const res = await whakoomFetch(`https://www.whakoom.com${path}`, env);
      const html = res.ok ? await res.text() : '';
      if (!html || html.includes('/login?ReturnUrl')) { failed++; continue; }

      const date = extractDatePublished(html);
      const month = /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : null;
      if (month && month !== w.release_month) {
        await env.DB.prepare('UPDATE wanted_comics SET release_month = ? WHERE whakoom_comic_id = ?')
          .bind(month, w.whakoom_comic_id).run();
        changed++;
      }
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  return { checked: results.length, changed, failed };
}
