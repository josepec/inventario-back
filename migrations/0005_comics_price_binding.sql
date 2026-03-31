-- Add price and binding fields to comics
ALTER TABLE comics ADD COLUMN price REAL;
ALTER TABLE comics ADD COLUMN binding TEXT;
