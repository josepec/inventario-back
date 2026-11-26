-- Fechas estimadas a partir de los trofeos de PSN.
--
-- 1. first_earned_at: el primer trofeo conseguido de cada lista. Lo rellena la
--    sincronización de trofeos (una llamada a PSN por lista, una sola vez).
-- 2. acquired_estimated: la fecha de compra de una copia física sin fecha se
--    estima con el primer trofeo de su plataforma; la ficha la marca como
--    aproximada (≈) hasta que se ponga a mano.
-- 3. Al pasar un juego a 'completed' sin fecha, la del último trofeo de sus
--    listas (si tiene); si no, la de ese momento. Se rehacen los triggers de 0017.

ALTER TABLE game_trophy_lists ADD COLUMN first_earned_at TEXT;
ALTER TABLE game_copies ADD COLUMN acquired_estimated INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS games_completed_at_upd;
CREATE TRIGGER games_completed_at_upd AFTER UPDATE OF status ON games
FOR EACH ROW WHEN (NEW.status = 'completed') <> (OLD.status = 'completed')
BEGIN
  UPDATE games SET
    completed_at = CASE WHEN NEW.status = 'completed' THEN COALESCE(
      NEW.completed_at,
      (SELECT replace(substr(MAX(last_played_at), 1, 19), 'T', ' ') FROM game_trophy_lists WHERE game_id = NEW.id),
      datetime('now')) ELSE NULL END,
    completed_source = CASE WHEN NEW.status = 'completed' THEN COALESCE(NEW.completed_source, 'manual') ELSE NULL END
  WHERE id = NEW.id;
END;

DROP TRIGGER IF EXISTS games_completed_at_ins;
CREATE TRIGGER games_completed_at_ins AFTER INSERT ON games
FOR EACH ROW WHEN NEW.status = 'completed' AND NEW.completed_at IS NULL
BEGIN
  UPDATE games SET
    completed_at = COALESCE(
      (SELECT replace(substr(MAX(last_played_at), 1, 19), 'T', ' ') FROM game_trophy_lists WHERE game_id = NEW.id),
      datetime('now')),
    completed_source = COALESCE(NEW.completed_source, 'manual')
  WHERE id = NEW.id;
END;
