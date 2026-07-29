-- Vales por área (AREA_TICKETS, 2026-07-28) — cuenta compartida entre áreas emisoras.
-- Spec: avoqado-android/docs/superpowers/specs/2026-07-28-vales-por-area-y-bascula-design.md §5
--
-- TODO ES ADITIVO Y NULLABLE. Ninguna columna se quita ni se renombra: una orden
-- normal (mostrador, mesa, delivery) deja los campos nuevos en NULL y NADA cambia
-- para ella. Las apps viejas siguen funcionando idénticas.
--
-- Los dos índices únicos nuevos NO pueden colisionar al aplicarse porque ambas
-- columnas nacen NULL en todas las filas existentes y PostgreSQL trata los NULL como
-- distintos entre sí dentro de un índice único.

-- CreateEnum
CREATE TYPE "FulfillmentMode" AS ENUM ('IMMEDIATE', 'HOLD_UNTIL_PAID', 'PREPARE_ON_PAID');

-- AlterEnum
-- Vale de área: el papelito con el código de barras que el área imprime al abrir o
-- agregar a la cuenta. Sólo AGREGA un valor; los existentes no se tocan.
ALTER TYPE "PrintJobType" ADD VALUE 'AREA_TICKET';

-- CreateTable
CREATE TABLE "FulfillmentArea" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fulfillmentMode" "FulfillmentMode" NOT NULL DEFAULT 'IMMEDIATE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "printStationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfillmentArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderFulfillment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fulfillmentAreaId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredByStaffId" TEXT,
    "terminalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderFulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderFulfillmentLine" (
    "id" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,

    CONSTRAINT "OrderFulfillmentLine_pkey" PRIMARY KEY ("id")
);

-- AlterTable — Order: código del vale + claim de la caja (§5.1, §5.4).
ALTER TABLE "Order" ADD COLUMN     "areaTicketCode" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedByTerminalId" TEXT;

-- AlterTable — OrderItem: AUTORIDAD de a qué área pertenece el renglón (§5.3).
-- NULL a propósito = "línea de caja, se entrega al momento".
ALTER TABLE "OrderItem" ADD COLUMN     "fulfillmentAreaId" TEXT;

-- AlterTable — Terminal: binding terminal→área + partición del dispositivo (§5.2).
ALTER TABLE "Terminal" ADD COLUMN     "areaTicketLastCounter" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fulfillmentAreaId" TEXT,
ADD COLUMN     "partition" INTEGER;

-- CreateIndex
CREATE INDEX "FulfillmentArea_venueId_active_idx" ON "FulfillmentArea"("venueId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentArea_venueId_name_key" ON "FulfillmentArea"("venueId", "name");

-- CreateIndex
CREATE INDEX "OrderFulfillment_fulfillmentAreaId_deliveredAt_idx" ON "OrderFulfillment"("fulfillmentAreaId", "deliveredAt");

-- CreateIndex — idempotencia de la entrega: una fila por (orden, área). El segundo
-- POST /fulfill choca aquí y devuelve el registro existente en vez de duplicar.
CREATE UNIQUE INDEX "OrderFulfillment_orderId_fulfillmentAreaId_key" ON "OrderFulfillment"("orderId", "fulfillmentAreaId");

-- CreateIndex
CREATE INDEX "OrderFulfillmentLine_orderItemId_idx" ON "OrderFulfillmentLine"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderFulfillmentLine_fulfillmentId_orderItemId_key" ON "OrderFulfillmentLine"("fulfillmentId", "orderItemId");

-- CreateIndex — unicidad del código PARA SIEMPRE, sin businessDay: el contador es
-- monótono y nunca se reinicia, así que un vale de ayer jamás resuelve la cuenta de
-- otro cliente hoy.
CREATE UNIQUE INDEX "Order_venueId_areaTicketCode_key" ON "Order"("venueId", "areaTicketCode");

-- CreateIndex
CREATE INDEX "OrderItem_fulfillmentAreaId_idx" ON "OrderItem"("fulfillmentAreaId");

-- CreateIndex
CREATE INDEX "Terminal_fulfillmentAreaId_idx" ON "Terminal"("fulfillmentAreaId");

-- CreateIndex — dos dispositivos del mismo venue JAMÁS comparten partición.
CREATE UNIQUE INDEX "Terminal_venueId_partition_key" ON "Terminal"("venueId", "partition");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_claimedByTerminalId_fkey" FOREIGN KEY ("claimedByTerminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_fulfillmentAreaId_fkey" FOREIGN KEY ("fulfillmentAreaId") REFERENCES "FulfillmentArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_fulfillmentAreaId_fkey" FOREIGN KEY ("fulfillmentAreaId") REFERENCES "FulfillmentArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentArea" ADD CONSTRAINT "FulfillmentArea_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentArea" ADD CONSTRAINT "FulfillmentArea_printStationId_fkey" FOREIGN KEY ("printStationId") REFERENCES "PrintStation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFulfillment" ADD CONSTRAINT "OrderFulfillment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey — Restrict: borrar un área con entregas registradas borraría la
-- prueba de quién entregó qué. Se desactiva (`active = false`), no se borra.
ALTER TABLE "OrderFulfillment" ADD CONSTRAINT "OrderFulfillment_fulfillmentAreaId_fkey" FOREIGN KEY ("fulfillmentAreaId") REFERENCES "FulfillmentArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFulfillment" ADD CONSTRAINT "OrderFulfillment_deliveredByStaffId_fkey" FOREIGN KEY ("deliveredByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFulfillment" ADD CONSTRAINT "OrderFulfillment_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFulfillmentLine" ADD CONSTRAINT "OrderFulfillmentLine_fulfillmentId_fkey" FOREIGN KEY ("fulfillmentId") REFERENCES "OrderFulfillment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderFulfillmentLine" ADD CONSTRAINT "OrderFulfillmentLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
