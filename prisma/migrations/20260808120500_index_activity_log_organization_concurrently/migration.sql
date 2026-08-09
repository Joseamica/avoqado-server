-- Recovery: inspect pg_index.indisvalid/indisready; if invalid, run a separate
-- DROP INDEX CONCURRENTLY for this exact name, then retry this migration.
CREATE INDEX CONCURRENTLY "ActivityLog_organizationId_idx" ON "ActivityLog"("organizationId") WHERE "organizationId" IS NOT NULL;
