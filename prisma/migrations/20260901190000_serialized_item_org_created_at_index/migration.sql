-- Control de Stock: summary/detail/bulk-group queries are organization scoped
-- and ordered/filtered by createdAt. Without this index, every page still sorts
-- the organization's full serialized inventory even though the HTTP response is
-- bounded.
--
-- CONCURRENTLY avoids blocking SIM registrations and sales while production is
-- building the index. Prisma migrations in this repository deliberately leave
-- concurrent indexes outside an explicit transaction (same precedent as the
-- ActivityLog indexes from 2026-08-08).
CREATE INDEX CONCURRENTLY "SerializedItem_organizationId_createdAt_id_idx"
ON "SerializedItem"("organizationId", "createdAt" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY "SerializedItem_organizationId_assignedSupervisorId_createdAt_id_idx"
ON "SerializedItem"("organizationId", "assignedSupervisorId", "createdAt" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY "SerializedItem_organizationId_registeredFromVenueId_createdAt_id_idx"
ON "SerializedItem"("organizationId", "registeredFromVenueId", "createdAt" DESC, "id" DESC);
