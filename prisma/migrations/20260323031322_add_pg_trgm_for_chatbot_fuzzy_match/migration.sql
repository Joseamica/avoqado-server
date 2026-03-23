CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_raw_material_name_trgm ON "RawMaterial" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_product_name_trgm ON "Product" USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_supplier_name_trgm ON "Supplier" USING GIN (name gin_trgm_ops);
