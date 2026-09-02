-- One concurrent statement per migration keeps PostgreSQL outside an implicit
-- multi-statement transaction while avoiding write locks during index creation.
CREATE INDEX CONCURRENTLY "SerializedItem_organizationId_registeredFromVenueId_createdAt_id_idx"
ON "SerializedItem"("organizationId", "registeredFromVenueId", "createdAt" DESC, "id" DESC);
