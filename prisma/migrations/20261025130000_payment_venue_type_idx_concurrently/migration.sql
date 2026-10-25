-- Recent sales copies and refund reads find a venue's REFUND rows without scanning all payments.
-- If interrupted, DROP INDEX CONCURRENTLY the invalid index and retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Payment_venueId_type_idx" ON "Payment"("venueId", "type");
