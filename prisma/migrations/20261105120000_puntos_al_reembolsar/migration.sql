-- D6 y D7: la reversa de puntos por reembolso (una por reembolso), cuánto de un EARN es el bono por visita y sobre qué importe se
-- calcularon sus puntos. Aditiva.
ALTER TABLE "LoyaltyTransaction" ADD COLUMN "refundPaymentId" TEXT,
ADD COLUMN "visitBonusPoints" INTEGER,
ADD COLUMN "baseAmount" DECIMAL(12,2);

CREATE UNIQUE INDEX "LoyaltyTransaction_refundPaymentId_key" ON "LoyaltyTransaction"("refundPaymentId");
