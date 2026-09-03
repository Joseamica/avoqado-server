-- Control de Stock: summary/detail/bulk-group queries are organization scoped
-- and ordered/filtered by createdAt. Without this index, every page still sorts
-- the organization's full serialized inventory even though the HTTP response is
-- bounded.
--
-- ONE statement per file, on purpose. Prisma sends a migration file to Postgres
-- as a single multi-statement batch, and Postgres runs such a batch inside an
-- implicit transaction block, where CREATE INDEX CONCURRENTLY is rejected
-- (SQLSTATE 25001). A file holding exactly one statement is not wrapped, so
-- CONCURRENTLY works — same precedent as the ActivityLog indexes of 2026-08-08.
-- The three SerializedItem indexes therefore live in 20260901190001..3.
--
-- IF NOT EXISTS: environments that already built this index by hand (the shared
-- local database on 2026-09-01) skip it instead of failing.
--
-- Recovery: inspect pg_index.indisvalid/indisready; if invalid, run a separate
-- DROP INDEX CONCURRENTLY for this exact name, then retry this migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SerializedItem_organizationId_createdAt_id_idx"
ON "SerializedItem"("organizationId", "createdAt" DESC, "id" DESC);
