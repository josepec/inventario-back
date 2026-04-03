-- Añadir columna authors (JSON) a comics para almacenar autores con roles
ALTER TABLE comics ADD COLUMN authors TEXT;
