-- A reward whose completing purchase was refunded is no longer earned.
ALTER TYPE "StampRewardStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- A partial refund and a later full refund can race. The pre-read in the service
-- is only an optimization; this index is the durable one-reversal guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS "StampEvent_venueId_orderId_reversal_unique"
ON "StampEvent" ("venueId", "orderId")
WHERE "type" = 'REVERSAL' AND "orderId" IS NOT NULL;
