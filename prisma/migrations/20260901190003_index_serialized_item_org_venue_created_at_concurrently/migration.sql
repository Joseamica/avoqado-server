-- Control de Stock, items by registering venue (see 20260901190001 for why this
-- file holds exactly ONE statement and uses IF NOT EXISTS, and 20260901190002 for
-- why the name is cut to 63 chars the way Prisma cuts it, not the way Postgres does).
-- This is the exact name Prisma expects for
-- @@index([organizationId, registeredFromVenueId, createdAt(sort: Desc), id(sort: Desc)]).
--
-- Recovery: inspect pg_index.indisvalid/indisready; if invalid, run a separate
-- DROP INDEX CONCURRENTLY for this exact name, then retry this migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SerializedItem_organizationId_registeredFromVenueId_created_idx"
ON "SerializedItem"("organizationId", "registeredFromVenueId", "createdAt" DESC, "id" DESC);
