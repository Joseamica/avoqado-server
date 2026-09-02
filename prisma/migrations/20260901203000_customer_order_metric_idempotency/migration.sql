-- A paid order may be replayed by the POS outbox or retried after a lost HTTP
-- response. Points and stamps already have structural idempotency; customer
-- visit/spend metrics need the same guarantee.
CREATE TABLE "public"."CustomerOrderMetric" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerOrderMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerOrderMetric_customerId_orderId_key"
    ON "public"."CustomerOrderMetric"("customerId", "orderId");
CREATE INDEX "CustomerOrderMetric_venueId_createdAt_idx"
    ON "public"."CustomerOrderMetric"("venueId", "createdAt");
CREATE INDEX "CustomerOrderMetric_orderId_idx"
    ON "public"."CustomerOrderMetric"("orderId");

-- The table is new and empty, so these constraints do not scan either hot
-- parent table. NOT VALID keeps the parent lock short during rollout; VALIDATE
-- checks future deployments without blocking normal reads/writes.
ALTER TABLE "public"."CustomerOrderMetric"
    ADD CONSTRAINT "CustomerOrderMetric_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "public"."CustomerOrderMetric"
    ADD CONSTRAINT "CustomerOrderMetric_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id")
    ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "public"."CustomerOrderMetric" VALIDATE CONSTRAINT "CustomerOrderMetric_customerId_fkey";
ALTER TABLE "public"."CustomerOrderMetric" VALIDATE CONSTRAINT "CustomerOrderMetric_orderId_fkey";

-- Durable retry marker for the post-payment loyalty hook. Existing orders stay
-- NULL and are therefore not backfilled/re-awarded; only a new settlement writes
-- loyaltyEligibleAt in the same transaction that marks the order PAID.
ALTER TABLE "public"."Order"
    ADD COLUMN "loyaltyEligibleAt" TIMESTAMP(3),
    ADD COLUMN "loyaltyProcessingAt" TIMESTAMP(3),
    ADD COLUMN "loyaltyProcessedAt" TIMESTAMP(3),
    ADD COLUMN "loyaltyAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "loyaltyLastError" TEXT,
    ADD COLUMN "loyaltyStaffId" TEXT;

CREATE INDEX "Order_loyalty_pending_idx"
    ON "public"."Order"("loyaltyEligibleAt", "id")
    WHERE "loyaltyEligibleAt" IS NOT NULL AND "loyaltyProcessedAt" IS NULL;
