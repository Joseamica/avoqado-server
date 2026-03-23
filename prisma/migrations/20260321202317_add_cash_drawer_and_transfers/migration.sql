-- CreateEnum
CREATE TYPE "public"."CashDrawerStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "public"."CashDrawerEventType" AS ENUM ('OPEN', 'PAY_IN', 'PAY_OUT', 'CASH_SALE', 'CLOSE');

-- CreateEnum
CREATE TYPE "public"."TransferStatus" AS ENUM ('DRAFT', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."CashDrawerSession" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "deviceName" TEXT,
    "openedByStaffId" TEXT NOT NULL,
    "openedByName" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startingAmount" DECIMAL(12,2) NOT NULL,
    "closedByStaffId" TEXT,
    "closedByName" TEXT,
    "closedAt" TIMESTAMP(3),
    "actualAmount" DECIMAL(12,2),
    "overShort" DECIMAL(12,2),
    "closingNote" TEXT,
    "status" "public"."CashDrawerStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashDrawerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CashDrawerEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "type" "public"."CashDrawerEventType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "staffId" TEXT NOT NULL,
    "staffName" TEXT NOT NULL,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashDrawerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InventoryTransfer" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "fromLocationName" TEXT NOT NULL,
    "toLocationName" TEXT NOT NULL,
    "status" "public"."TransferStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "itemsJson" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashDrawerSession_venueId_idx" ON "public"."CashDrawerSession"("venueId");

-- CreateIndex
CREATE INDEX "CashDrawerSession_status_idx" ON "public"."CashDrawerSession"("status");

-- CreateIndex
CREATE INDEX "CashDrawerEvent_sessionId_idx" ON "public"."CashDrawerEvent"("sessionId");

-- CreateIndex
CREATE INDEX "InventoryTransfer_venueId_idx" ON "public"."InventoryTransfer"("venueId");

-- AddForeignKey
ALTER TABLE "public"."CashDrawerSession" ADD CONSTRAINT "CashDrawerSession_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CashDrawerEvent" ADD CONSTRAINT "CashDrawerEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."CashDrawerSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
