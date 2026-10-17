-- Tarjetas de regalo, fase 1a (spec docs/superpowers/specs/2026-10-14-tarjetas-de-regalo-design.md § 4).
-- Tablas nuevas (sobre, libreta y ajustes), la marca del tender de sistema y dos columnas del pase que usa la fase 1c.
-- Toca tablas vivas (OrderItem, VenueTenderType, WalletPass): sólo agrega columnas nulas, sin reescribir filas.
-- La FK de OrderItem nace NOT VALID (validarla aquí recorrería OrderItem bajo un candado que frena las ventas); se valida
-- en 20261015090020. El índice único de OrderItem va CONCURRENTLY en 20261015090010 (una sentencia por archivo).
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "GiftCardStatus" AS ENUM ('PENDING', 'ACTIVE', 'BLOCKED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "GiftCardActivityType" AS ENUM ('ACTIVATE', 'REDEEM', 'REDEEM_REVERSAL', 'ADJUST_INCREMENT', 'ADJUST_DECREMENT', 'BLOCK', 'UNBLOCK', 'DEACTIVATE', 'CLAIM', 'CODE_REPLACED');

-- CreateEnum
CREATE TYPE "GiftCardReason" AS ENUM ('SUSPICIOUS_ACTIVITY', 'CASHIER_ERROR', 'CUSTOMER_REQUEST', 'LOST_CARD', 'SALE_CANCELLED', 'ONLINE_REVOCATION', 'CHARGEBACK', 'CANCEL_IN_PROGRESS', 'OTHER');

-- CreateEnum
CREATE TYPE "GiftCardDeliveryChannel" AS ENUM ('WHATSAPP', 'EMAIL', 'PRINTED', 'CUSTOMER_CARD', 'HANDED_TO_BUYER');

-- CreateEnum
CREATE TYPE "GiftCardDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "GiftCardSource" AS ENUM ('POS', 'ONLINE');

-- CreateEnum
CREATE TYPE "TenderSystemKind" AS ENUM ('GIFT_CARD');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "giftCardId" TEXT;

-- AlterTable
ALTER TABLE "VenueTenderType" ADD COLUMN     "systemKind" "TenderSystemKind";

-- AlterTable
ALTER TABLE "WalletPass" ADD COLUMN     "googleSyncedRevision" INTEGER,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeEnc" TEXT NOT NULL,
    "codeLast4" TEXT NOT NULL,
    "pageToken" TEXT NOT NULL,
    "initialAmount" DECIMAL(12,2) NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL,
    "status" "GiftCardStatus" NOT NULL DEFAULT 'PENDING',
    "validityMonths" INTEGER,
    "termsVersion" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "customerId" TEXT,
    "purchaserName" TEXT,
    "purchaserContact" TEXT,
    "recipientName" TEXT,
    "recipientPhone" TEXT,
    "recipientEmail" TEXT,
    "message" VARCHAR(200),
    "deliveryChannel" "GiftCardDeliveryChannel" NOT NULL,
    "deliveryStatus" "GiftCardDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "deliveredAt" TIMESTAMP(3),
    "source" "GiftCardSource" NOT NULL DEFAULT 'POS',
    "cancelToken" TEXT,
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GiftCard_balance_no_negativo" CHECK ("balance" >= 0),
    CONSTRAINT "GiftCard_initialAmount_positivo" CHECK ("initialAmount" > 0)
);

-- CreateTable
CREATE TABLE "GiftCardActivity" (
    "id" TEXT NOT NULL,
    "giftCardId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "type" "GiftCardActivityType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "reason" "GiftCardReason",
    "note" TEXT,
    "paymentId" TEXT,
    "refundPaymentId" TEXT,
    "reversesActivityId" TEXT,
    "orderId" TEXT,
    "staffId" TEXT,
    "deviceId" TEXT,
    "operationKey" TEXT,
    "operationHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCardActivity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GiftCardActivity_amount_no_negativo" CHECK ("amount" >= 0),
    CONSTRAINT "GiftCardActivity_balanceAfter_no_negativo" CHECK ("balanceAfter" >= 0)
);

-- CreateTable
CREATE TABLE "GiftCardSettings" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "suggestedAmounts" DECIMAL(12,2)[],
    "minAmount" DECIMAL(12,2) NOT NULL DEFAULT 100,
    "maxAmount" DECIMAL(12,2) NOT NULL DEFAULT 10000,
    "validityMonths" INTEGER,
    "termsVersion" TEXT NOT NULL DEFAULT '2026-10-14',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "GiftCardSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_codeHash_key" ON "GiftCard"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_pageToken_key" ON "GiftCard"("pageToken");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_cancelToken_key" ON "GiftCard"("cancelToken");

-- CreateIndex
CREATE INDEX "GiftCard_venueId_status_createdAt_idx" ON "GiftCard"("venueId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "GiftCard_venueId_customerId_idx" ON "GiftCard"("venueId", "customerId");

-- CreateIndex
CREATE INDEX "GiftCard_venueId_expiresAt_idx" ON "GiftCard"("venueId", "expiresAt");

-- CreateIndex
CREATE INDEX "GiftCardActivity_giftCardId_createdAt_idx" ON "GiftCardActivity"("giftCardId", "createdAt");

-- CreateIndex
CREATE INDEX "GiftCardActivity_venueId_createdAt_idx" ON "GiftCardActivity"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "GiftCardActivity_reversesActivityId_idx" ON "GiftCardActivity"("reversesActivityId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardActivity_paymentId_giftCardId_type_key" ON "GiftCardActivity"("paymentId", "giftCardId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardActivity_refundPaymentId_reversesActivityId_key" ON "GiftCardActivity"("refundPaymentId", "reversesActivityId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardActivity_venueId_operationKey_key" ON "GiftCardActivity"("venueId", "operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardSettings_venueId_key" ON "GiftCardSettings"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueTenderType_venueId_systemKind_key" ON "VenueTenderType"("venueId", "systemKind");

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardActivity" ADD CONSTRAINT "GiftCardActivity_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardSettings" ADD CONSTRAINT "GiftCardSettings_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (NOT VALID: se valida en 20261015090020 sin bloquear las ventas)
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
