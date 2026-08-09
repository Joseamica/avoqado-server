-- Recovery: inspect pg_index.indisvalid/indisready; if invalid, run a separate
-- DROP INDEX CONCURRENTLY for this exact name, then retry this migration.
CREATE INDEX CONCURRENTLY "ActivityLog_actorType_idx" ON "ActivityLog"("actorType") WHERE "actorType" IS NOT NULL;
