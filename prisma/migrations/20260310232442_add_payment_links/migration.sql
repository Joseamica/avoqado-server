-- CreateEnum
CREATE TYPE "public"."PaymentLinkAmountType" AS ENUM ('FIXED', 'OPEN');

-- CreateEnum
CREATE TYPE "public"."PaymentLinkStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "public"."CheckoutSession" ADD COLUMN     "paymentLinkId" TEXT;

-- CreateTable
CREATE TABLE "public"."PaymentLink" (
    "id" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "ecommerceMerchantId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "amountType" "public"."PaymentLinkAmountType" NOT NULL,
    "amount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "isReusable" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "redirectUrl" TEXT,
    "status" "public"."PaymentLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "totalCollected" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paymentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_shortCode_key" ON "public"."PaymentLink"("shortCode");

-- CreateIndex
CREATE INDEX "PaymentLink_venueId_idx" ON "public"."PaymentLink"("venueId");

-- CreateIndex
CREATE INDEX "PaymentLink_shortCode_idx" ON "public"."PaymentLink"("shortCode");

-- CreateIndex
CREATE INDEX "PaymentLink_status_idx" ON "public"."PaymentLink"("status");

-- CreateIndex
CREATE INDEX "PaymentLink_createdAt_idx" ON "public"."PaymentLink"("createdAt");

-- CreateIndex
CREATE INDEX "CheckoutSession_paymentLinkId_idx" ON "public"."CheckoutSession"("paymentLinkId");

-- AddForeignKey
ALTER TABLE "public"."CheckoutSession" ADD CONSTRAINT "CheckoutSession_paymentLinkId_fkey" FOREIGN KEY ("paymentLinkId") REFERENCES "public"."PaymentLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PaymentLink" ADD CONSTRAINT "PaymentLink_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PaymentLink" ADD CONSTRAINT "PaymentLink_ecommerceMerchantId_fkey" FOREIGN KEY ("ecommerceMerchantId") REFERENCES "public"."EcommerceMerchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PaymentLink" ADD CONSTRAINT "PaymentLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
