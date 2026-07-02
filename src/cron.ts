import { Env } from './types';
import { fetchEdition } from './routes/whakoom';
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
