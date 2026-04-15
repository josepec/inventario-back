-- Wanted comics (wishlist): comics que el usuario quiere antes de que salgan.
-- Aislado de la tabla `comics` real para no contaminar stats, filtros ni totales.
-- Al importar un comic (POST /comics), el backend limpia el mismo whakoom_id
-- de esta tabla.
CREATE TABLE IF NOT EXISTS wanted_comics (
  whakoom_comic_id      TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  series                TEXT,
  number                TEXT,
  cover_url             TEXT,
  publisher             TEXT,
  collection_whakoom_id TEXT,
  release_month         TEXT,
  added_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wanted_release_month ON wanted_comics(release_month);
CREATE INDEX IF NOT EXISTS idx_wanted_collection    ON wanted_comics(collection_whakoom_id);

-- whakoom_id en comics: necesario para cruzar `owned` contra novedades scrapeadas
-- y para limpiar la wishlist cuando el usuario importa un comic ya marcado.
ALTER TABLE comics ADD COLUMN whakoom_id TEXT;
CREATE INDEX IF NOT EXISTS idx_comics_whakoom_id ON comics(whakoom_id);
