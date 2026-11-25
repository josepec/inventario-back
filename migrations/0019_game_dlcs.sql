-- Videojuegos (fase 3): DLC comprados en la PlayStation Store.
--
-- Un DLC es un complemento de su juego base, nunca un juego aparte. PSN no
-- dice de qué juego es, pero su id lleva el titleId del juego
-- (EP0700-CUSA14835_00-DBZKSP → CUSA14835_00). Se enlaza:
--   1. con el juego que tiene una copia digital con ese titleId;
--   2. si no (juego físico, o la versión de otra consola), con el juego de la
--      colección cuyo título es el principio del nombre de alguno de los DLC
--      del mismo titleId ("Batman: Arkham Knight - Season Pass").
-- Los que no se pueden enlazar se guardan con game_id NULL y se reintentan al
-- dar de alta juegos.

CREATE TABLE IF NOT EXISTS game_dlcs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id         INTEGER REFERENCES games(id) ON DELETE SET NULL,
  entitlement_id  TEXT NOT NULL UNIQUE,   -- EP0700-CUSA14835_00-DBZKSP
  psn_title_id    TEXT NOT NULL,          -- CUSA14835_00
  name            TEXT NOT NULL,
  platform        TEXT,                   -- PS3 | PS4 | PS5
  acquired_at     TEXT,                   -- YYYY-MM-DD
  icon_url        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_game_dlcs_game  ON game_dlcs(game_id);
CREATE INDEX IF NOT EXISTS idx_game_dlcs_title ON game_dlcs(psn_title_id);
CREATE INDEX IF NOT EXISTS idx_game_copies_product ON game_copies(psn_product_id);
