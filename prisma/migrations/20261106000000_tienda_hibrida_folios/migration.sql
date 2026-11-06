-- Tienda híbrida, etapa 1: columnas aditivas (filas viejas: requiresAcceptance true, channel nulo).
-- AlterTable
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN     "lastToPayPollAt" TIMESTAMP(3),
ADD COLUMN     "requiresAcceptance" BOOLEAN NOT NULL DEFAULT true;
-- AlterTable
ALTER TABLE "OnlineOrder" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "requiresAcceptance" BOOLEAN NOT NULL DEFAULT true;
-- CreateIndex
CREATE INDEX "OnlineOrder_venueId_requiresAcceptance_status_idx" ON "OnlineOrder"("venueId", "requiresAcceptance", "status");
