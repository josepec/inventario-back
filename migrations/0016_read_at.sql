-- Fecha de lectura de comics y libros.
--
-- Hasta ahora los "leidos al mes" del dashboard se contaban por updated_at,
-- que cambia tambien al editar la ficha, al reimportarla de Whakoom o al
-- renombrar una saga: corregir el precio de un comic leido en mayo lo pasaba a
-- leido en octubre.
--
-- read_at lo mantienen TRIGGERS, no el codigo, para que valga para cualquier
-- camino de escritura (PUT, PATCH /batch, POST, importaciones, SQL a mano):
--   - al pasar a 'read', la hora de ese momento (UTC, mismo formato que now());
--   - al dejar de estar 'read', NULL;
--   - si sigue 'read' (se edita la ficha), no se toca;
--   - al crear uno ya leido, la hora de creacion.
--
-- Relleno: los ya leidos toman su updated_at, que es justo lo que contaba el
-- dashboard. Asi las cifras de hoy no cambian; a partir de hoy, editar ya no
-- mueve nada de mes.
--
-- Aplicada el 23/10/2026 con --command (en esta maquina --file falla, ver
-- memoria d1_ops_network). Copia previa en backups/read-at-pre-20261023.json.

ALTER TABLE comics ADD COLUMN read_at TEXT;
ALTER TABLE books ADD COLUMN read_at TEXT;

UPDATE comics SET read_at = updated_at WHERE read_status = 'read' AND read_at IS NULL;
UPDATE books SET read_at = updated_at WHERE read_status = 'read' AND read_at IS NULL;

CREATE TRIGGER IF NOT EXISTS comics_read_at_upd AFTER UPDATE OF read_status ON comics
FOR EACH ROW WHEN (NEW.read_status = 'read') <> (OLD.read_status = 'read')
BEGIN
  UPDATE comics SET read_at = CASE WHEN NEW.read_status = 'read' THEN datetime('now') ELSE NULL END WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS comics_read_at_ins AFTER INSERT ON comics
FOR EACH ROW WHEN NEW.read_status = 'read' AND NEW.read_at IS NULL
BEGIN
  UPDATE comics SET read_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS books_read_at_upd AFTER UPDATE OF read_status ON books
FOR EACH ROW WHEN (NEW.read_status = 'read') <> (OLD.read_status = 'read')
BEGIN
  UPDATE books SET read_at = CASE WHEN NEW.read_status = 'read' THEN datetime('now') ELSE NULL END WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS books_read_at_ins AFTER INSERT ON books
FOR EACH ROW WHEN NEW.read_status = 'read' AND NEW.read_at IS NULL
BEGIN
  UPDATE books SET read_at = datetime('now') WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_comics_read_at ON comics(read_at);
CREATE INDEX IF NOT EXISTS idx_books_read_at ON books(read_at);
