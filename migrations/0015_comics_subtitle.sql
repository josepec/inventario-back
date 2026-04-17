-- Subtitulo especifico del ejemplar dentro de una coleccion multi-issue.
-- Ej: para colecciones tipo "DC One-Shot #15", el subtitulo real es
-- "Batman: Patrones oscuros 2". Whakoom expone este valor solo desde la
-- pagina de la edicion (no en la pagina del comic individual), por eso
-- el campo se rellena al importar cruzando el edition.issues[].subtitle.
ALTER TABLE comics ADD COLUMN subtitle TEXT;
CREATE INDEX IF NOT EXISTS idx_comics_subtitle ON comics(subtitle);
