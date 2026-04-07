-- Add price and binding fields to books
ALTER TABLE books ADD COLUMN price REAL;
ALTER TABLE books ADD COLUMN binding TEXT;
