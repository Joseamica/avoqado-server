-- Control de Stock, custody by supervisor (see 20260901190001 for why this file
-- holds exactly ONE statement and uses IF NOT EXISTS).
--
-- Name: Postgres caps identifiers at 63 chars. The natural name
-- "SerializedItem_organizationId_assignedSupervisorId_createdAt_id_idx" is 67, and
-- Postgres would silently cut its TAIL, while Prisma derives the default name by
-- cutting the MIDDLE and keeping "_idx" — the two never match and `migrate diff`
-- reports a RenameIndex forever. This is the exact name Prisma expects for
-- @@index([organizationId, assignedSupervisorId, createdAt(sort: Desc), id(sort: Desc)]).
--
-- Recovery: inspect pg_index.indisvalid/indisready; if invalid, run a separate
-- DROP INDEX CONCURRENTLY for this exact name, then retry this migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SerializedItem_organizationId_assignedSupervisorId_createdA_idx"
ON "SerializedItem"("organizationId", "assignedSupervisorId", "createdAt" DESC, "id" DESC);
