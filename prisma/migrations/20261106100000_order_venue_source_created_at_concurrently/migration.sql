-- Order receives writes during every checkout. A normal index build here would
-- hold a conflicting lock and pause payments while Render runs migrate deploy.
-- Keep this migration to one statement because PostgreSQL rejects CONCURRENTLY
-- inside a transaction block. If interrupted, drop only an invalid copy with
-- DROP INDEX CONCURRENTLY "Order_venueId_source_createdAt_idx" before retrying the migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_venueId_source_createdAt_idx"
  ON "public"."Order"("venueId", "source", "createdAt");
