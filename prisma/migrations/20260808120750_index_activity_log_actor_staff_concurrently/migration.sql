-- Recovery: inspect pg_index.indisvalid/indisready and exact definition. Drop
-- only an invalid remnant concurrently, resolve rolled-back, then retry.
CREATE INDEX CONCURRENTLY "ActivityLog_actorStaffId_idx" ON "ActivityLog"("actorStaffId") WHERE "actorStaffId" IS NOT NULL;
