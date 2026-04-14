-- Limpieza one-shot de pages/binding contaminados.
--
-- Causa: parseComic en whakoom.ts llamaba a extractEditionFields con un fallback
-- a fullHtml. Cuando la seccion "Sobre esta edicion" no existia en el HTML del
-- comic individual (lo normal en grapas), el regex capturaba el primer "\d+ pp"
-- de la pagina, que era el total de la edicion padre. Ese numero se aplicaba a
-- todos los issues de la coleccion, haciendo que 9 grapas de El Multiverso
-- mostraran pages=480, 110 issues de Batman (2012-2024) mostraran pages=360, etc.
-- El fallback se quito en parseComic (commit de este mismo lote).
--
-- Criterio de limpieza (conservador, preserva datos reales):
--   - pages > 80 (una grapa real nunca pasa de 80pp)
--   - col.format NO contiene "<pages> pp" (si lo contiene, es dato curado real,
--     ej. "Grapa 32 pp" con pages=32 es consistente y se respeta)
--   - >=3 issues de la coleccion comparten el mismo pages (firma de propagacion)
--
-- binding tambien se pone a NULL en esas filas por la misma razon: el regex
-- compartido tambien contaminaba el binding con el label de la edicion padre.
-- Tras el fix del frontend, col.format actua como fallback fiable para binding.
--
-- Price NO se toca: la auditoria mostro que los 86 precios contaminados
-- coincidian por construccion con el precio real de las grapas (p.ej. Paper
-- Girls @ 2.50 EUR), asi que son funcionalmente correctos.
--
-- Verificado en dry-run: 400 comics en 105 colecciones.

UPDATE comics
SET pages = NULL, binding = NULL, updated_at = datetime('now')
WHERE id IN (
  SELECT c.id
  FROM comics c
  LEFT JOIN collections col ON col.id = c.collection_id
  WHERE c.pages IS NOT NULL
    AND c.pages > 80
    AND (col.format IS NULL OR col.format NOT LIKE '%' || c.pages || ' pp%')
    AND (c.collection_id, c.pages) IN (
      SELECT collection_id, pages
      FROM comics
      WHERE pages IS NOT NULL AND collection_id IS NOT NULL
      GROUP BY collection_id, pages
      HAVING COUNT(*) >= 3
    )
);
