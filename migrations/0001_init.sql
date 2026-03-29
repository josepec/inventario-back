-- Users
CREATE TABLE IF NOT EXISTS users (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT NOT NULL UNIQUE,
  password  TEXT NOT NULL,   -- bcrypt hash
  email     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Comics
CREATE TABLE IF NOT EXISTS comics (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Identificación
  title              TEXT NOT NULL,
  series             TEXT,
  number             INTEGER,
  volume             INTEGER,
  isbn               TEXT,
  ean                TEXT,

  -- Autores
  writer             TEXT,
  artist             TEXT,
  colorist           TEXT,
  cover_artist       TEXT,

  -- Editorial
  publisher          TEXT,
  collection         TEXT,
  publish_date       TEXT,
  original_publisher TEXT,
  original_title     TEXT,

  -- Descripción
  synopsis           TEXT,
  genre              TEXT,
  format             TEXT CHECK(format IN ('grapa','tomo','integral','omnibus','manga','novela_grafica','otro') OR format IS NULL),
  pages              INTEGER,
  language           TEXT,

  -- Portada
  cover_url          TEXT,

  -- Estado personal
  read_status        TEXT NOT NULL DEFAULT 'unread' CHECK(read_status IN ('unread','reading','read')),
  owned              INTEGER NOT NULL DEFAULT 0,
  rating             INTEGER CHECK(rating BETWEEN 1 AND 5 OR rating IS NULL),
  notes              TEXT,

  -- Metadata
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comics_series   ON comics(series);
CREATE INDEX IF NOT EXISTS idx_comics_isbn     ON comics(isbn);
CREATE INDEX IF NOT EXISTS idx_comics_ean      ON comics(ean);
CREATE INDEX IF NOT EXISTS idx_comics_status   ON comics(read_status);

-- Books
CREATE TABLE IF NOT EXISTS books (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Identificación
  title             TEXT NOT NULL,
  isbn              TEXT,
  isbn13            TEXT,
  ean               TEXT,

  -- Autores
  author            TEXT,
  translator        TEXT,
  illustrator       TEXT,

  -- Editorial
  publisher         TEXT,
  publish_date      TEXT,
  edition           TEXT,
  original_title    TEXT,
  original_language TEXT,

  -- Descripción
  synopsis          TEXT,
  genre             TEXT,
  subgenre          TEXT,
  pages             INTEGER,
  language          TEXT,
  saga              TEXT,
  saga_number       INTEGER,

  -- Portada
  cover_url         TEXT,

  -- Estado personal
  read_status       TEXT NOT NULL DEFAULT 'unread' CHECK(read_status IN ('unread','reading','read')),
  owned             INTEGER NOT NULL DEFAULT 0,
  rating            INTEGER CHECK(rating BETWEEN 1 AND 5 OR rating IS NULL),
  notes             TEXT,

  -- Metadata
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_books_isbn    ON books(isbn);
CREATE INDEX IF NOT EXISTS idx_books_isbn13  ON books(isbn13);
CREATE INDEX IF NOT EXISTS idx_books_ean     ON books(ean);
CREATE INDEX IF NOT EXISTS idx_books_status  ON books(read_status);

-- Seed: usuario por defecto (password: admin123 — cambiar en producción)
-- Hash generado con bcrypt rounds=10
INSERT OR IGNORE INTO users (username, password, email)
VALUES ('admin', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', NULL);
