-- Videojuegos, fase 5: "Lo quiero".
--
-- Un juego de IGDB que se quiere y aún no se tiene. La fecha de salida es la de
-- PlayStation en Europa (si no, la mundial) y la refresca el cron a diario (los
-- retrasos son habituales). release_precision es el date_format de IGDB:
-- 0 día, 1 mes, 2 año, 3-6 trimestre (T1-T4), 7 sin fecha.
-- Al dar el juego de alta en la colección, sale de aquí (POST /games).

CREATE TABLE IF NOT EXISTS game_wishlist (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  igdb_id           INTEGER NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  cover_url         TEXT,
  platforms         TEXT,                     -- "PS4,PS5"
  franchise         TEXT,
  release_date      TEXT,                     -- YYYY-MM-DD (con precisión menor, el último día del periodo)
  release_precision INTEGER,
  notes             TEXT,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_game_wishlist_release ON game_wishlist(release_date);
