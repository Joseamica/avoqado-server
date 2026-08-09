-- Recovery: inspect pg_index.indisvalid/indisready; if invalid, run a separate
-- DROP INDEX CONCURRENTLY for this exact name, then retry this migration.
CREATE INDEX CONCURRENTLY "Product_createdById_idx" ON "Product"("createdById") WHERE "createdById" IS NOT NULL;
