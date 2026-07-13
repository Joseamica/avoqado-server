-- CreateEnum
CREATE TYPE "PrinterConnectionType" AS ENUM ('NETWORK', 'BLUETOOTH', 'USB_SPOOLER', 'TERMINAL_INTERNAL');

-- CreateEnum
CREATE TYPE "PrintJobType" AS ENUM ('KITCHEN_TICKET', 'RECEIPT', 'EXPO', 'TEST', 'CASH_CLOSE');

-- CreateEnum
CREATE TYPE "PrintJobReason" AS ENUM ('ORIGINAL', 'ADDITION', 'CANCEL', 'REPRINT');

-- CreateEnum
CREATE TYPE "PrintJobStatus" AS ENUM ('QUEUED', 'SENT', 'DONE', 'UNCERTAIN', 'OPERATOR_CONFIRMED', 'FAILED');

-- AlterTable
ALTER TABLE "MenuCategory" ADD COLUMN     "printStationId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "printStationId" TEXT,
ADD COLUMN     "printedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "printStationId" TEXT;

-- CreateTable
CREATE TABLE "Printer" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "connectionType" "PrinterConnectionType" NOT NULL DEFAULT 'NETWORK',
    "stableKey" TEXT,
    "address" TEXT,
    "paperWidthMm" INTEGER NOT NULL DEFAULT 80,
    "charset" TEXT NOT NULL DEFAULT 'CP858',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintGateway" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastHeartbeat" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintGateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintStation" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "printerId" TEXT,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintStation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintJob" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "stationId" TEXT,
    "printerId" TEXT,
    "gatewayTerminalId" TEXT,
    "originTerminalId" TEXT,
    "orderId" TEXT,
    "orderItemIds" TEXT[],
    "type" "PrintJobType" NOT NULL DEFAULT 'KITCHEN_TICKET',
    "reason" "PrintJobReason" NOT NULL DEFAULT 'ORIGINAL',
    "seq" INTEGER NOT NULL DEFAULT 1,
    "eventId" TEXT NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Printer_venueId_idx" ON "Printer"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "Printer_venueId_name_key" ON "Printer"("venueId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PrintGateway_venueId_key" ON "PrintGateway"("venueId");

-- CreateIndex
CREATE INDEX "PrintGateway_venueId_idx" ON "PrintGateway"("venueId");

-- CreateIndex
CREATE INDEX "PrintStation_venueId_idx" ON "PrintStation"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "PrintStation_venueId_name_key" ON "PrintStation"("venueId", "name");

-- CreateIndex
CREATE INDEX "PrintJob_venueId_status_idx" ON "PrintJob"("venueId", "status");

-- CreateIndex
CREATE INDEX "PrintJob_orderId_idx" ON "PrintJob"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PrintJob_eventId_reason_seq_key" ON "PrintJob"("eventId", "reason", "seq");

-- AddForeignKey
ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_printStationId_fkey" FOREIGN KEY ("printStationId") REFERENCES "PrintStation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_printStationId_fkey" FOREIGN KEY ("printStationId") REFERENCES "PrintStation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_printStationId_fkey" FOREIGN KEY ("printStationId") REFERENCES "PrintStation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Printer" ADD CONSTRAINT "Printer_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintGateway" ADD CONSTRAINT "PrintGateway_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintStation" ADD CONSTRAINT "PrintStation_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintStation" ADD CONSTRAINT "PrintStation_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "PrintStation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- I9 (spec v3): exactly ONE default PrintStation per venue.
-- Prisma's @@unique can't express a partial (WHERE) index, so it's added here by hand.
CREATE UNIQUE INDEX "PrintStation_venueId_default_key" ON "PrintStation"("venueId") WHERE "isDefault" = true;
