-- CreateTable: reglas condicionales de visibilidad/auto-selección de merchants en TPV
-- Feature PREMIUM MERCHANT_ROUTING_RULES. Additive-only (tabla nueva + columna nullable).
CREATE TABLE "MerchantRoutingRule" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantRoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantRoutingRule_venueId_merchantAccountId_key" ON "MerchantRoutingRule"("venueId", "merchantAccountId");
CREATE INDEX "MerchantRoutingRule_venueId_idx" ON "MerchantRoutingRule"("venueId");
CREATE INDEX "MerchantRoutingRule_merchantAccountId_idx" ON "MerchantRoutingRule"("merchantAccountId");

-- AddForeignKey
ALTER TABLE "MerchantRoutingRule" ADD CONSTRAINT "MerchantRoutingRule_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MerchantRoutingRule" ADD CONSTRAINT "MerchantRoutingRule_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "MerchantAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: snapshot de auditoría de la evaluación de reglas en cada pago
ALTER TABLE "Payment" ADD COLUMN "routingEvaluation" JSONB;
