-- Contrato durable POS → TPV: permite reentregar sin reconstruir datos desde memoria
-- y atribuir el pago al vendedor elegido en el POS, incluso con clientes viejos.
ALTER TABLE "TerminalPaymentRequest"
  ADD COLUMN "processedByStaffId" TEXT,
  ADD COLUMN "rating" INTEGER,
  ADD COLUMN "skipReview" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastDeliveredAt" TIMESTAMP(3),
  ADD COLUMN "acknowledgedAt" TIMESTAMP(3);

ALTER TABLE "TerminalPaymentRequest"
  ADD CONSTRAINT "TerminalPaymentRequest_rating_check"
  CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);
