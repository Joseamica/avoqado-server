-- Recent sales delta reads Payment by its last update; build without blocking captures.
-- If interrupted, DROP INDEX CONCURRENTLY the invalid index and retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Payment_venueId_updatedAt_idx" ON "Payment"("venueId", "updatedAt");
