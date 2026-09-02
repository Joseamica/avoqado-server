-- One concurrent statement per migration keeps PostgreSQL outside an implicit
-- multi-statement transaction while avoiding write locks during index creation.
CREATE INDEX CONCURRENTLY "SerializedItem_organizationId_assignedSupervisorId_createdAt_id_idx"
ON "SerializedItem"("organizationId", "assignedSupervisorId", "createdAt" DESC, "id" DESC);
