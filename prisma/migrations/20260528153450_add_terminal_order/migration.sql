-- CreateEnum
CREATE TYPE "public"."TerminalOrderPaymentMethod" AS ENUM ('CARD_STRIPE', 'SPEI');

-- CreateEnum
CREATE TYPE "public"."TerminalOrderPaymentStatus" AS ENUM ('AWAITING_PAYMENT', 'AWAITING_PROOF', 'PROOF_UPLOADED', 'PAID', 'REJECTED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "public"."TerminalOrderFulfillmentStatus" AS ENUM ('NEW', 'AWAITING_SERIALS', 'SERIALS_ASSIGNED', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- AlterTable
ALTER TABLE "public"."Terminal" ADD COLUMN     "terminalOrderId" TEXT;

-- CreateTable
CREATE TABLE "public"."TerminalOrder" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "shippingAddress" TEXT NOT NULL,
    "shippingAddress2" TEXT,
    "shippingCity" TEXT NOT NULL,
    "shippingState" TEXT NOT NULL,
    "shippingZip" TEXT NOT NULL,
    "shippingCountry" TEXT NOT NULL DEFAULT 'México',
    "paymentMethod" "public"."TerminalOrderPaymentMethod" NOT NULL,
    "paymentStatus" "public"."TerminalOrderPaymentStatus" NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "stripeReceiptUrl" TEXT,
    "speiProofUrl" TEXT,
    "speiProofMimeType" TEXT,
    "speiProofUploadedAt" TIMESTAMP(3),
    "speiApprovalToken" TEXT,
    "speiTokenExpiresAt" TIMESTAMP(3),
    "speiApprovedAt" TIMESTAMP(3),
    "speiApprovedBy" TEXT,
    "speiRejectionReason" TEXT,
    "fulfillmentStatus" "public"."TerminalOrderFulfillmentStatus" NOT NULL DEFAULT 'NEW',
    "serialAssignmentToken" TEXT,
    "serialAssignmentTokenExpiresAt" TIMESTAMP(3),
    "serialsAssignedAt" TIMESTAMP(3),
    "serialsAssignedBy" TEXT,
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TerminalOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "namePrefix" TEXT NOT NULL,

    CONSTRAINT "TerminalOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TerminalOrder_orderNumber_key" ON "public"."TerminalOrder"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TerminalOrder_speiApprovalToken_key" ON "public"."TerminalOrder"("speiApprovalToken");

-- CreateIndex
CREATE UNIQUE INDEX "TerminalOrder_serialAssignmentToken_key" ON "public"."TerminalOrder"("serialAssignmentToken");

-- CreateIndex
CREATE INDEX "TerminalOrder_venueId_idx" ON "public"."TerminalOrder"("venueId");

-- CreateIndex
CREATE INDEX "TerminalOrder_venueId_createdAt_idx" ON "public"."TerminalOrder"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "TerminalOrder_paymentStatus_idx" ON "public"."TerminalOrder"("paymentStatus");

-- CreateIndex
CREATE INDEX "TerminalOrder_fulfillmentStatus_idx" ON "public"."TerminalOrder"("fulfillmentStatus");

-- CreateIndex
CREATE INDEX "TerminalOrder_speiApprovalToken_idx" ON "public"."TerminalOrder"("speiApprovalToken");

-- CreateIndex
CREATE INDEX "TerminalOrder_serialAssignmentToken_idx" ON "public"."TerminalOrder"("serialAssignmentToken");

-- CreateIndex
CREATE INDEX "TerminalOrderItem_orderId_idx" ON "public"."TerminalOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "Terminal_terminalOrderId_idx" ON "public"."Terminal"("terminalOrderId");

-- AddForeignKey
ALTER TABLE "public"."Terminal" ADD CONSTRAINT "Terminal_terminalOrderId_fkey" FOREIGN KEY ("terminalOrderId") REFERENCES "public"."TerminalOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TerminalOrder" ADD CONSTRAINT "TerminalOrder_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TerminalOrder" ADD CONSTRAINT "TerminalOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TerminalOrderItem" ADD CONSTRAINT "TerminalOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."TerminalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
