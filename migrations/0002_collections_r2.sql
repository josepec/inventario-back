-- Collections (Whakoom editions / series)
CREATE TABLE IF NOT EXISTS collections (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  whakoom_id      TEXT UNIQUE,           -- ID en Whakoom (edición o serie)
  whakoom_type    TEXT,                  -- 'edition' | 'comic'
  title           TEXT NOT NULL,
  publisher       TEXT,
  cover_url       TEXT,
  total_issues    INTEGER,
  description     TEXT,
  url             TEXT,                  -- URL en Whakoom
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_collections_whakoom ON collections(whakoom_id);

-- Añadir collection_id a comics (FK a collections)
ALTER TABLE comics ADD COLUMN collection_id INTEGER REFERENCES collections(id);
CREATE INDEX IF NOT EXISTS idx_comics_collection ON comics(collection_id);
