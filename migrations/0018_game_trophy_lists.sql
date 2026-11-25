-- Videojuegos (fase 2): listas de trofeos de PSN.
--
-- Una fila por lista de trofeos (npCommunicationId). Un juego puede tener
-- varias (PS4 y PS5 por separado); si PSN la comparte entre consolas
-- ("PS4,PS5"), es una sola fila con las dos plataformas.
-- Se sincroniza a diario desde PSN a través del Worker Trofeos (RPC); ver
-- src/services/trophies.ts.
--
-- link_state decide quién manda en el enlace con el juego:
--   NULL      sin decidir: la sincronización lo enlaza sola si el título coincide;
--   'auto'    lo enlazó la sincronización;
--   'manual'  lo enlazó o desenlazó el usuario: la sincronización no lo toca;
--   'ignored' no es un juego de la colección (demos, prestados...): fuera de pendientes.
--
-- platinum_applied: el platino ya pasó el juego a "pasado" una vez. Si después
-- el usuario cambia el estado a mano, no se vuelve a imponer.

CREATE TABLE IF NOT EXISTS game_trophy_lists (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  np_communication_id TEXT NOT NULL UNIQUE,
  np_service_name     TEXT NOT NULL,          -- trophy (PS3/PS4) | trophy2 (PS5)
  game_id             INTEGER REFERENCES games(id) ON DELETE SET NULL,
  link_state          TEXT CHECK(link_state IN ('auto','manual','ignored') OR link_state IS NULL),

  title               TEXT NOT NULL,
  icon_url            TEXT,
  platforms           TEXT NOT NULL,          -- "PS5", "PS4,PS5", "PS3"
  progress            INTEGER NOT NULL DEFAULT 0,   -- 0-100, el de PSN

  earned_platinum     INTEGER NOT NULL DEFAULT 0,
  earned_gold         INTEGER NOT NULL DEFAULT 0,
  earned_silver       INTEGER NOT NULL DEFAULT 0,
  earned_bronze       INTEGER NOT NULL DEFAULT 0,
  defined_platinum    INTEGER NOT NULL DEFAULT 0,
  defined_gold        INTEGER NOT NULL DEFAULT 0,
  defined_silver      INTEGER NOT NULL DEFAULT 0,
  defined_bronze      INTEGER NOT NULL DEFAULT 0,

  platinum_at         TEXT,                   -- ISO, cuando se sabe
  platinum_applied    INTEGER NOT NULL DEFAULT 0,
  last_played_at      TEXT,                   -- lastUpdatedDateTime de PSN

  synced_at           TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trophy_lists_game ON game_trophy_lists(game_id);
CREATE INDEX IF NOT EXISTS idx_trophy_lists_pending ON game_trophy_lists(game_id, link_state);
