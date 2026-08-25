-- Fase 4 del kiosco — el carril de dinero.
--
-- Ata la compra de un paquete al COBRO real que la pagó. La unicidad es lo que
-- hace idempotente el fulfillment: es la misma idea que `stripeCheckoutSessionId`
-- para el carril en línea. Sin ella, un reintento del PAX tras un timeout
-- acredita el paquete dos veces por un solo cobro.
ALTER TABLE "CreditPackPurchase" ADD COLUMN "paymentId" TEXT;

CREATE UNIQUE INDEX "CreditPackPurchase_paymentId_key" ON "CreditPackPurchase"("paymentId");

ALTER TABLE "CreditPackPurchase"
  ADD CONSTRAINT "CreditPackPurchase_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
