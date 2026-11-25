-- Videojuegos (fase 1): el juego y las copias que tengo.
--
-- Un juego es un título de IGDB; sus plataformas no se guardan aquí, salen de
-- las copias (y más adelante de las listas de trofeos de PSN). Una copia es lo
-- que tengo de verdad: una plataforma, un formato (físico o digital) y una
-- edición. Si lo tengo en físico y en digital, son dos copias del mismo juego.
-- Plan completo: https://claude.ai/artifact/BUvzxUVsAP1dzaG64TpvGc
--
-- completed_at lo mantienen TRIGGERS, como read_at en cómics y libros
-- (0016_read_at.sql), para que valga para cualquier camino de escritura:
--   - al pasar a 'completed', la fecha que traiga la escritura o, si no trae,
--     la de ese momento (UTC); el platino de la fase 2 pasará la suya;
--   - al dejar de estar 'completed', NULL;
--   - si sigue 'completed', no se toca (se puede corregir a mano la fecha).

CREATE TABLE IF NOT EXISTS games (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  igdb_id            INTEGER UNIQUE,

  title              TEXT NOT NULL,
  cover_url          TEXT,
  summary            TEXT,
  genres             TEXT,              -- "Rol, Aventura"
  developer          TEXT,
  publisher          TEXT,
  franchise          TEXT,              -- saga
  first_release_date TEXT,              -- YYYY-MM-DD
  igdb_url           TEXT,

  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','playing','completed','abandoned')),
  completed_at       TEXT,
  completed_source   TEXT CHECK(completed_source IN ('manual','platinum') OR completed_source IS NULL),
  rating             INTEGER CHECK(rating BETWEEN 1 AND 5 OR rating IS NULL),
  notes              TEXT,

  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_copies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,

  platform        TEXT NOT NULL CHECK(platform IN ('PS1','PS2','PS3','PS4','PS5','PSP')),
  format          TEXT NOT NULL CHECK(format IN ('physical','digital')),
  edition         TEXT,                 -- NULL = estándar
  ean             TEXT,
  psn_title_id    TEXT,                 -- CUSA00031_00, PPSA01547_00...
  psn_product_id  TEXT,
  price           REAL,
  store           TEXT,
  acquired_at     TEXT,                 -- YYYY-MM-DD
  is_free         INTEGER NOT NULL DEFAULT 0,   -- regalado (Play At Home...)
  source          TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','scanner','psn')),
  notes           TEXT,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_games_status       ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_completed_at ON games(completed_at);
CREATE INDEX IF NOT EXISTS idx_game_copies_game   ON game_copies(game_id);
CREATE INDEX IF NOT EXISTS idx_game_copies_ean    ON game_copies(ean);
CREATE INDEX IF NOT EXISTS idx_game_copies_title  ON game_copies(psn_title_id);

CREATE TRIGGER IF NOT EXISTS games_completed_at_upd AFTER UPDATE OF status ON games
FOR EACH ROW WHEN (NEW.status = 'completed') <> (OLD.status = 'completed')
BEGIN
  UPDATE games SET
    completed_at     = CASE WHEN NEW.status = 'completed' THEN COALESCE(NEW.completed_at, datetime('now')) ELSE NULL END,
    completed_source = CASE WHEN NEW.status = 'completed' THEN COALESCE(NEW.completed_source, 'manual') ELSE NULL END
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS games_completed_at_ins AFTER INSERT ON games
FOR EACH ROW WHEN NEW.status = 'completed' AND NEW.completed_at IS NULL
BEGIN
  UPDATE games SET completed_at = datetime('now'), completed_source = COALESCE(NEW.completed_source, 'manual')
  WHERE id = NEW.id;
END;
