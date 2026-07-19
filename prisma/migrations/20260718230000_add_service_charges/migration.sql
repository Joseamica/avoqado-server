-- Cobros por servicio: ingreso GRAVABLE del negocio que SUMA al total del
-- cheque (a diferencia de la propina, que pasa al mesero, y del descuento,
-- que resta). Casos: propina automática por grupo, descorche, cargo por entrega.

CREATE TYPE "ServiceChargeType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

ALTER TABLE "Order" ADD COLUMN "serviceChargeAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

CREATE TABLE "ServiceCharge" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ServiceChargeType" NOT NULL,
    "value" DECIMAL(10,4) NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "autoApplyMinCovers" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ServiceCharge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderServiceCharge" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "serviceChargeId" TEXT,
    "name" TEXT NOT NULL,
    "type" "ServiceChargeType" NOT NULL,
    "value" DECIMAL(10,4) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
    "appliedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderServiceCharge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServiceCharge_venueId_idx" ON "ServiceCharge"("venueId");
CREATE INDEX "OrderServiceCharge_orderId_idx" ON "OrderServiceCharge"("orderId");
CREATE INDEX "OrderServiceCharge_serviceChargeId_idx" ON "OrderServiceCharge"("serviceChargeId");

ALTER TABLE "ServiceCharge" ADD CONSTRAINT "ServiceCharge_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderServiceCharge" ADD CONSTRAINT "OrderServiceCharge_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderServiceCharge" ADD CONSTRAINT "OrderServiceCharge_serviceChargeId_fkey"
  FOREIGN KEY ("serviceChargeId") REFERENCES "ServiceCharge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderServiceCharge" ADD CONSTRAINT "OrderServiceCharge_appliedById_fkey"
  FOREIGN KEY ("appliedById") REFERENCES "StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
