-- Backfill subtitle for comics cross-referenced via collections.issues JSON
-- Matches on collection_id + number; only fills where subtitle is currently NULL
-- Rollback: migrations/rollback_subtitle_backfill_20260418.sql
UPDATE comics
SET subtitle = (
  SELECT json_extract(issue.value, '$.subtitle')
  FROM collections col, json_each(col.issues) AS issue
  WHERE col.id = comics.collection_id
    AND CAST(json_extract(issue.value, '$.number') AS INTEGER) = comics.number
    AND json_extract(issue.value, '$.subtitle') IS NOT NULL
    AND json_extract(issue.value, '$.subtitle') != ''
)
WHERE comics.subtitle IS NULL
  AND EXISTS (
    SELECT 1
    FROM collections col, json_each(col.issues) AS issue
    WHERE col.id = comics.collection_id
      AND CAST(json_extract(issue.value, '$.number') AS INTEGER) = comics.number
      AND json_extract(issue.value, '$.subtitle') IS NOT NULL
      AND json_extract(issue.value, '$.subtitle') != ''
  );
