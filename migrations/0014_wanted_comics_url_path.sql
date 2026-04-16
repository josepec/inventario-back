-- Almacena la ruta URL completa del comic en Whakoom (ej: /comics/12345/slug/4)
-- para poder hacer fetch del detalle sin depender de que /comics/<item_id> resuelva.
-- El <li id="comic{ID}"> de newtitles es un ID de item, no de serie; la URL real
-- siempre es /comics/<SERIES_ID>/<SLUG>/<NUMBER>.
ALTER TABLE wanted_comics ADD COLUMN comics_url_path TEXT;
