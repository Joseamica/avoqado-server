-- Recovery: inspect pg_index.indisvalid/indisready; if invalid, run a separate
-- DROP INDEX CONCURRENTLY for this exact name, then retry this migration.
CREATE INDEX CONCURRENTLY "ActivityLog_servicePrincipalId_idx" ON "ActivityLog"("servicePrincipalId") WHERE "servicePrincipalId" IS NOT NULL;
