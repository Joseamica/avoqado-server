-- CreateEnum
CREATE TYPE "OnlineOrderChargeStatus" AS ENUM ('PENDING_AUTH', 'AUTHORIZED', 'CAPTURING', 'CAPTURED', 'CAPTURE_FAILED', 'RELEASING', 'RELEASED', 'ABANDONED');

-- AlterEnum
ALTER TYPE "OnlineOrderPaymentMode" ADD VALUE 'CARD_ONLINE';

-- AlterEnum
ALTER TYPE "OnlineOrderRejectReason" ADD VALUE 'PAYMENT_FAILED';

-- AlterTable
ALTER TABLE "OnlineOrderingSettings" ADD COLUMN     "acceptsCardOnline" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OnlineOrderCharge" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "onlineOrderId" TEXT,
    "ecommerceMerchantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "trackingToken" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "requestHash" TEXT NOT NULL,
    "checkoutSessionId" TEXT,
    "checkoutUrl" TEXT,
    "checkoutExpiresAt" TIMESTAMP(3) NOT NULL,
    "paymentIntentId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "platformFeeBps" INTEGER NOT NULL,
    "applicationFeeCents" INTEGER NOT NULL,
    "status" "OnlineOrderChargeStatus" NOT NULL DEFAULT 'PENDING_AUTH',
    "authorizedAt" TIMESTAMP(3),
    "captureBefore" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "capturedAmount" DECIMAL(10,2),
    "releasedAt" TIMESTAMP(3),
    "merchantSnapshot" JSONB NOT NULL,
    "checkoutAttempt" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "OnlineOrderCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderCharge_onlineOrderId_key" ON "OnlineOrderCharge"("onlineOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderCharge_trackingToken_key" ON "OnlineOrderCharge"("trackingToken");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderCharge_checkoutSessionId_key" ON "OnlineOrderCharge"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderCharge_paymentIntentId_key" ON "OnlineOrderCharge"("paymentIntentId");

-- CreateIndex
CREATE INDEX "OnlineOrderCharge_status_updatedAt_idx" ON "OnlineOrderCharge"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "OnlineOrderCharge_venueId_status_customerPhone_idx" ON "OnlineOrderCharge"("venueId", "status", "customerPhone");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineOrderCharge_venueId_idempotencyKey_key" ON "OnlineOrderCharge"("venueId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "OnlineOrderCharge" ADD CONSTRAINT "OnlineOrderCharge_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineOrderCharge" ADD CONSTRAINT "OnlineOrderCharge_onlineOrderId_fkey" FOREIGN KEY ("onlineOrderId") REFERENCES "OnlineOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlineOrderCharge" ADD CONSTRAINT "OnlineOrderCharge_ecommerceMerchantId_fkey" FOREIGN KEY ("ecommerceMerchantId") REFERENCES "EcommerceMerchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
