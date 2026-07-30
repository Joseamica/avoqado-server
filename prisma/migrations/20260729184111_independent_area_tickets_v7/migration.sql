/*
  Warnings:

  - A unique constraint covering the columns `[venueId,areaDeliveryCode]` on the table `Order` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "AreaTicketStatus" AS ENUM ('ISSUED', 'CLAIMED', 'PAID', 'DELIVERED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AreaTicketCheckoutStatus" AS ENUM ('OPEN', 'MATERIALIZED', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'RECONCILIATION_REQUIRED', 'PAID', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AreaTicketPaymentAttemptStatus" AS ENUM ('PREPARED', 'PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AreaTicketPrintStatus" AS ENUM ('NOT_PRINTED', 'PRINTED', 'PRINT_FAILED');

-- CreateEnum
CREATE TYPE "AreaTicketPrintAttemptStatus" AS ENUM ('PRINTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AreaTicketPrintAttemptKind" AS ENUM ('ORIGINAL', 'REPRINT');

-- CreateEnum
CREATE TYPE "AreaTicketFulfillmentMethod" AS ENUM ('PAPER_CONFIRMATION', 'RECEIPT_SCAN');

-- CreateEnum
CREATE TYPE "AreaTicketDeliveryVerificationMode" AS ENUM ('PAPER_CONFIRMATION', 'RECEIPT_SCAN', 'PAPER_OR_SCAN');

-- CreateEnum
CREATE TYPE "AreaTicketExpiryPolicy" AS ENUM ('BUSINESS_DAY_CLOSE', 'FIXED_DURATION');

-- CreateEnum
CREATE TYPE "AreaTicketInventoryReservationMode" AS ENUM ('NONE', 'HOLD_AVAILABLE_STOCK');

-- CreateEnum
CREATE TYPE "AreaTicketInventoryTarget" AS ENUM ('QUANTITY_INVENTORY', 'RAW_MATERIAL');

-- CreateEnum
CREATE TYPE "AreaTicketInventoryReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'WASTE');

-- CreateEnum
CREATE TYPE "TerminalWorkspace" AS ENUM ('STANDARD_POS', 'AREA_OPERATIONS');

-- CreateEnum
CREATE TYPE "ScaleContext" AS ENUM ('AREA_TICKET_LINE', 'INVENTORY_RECEIPT', 'INVENTORY_TRANSFER_DISPATCH', 'STOCK_COUNT', 'STOCK_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ScaleTransport" AS ENUM ('ANDROID_USB_SERIAL', 'DESKTOP_BRIDGE', 'MANUAL');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "areaDeliveryCode" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "areaTicketLineId" TEXT;

-- AlterTable
ALTER TABLE "Terminal" ADD COLUMN     "canCheckoutAreaTickets" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canDeliverAreaTickets" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canIssueAreaTickets" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "defaultWorkspace" "TerminalWorkspace" NOT NULL DEFAULT 'STANDARD_POS',
ADD COLUMN     "scaleProfileId" TEXT;

-- CreateTable
CREATE TABLE "VenueAreaTicketSettings" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "allowMixedCart" BOOLEAN NOT NULL DEFAULT true,
    "claimTtlSeconds" INTEGER NOT NULL DEFAULT 300,
    "checkoutSessionMaxAgeMinutes" INTEGER NOT NULL DEFAULT 30,
    "ticketExpiryPolicy" "AreaTicketExpiryPolicy" NOT NULL DEFAULT 'BUSINESS_DAY_CLOSE',
    "ticketExpiryMinutes" INTEGER,
    "deliveryVerificationMode" "AreaTicketDeliveryVerificationMode" NOT NULL DEFAULT 'PAPER_OR_SCAN',
    "codeSymbology" TEXT NOT NULL DEFAULT 'CODE128',
    "requireManagerForCancel" BOOLEAN NOT NULL DEFAULT true,
    "recordWasteOnCancel" BOOLEAN NOT NULL DEFAULT false,
    "inventoryReservationMode" "AreaTicketInventoryReservationMode" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueAreaTicketSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaTicket" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "fulfillmentAreaId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "status" "AreaTicketStatus" NOT NULL DEFAULT 'ISSUED',
    "sourceTerminalId" TEXT NOT NULL,
    "issuedByStaffId" TEXT,
    "checkoutSessionId" TEXT,
    "orderId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "pricingSnapshotHash" VARCHAR(64) NOT NULL,
    "printStatus" "AreaTicketPrintStatus" NOT NULL DEFAULT 'NOT_PRINTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AreaTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaTicketLine" (
    "id" TEXT NOT NULL,
    "areaTicketId" TEXT NOT NULL,
    "clientLineId" VARCHAR(64) NOT NULL,
    "productId" TEXT,
    "productNameSnapshot" TEXT NOT NULL,
    "skuSnapshot" TEXT,
    "categoryNameSnapshot" TEXT,
    "modifiersSnapshot" JSONB,
    "quantity" DECIMAL(12,3) NOT NULL,
    "weightKg" DECIMAL(12,3),
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "appliedDiscountId" TEXT,
    "taxAmount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AreaTicketLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaTicketInventoryReservation" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "areaTicketId" TEXT NOT NULL,
    "areaTicketLineId" TEXT NOT NULL,
    "inventoryKind" "AreaTicketInventoryTarget" NOT NULL,
    "inventoryId" TEXT NOT NULL,
    "quantityBaseUnits" DECIMAL(12,3) NOT NULL,
    "status" "AreaTicketInventoryReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "inventoryMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "AreaTicketInventoryReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaTicketCheckoutSession" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "staffId" TEXT,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "materializeIdempotencyKey" VARCHAR(64),
    "cancelIdempotencyKey" VARCHAR(64),
    "status" "AreaTicketCheckoutStatus" NOT NULL DEFAULT 'OPEN',
    "orderId" TEXT,
    "activePaymentAttemptId" TEXT,
    "lastHeartbeatAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AreaTicketCheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaTicketPaymentAttempt" (
    "id" TEXT NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "AreaTicketPaymentAttemptStatus" NOT NULL DEFAULT 'PREPARED',
    "paymentId" TEXT,
    "providerReference" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),

    CONSTRAINT "AreaTicketPaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaTicketPrintAttempt" (
    "id" TEXT NOT NULL,
    "areaTicketId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "terminalId" TEXT NOT NULL,
    "staffId" TEXT,
    "status" "AreaTicketPrintAttemptStatus" NOT NULL,
    "kind" "AreaTicketPrintAttemptKind" NOT NULL,
    "reason" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AreaTicketPrintAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AreaTicketFulfillment" (
    "id" TEXT NOT NULL,
    "areaTicketId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fulfillmentAreaId" TEXT NOT NULL,
    "method" "AreaTicketFulfillmentMethod" NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "deliveredByStaffId" TEXT,
    "terminalId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AreaTicketFulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueScaleSettings" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueScaleSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScaleProfile" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "allowedContexts" "ScaleContext"[],
    "transport" "ScaleTransport" NOT NULL DEFAULT 'MANUAL',
    "vendorId" INTEGER,
    "productId" INTEGER,
    "baudRate" INTEGER,
    "dataBits" INTEGER,
    "parity" TEXT,
    "stopBits" INTEGER,
    "frameParser" JSONB,
    "stableIndicator" TEXT,
    "unit" "Unit" NOT NULL DEFAULT 'KILOGRAM',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScaleProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VenueAreaTicketSettings_venueId_key" ON "VenueAreaTicketSettings"("venueId");

-- CreateIndex
CREATE INDEX "AreaTicket_venueId_status_fulfillmentAreaId_issuedAt_idx" ON "AreaTicket"("venueId", "status", "fulfillmentAreaId", "issuedAt");

-- CreateIndex
CREATE INDEX "AreaTicket_venueId_checkoutSessionId_status_idx" ON "AreaTicket"("venueId", "checkoutSessionId", "status");

-- CreateIndex
CREATE INDEX "AreaTicket_venueId_orderId_idx" ON "AreaTicket"("venueId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicket_venueId_code_key" ON "AreaTicket"("venueId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicket_venueId_idempotencyKey_key" ON "AreaTicket"("venueId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AreaTicketLine_areaTicketId_idx" ON "AreaTicketLine"("areaTicketId");

-- CreateIndex
CREATE INDEX "AreaTicketLine_productId_idx" ON "AreaTicketLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketLine_areaTicketId_clientLineId_key" ON "AreaTicketLine"("areaTicketId", "clientLineId");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketInventoryReservation_inventoryMovementId_key" ON "AreaTicketInventoryReservation"("inventoryMovementId");

-- CreateIndex
CREATE INDEX "AreaTicketInventoryReservation_venueId_inventoryKind_invent_idx" ON "AreaTicketInventoryReservation"("venueId", "inventoryKind", "inventoryId", "status");

-- CreateIndex
CREATE INDEX "AreaTicketInventoryReservation_areaTicketId_status_idx" ON "AreaTicketInventoryReservation"("areaTicketId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketInventoryReservation_areaTicketLineId_inventoryKi_key" ON "AreaTicketInventoryReservation"("areaTicketLineId", "inventoryKind", "inventoryId");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketCheckoutSession_orderId_key" ON "AreaTicketCheckoutSession"("orderId");

-- CreateIndex
CREATE INDEX "AreaTicketCheckoutSession_venueId_terminalId_status_created_idx" ON "AreaTicketCheckoutSession"("venueId", "terminalId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketCheckoutSession_venueId_idempotencyKey_key" ON "AreaTicketCheckoutSession"("venueId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketPaymentAttempt_paymentId_key" ON "AreaTicketPaymentAttempt"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketPaymentAttempt_checkoutSessionId_idempotencyKey_key" ON "AreaTicketPaymentAttempt"("checkoutSessionId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketPaymentAttempt_checkoutSessionId_sequence_key" ON "AreaTicketPaymentAttempt"("checkoutSessionId", "sequence");

-- CreateIndex
CREATE INDEX "AreaTicketPrintAttempt_areaTicketId_createdAt_idx" ON "AreaTicketPrintAttempt"("areaTicketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketPrintAttempt_areaTicketId_idempotencyKey_key" ON "AreaTicketPrintAttempt"("areaTicketId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketFulfillment_areaTicketId_key" ON "AreaTicketFulfillment"("areaTicketId");

-- CreateIndex
CREATE INDEX "AreaTicketFulfillment_fulfillmentAreaId_deliveredAt_idx" ON "AreaTicketFulfillment"("fulfillmentAreaId", "deliveredAt");

-- CreateIndex
CREATE INDEX "AreaTicketFulfillment_orderId_idx" ON "AreaTicketFulfillment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "AreaTicketFulfillment_areaTicketId_idempotencyKey_key" ON "AreaTicketFulfillment"("areaTicketId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "VenueScaleSettings_venueId_key" ON "VenueScaleSettings"("venueId");

-- CreateIndex
CREATE INDEX "ScaleProfile_venueId_active_idx" ON "ScaleProfile"("venueId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ScaleProfile_venueId_name_key" ON "ScaleProfile"("venueId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Order_venueId_areaDeliveryCode_key" ON "Order"("venueId", "areaDeliveryCode");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_areaTicketLineId_key" ON "OrderItem"("areaTicketLineId");

-- CreateIndex
CREATE INDEX "Terminal_scaleProfileId_idx" ON "Terminal"("scaleProfileId");

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_scaleProfileId_fkey" FOREIGN KEY ("scaleProfileId") REFERENCES "ScaleProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueAreaTicketSettings" ADD CONSTRAINT "VenueAreaTicketSettings_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicket" ADD CONSTRAINT "AreaTicket_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicket" ADD CONSTRAINT "AreaTicket_fulfillmentAreaId_fkey" FOREIGN KEY ("fulfillmentAreaId") REFERENCES "FulfillmentArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicket" ADD CONSTRAINT "AreaTicket_sourceTerminalId_fkey" FOREIGN KEY ("sourceTerminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicket" ADD CONSTRAINT "AreaTicket_issuedByStaffId_fkey" FOREIGN KEY ("issuedByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicket" ADD CONSTRAINT "AreaTicket_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "AreaTicketCheckoutSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicket" ADD CONSTRAINT "AreaTicket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketLine" ADD CONSTRAINT "AreaTicketLine_areaTicketId_fkey" FOREIGN KEY ("areaTicketId") REFERENCES "AreaTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketLine" ADD CONSTRAINT "AreaTicketLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_areaTicketLineId_fkey" FOREIGN KEY ("areaTicketLineId") REFERENCES "AreaTicketLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketInventoryReservation" ADD CONSTRAINT "AreaTicketInventoryReservation_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketInventoryReservation" ADD CONSTRAINT "AreaTicketInventoryReservation_areaTicketId_fkey" FOREIGN KEY ("areaTicketId") REFERENCES "AreaTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketInventoryReservation" ADD CONSTRAINT "AreaTicketInventoryReservation_areaTicketLineId_fkey" FOREIGN KEY ("areaTicketLineId") REFERENCES "AreaTicketLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketCheckoutSession" ADD CONSTRAINT "AreaTicketCheckoutSession_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketCheckoutSession" ADD CONSTRAINT "AreaTicketCheckoutSession_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketCheckoutSession" ADD CONSTRAINT "AreaTicketCheckoutSession_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketCheckoutSession" ADD CONSTRAINT "AreaTicketCheckoutSession_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketPaymentAttempt" ADD CONSTRAINT "AreaTicketPaymentAttempt_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "AreaTicketCheckoutSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketPaymentAttempt" ADD CONSTRAINT "AreaTicketPaymentAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketPrintAttempt" ADD CONSTRAINT "AreaTicketPrintAttempt_areaTicketId_fkey" FOREIGN KEY ("areaTicketId") REFERENCES "AreaTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketPrintAttempt" ADD CONSTRAINT "AreaTicketPrintAttempt_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketPrintAttempt" ADD CONSTRAINT "AreaTicketPrintAttempt_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketFulfillment" ADD CONSTRAINT "AreaTicketFulfillment_areaTicketId_fkey" FOREIGN KEY ("areaTicketId") REFERENCES "AreaTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketFulfillment" ADD CONSTRAINT "AreaTicketFulfillment_fulfillmentAreaId_fkey" FOREIGN KEY ("fulfillmentAreaId") REFERENCES "FulfillmentArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketFulfillment" ADD CONSTRAINT "AreaTicketFulfillment_deliveredByStaffId_fkey" FOREIGN KEY ("deliveredByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AreaTicketFulfillment" ADD CONSTRAINT "AreaTicketFulfillment_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueScaleSettings" ADD CONSTRAINT "VenueScaleSettings_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScaleProfile" ADD CONSTRAINT "ScaleProfile_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
