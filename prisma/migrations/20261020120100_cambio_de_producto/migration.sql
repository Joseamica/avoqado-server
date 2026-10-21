-- Product exchange (spec 2026-10-20, block A, task 1): the Exchange link, its credit portions and the per-venue switch.
-- Only adds: three enums, one nullable column (no default, so no table rewrite) and two new tables. No existing row moves.
-- `Exchange` and `ExchangeCreditLink` carry scalar ids on purpose (no FK to Venue, Order or Payment), like InventoryPosting.
-- The EXCHANGE_CREDIT value of "TenderSystemKind" lives in the previous migration (20261020120000_cambio_de_producto_tender).
--
-- Rollback (not run):
--   ALTER TABLE "VenueSettings" DROP COLUMN "exchangesEnabled";
--   DROP TABLE "ExchangeCreditLink", "Exchange";
--   DROP TYPE "ExchangeSettlementMethod", "ExchangeSettlementKind", "ExchangeStatus";

-- CreateEnum
CREATE TYPE "ExchangeStatus" AS ENUM ('COMPLETED', 'PENDING_PAYMENT', 'COMPLETED_PENDING_CARD_REFUND', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "ExchangeSettlementKind" AS ENUM ('EVEN', 'COLLECT', 'PAYOUT');

-- CreateEnum
CREATE TYPE "ExchangeSettlementMethod" AS ENUM ('CASH', 'CARD_TERMINAL', 'BANK_TRANSFER', 'GIFT_CARD_BALANCE', 'TENDER');

-- AlterTable
ALTER TABLE "VenueSettings" ADD COLUMN     "exchangesEnabled" BOOLEAN;

-- CreateTable
CREATE TABLE "Exchange" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "status" "ExchangeStatus" NOT NULL,
    "originalOrderId" TEXT NOT NULL,
    "originalPaymentId" TEXT NOT NULL,
    "newOrderId" TEXT NOT NULL,
    "returnedAmount" DECIMAL(12,2) NOT NULL,
    "takenAmount" DECIMAL(12,2) NOT NULL,
    "differenceAmount" DECIMAL(12,2) NOT NULL,
    "settlementKind" "ExchangeSettlementKind" NOT NULL,
    "settlementMethod" "ExchangeSettlementMethod",
    "pendingCardRefundAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL,
    "result" JSONB,
    "staffId" TEXT NOT NULL,
    "deviceId" VARCHAR(128),
    "createdAtLocal" TIMESTAMP(3),
    "isOfflineReplay" BOOLEAN NOT NULL DEFAULT false,
    "cashDrawerSessionId" TEXT,
    "reviewReason" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Exchange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeCreditLink" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "exchangeId" TEXT NOT NULL,
    "originPaymentId" TEXT NOT NULL,
    "creditRefundPaymentId" TEXT NOT NULL,
    "creditPaymentId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeCreditLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Exchange_newOrderId_key" ON "Exchange"("newOrderId");

-- CreateIndex
CREATE INDEX "Exchange_venueId_createdAt_idx" ON "Exchange"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "Exchange_venueId_status_createdAt_idx" ON "Exchange"("venueId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Exchange_venueId_originalOrderId_idx" ON "Exchange"("venueId", "originalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Exchange_venueId_idempotencyKey_key" ON "Exchange"("venueId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeCreditLink_creditRefundPaymentId_key" ON "ExchangeCreditLink"("creditRefundPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeCreditLink_creditPaymentId_key" ON "ExchangeCreditLink"("creditPaymentId");

-- CreateIndex
CREATE INDEX "ExchangeCreditLink_venueId_originPaymentId_idx" ON "ExchangeCreditLink"("venueId", "originPaymentId");

-- CreateIndex
CREATE INDEX "ExchangeCreditLink_exchangeId_idx" ON "ExchangeCreditLink"("exchangeId");

-- AddForeignKey
ALTER TABLE "ExchangeCreditLink" ADD CONSTRAINT "ExchangeCreditLink_exchangeId_fkey" FOREIGN KEY ("exchangeId") REFERENCES "Exchange"("id") ON DELETE CASCADE ON UPDATE CASCADE;
