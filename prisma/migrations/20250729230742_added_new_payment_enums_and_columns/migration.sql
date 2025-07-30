-- CreateEnum
CREATE TYPE "CardBrand" AS ENUM ('VISA', 'MASTERCARD', 'AMERICAN_EXPRESS', 'DISCOVER', 'DINERS_CLUB', 'JCB', 'MAESTRO', 'UNIONPAY', 'ELO', 'HIPERCARD', 'OTHER');

-- CreateEnum
CREATE TYPE "CardEntryMode" AS ENUM ('CONTACTLESS', 'CHIP', 'SWIPE', 'MANUAL', 'FALLBACK', 'ONLINE', 'OTHER');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "authorizationNumber" TEXT,
ADD COLUMN     "cardBrand" "CardBrand",
ADD COLUMN     "entryMode" "CardEntryMode",
ADD COLUMN     "maskedPan" TEXT,
ADD COLUMN     "referenceNumber" TEXT;

-- CreateIndex
CREATE INDEX "Payment_authorizationNumber_idx" ON "Payment"("authorizationNumber");

-- CreateIndex
CREATE INDEX "Payment_referenceNumber_idx" ON "Payment"("referenceNumber");

-- CreateIndex
CREATE INDEX "Payment_cardBrand_idx" ON "Payment"("cardBrand");
