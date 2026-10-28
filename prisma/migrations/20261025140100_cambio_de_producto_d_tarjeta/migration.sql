-- Exchange does not exist in production yet and starts empty in this deployment, so ordinary indexes are safe.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Exchange" ADD COLUMN "chargePaymentId" TEXT,
ADD COLUMN "resultRevision" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "Exchange_chargePaymentId_key" ON "Exchange"("chargePaymentId");
CREATE INDEX "Exchange_status_createdAt_id_idx" ON "Exchange"("status", "createdAt", "id");

COMMIT;
