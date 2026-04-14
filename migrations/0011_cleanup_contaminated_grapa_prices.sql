-- Limpieza one-shot de precios contaminados en grapas.
--
-- Causa: el mismo vector que pages/binding (fallback wk?.price en el frontend
-- al importar un issue). El PVP de la edicion recopilatoria ECC/Panini (24.95,
-- 23.95, 13.99 EUR tipicos) se aplicaba al issue #1 de cada coleccion cuando
-- detail.price venia null (lo normal en Whakoom para grapas).
--
-- La primera auditoria de price (migracion 0010) no pillo este caso porque
-- usaba el filtro ">=3 issues con el mismo precio". Estos 41 solo tienen el #1
-- priced por coleccion, asi que escaparon.
--
-- Criterio: price > 10 EUR en comics de colecciones con col.format LIKE 'grapa%'.
-- Una grapa real nunca pasa de ~6 EUR; >10 EUR es imposible por construccion.
--
-- Verificado en dry-run con lista manual: 41 comics, todos number=1, en 41
-- colecciones distintas, con precios 13.29-29.99 EUR. 0 falsos positivos.
--
-- El fallback wk?.price ya se quito en el frontend
-- (collection-detail.component.ts Opcion A), asi que no se repetira.

UPDATE comics
SET price = NULL, updated_at = datetime('now')
WHERE id IN (
  SELECT c.id
  FROM comics c
  JOIN collections col ON col.id = c.collection_id
  WHERE c.price IS NOT NULL
    AND c.price > 10
    AND LOWER(col.format) LIKE 'grapa%'
);
