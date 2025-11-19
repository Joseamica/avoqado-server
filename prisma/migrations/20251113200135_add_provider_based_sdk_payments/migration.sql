-- CreateEnum
CREATE TYPE "public"."CheckoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED');

-- AlterEnum
ALTER TYPE "public"."PaymentSource" ADD VALUE 'SDK';

-- CreateTable
CREATE TABLE "public"."ExternalMerchant" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "rfc" TEXT,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "website" TEXT,
    "publicKey" TEXT NOT NULL,
    "secretKeyEncrypted" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerCredentials" JSONB NOT NULL,
    "costStructureId" TEXT,
    "pricingStructureId" TEXT,
    "webhookUrl" TEXT,
    "webhookSecretEncrypted" TEXT,
    "webhookEvents" TEXT[] DEFAULT ARRAY['payment.completed', 'payment.failed']::TEXT[],
    "dashboardUserId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sandboxMode" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalMerchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CheckoutSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "externalMerchantId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "description" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "customerName" TEXT,
    "externalOrderId" TEXT,
    "metadata" JSONB,
    "blumonCheckoutId" TEXT,
    "blumonCheckoutUrl" TEXT,
    "paymentId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "referrer" TEXT,
    "status" "public"."CheckoutStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalMerchant_contactEmail_key" ON "public"."ExternalMerchant"("contactEmail");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalMerchant_publicKey_key" ON "public"."ExternalMerchant"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalMerchant_secretKeyEncrypted_key" ON "public"."ExternalMerchant"("secretKeyEncrypted");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalMerchant_dashboardUserId_key" ON "public"."ExternalMerchant"("dashboardUserId");

-- CreateIndex
CREATE INDEX "ExternalMerchant_publicKey_idx" ON "public"."ExternalMerchant"("publicKey");

-- CreateIndex
CREATE INDEX "ExternalMerchant_contactEmail_idx" ON "public"."ExternalMerchant"("contactEmail");

-- CreateIndex
CREATE INDEX "ExternalMerchant_active_idx" ON "public"."ExternalMerchant"("active");

-- CreateIndex
CREATE INDEX "ExternalMerchant_sandboxMode_idx" ON "public"."ExternalMerchant"("sandboxMode");

-- CreateIndex
CREATE INDEX "ExternalMerchant_providerId_idx" ON "public"."ExternalMerchant"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_sessionId_key" ON "public"."CheckoutSession"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSession_paymentId_key" ON "public"."CheckoutSession"("paymentId");

-- CreateIndex
CREATE INDEX "CheckoutSession_externalMerchantId_idx" ON "public"."CheckoutSession"("externalMerchantId");

-- CreateIndex
CREATE INDEX "CheckoutSession_sessionId_idx" ON "public"."CheckoutSession"("sessionId");

-- CreateIndex
CREATE INDEX "CheckoutSession_status_idx" ON "public"."CheckoutSession"("status");

-- CreateIndex
CREATE INDEX "CheckoutSession_externalOrderId_idx" ON "public"."CheckoutSession"("externalOrderId");

-- CreateIndex
CREATE INDEX "CheckoutSession_createdAt_idx" ON "public"."CheckoutSession"("createdAt");

-- CreateIndex
CREATE INDEX "CheckoutSession_expiresAt_idx" ON "public"."CheckoutSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CheckoutSession_paymentId_idx" ON "public"."CheckoutSession"("paymentId");

-- AddForeignKey
ALTER TABLE "public"."ExternalMerchant" ADD CONSTRAINT "ExternalMerchant_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "public"."PaymentProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExternalMerchant" ADD CONSTRAINT "ExternalMerchant_costStructureId_fkey" FOREIGN KEY ("costStructureId") REFERENCES "public"."ProviderCostStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExternalMerchant" ADD CONSTRAINT "ExternalMerchant_pricingStructureId_fkey" FOREIGN KEY ("pricingStructureId") REFERENCES "public"."VenuePricingStructure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExternalMerchant" ADD CONSTRAINT "ExternalMerchant_dashboardUserId_fkey" FOREIGN KEY ("dashboardUserId") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckoutSession" ADD CONSTRAINT "CheckoutSession_externalMerchantId_fkey" FOREIGN KEY ("externalMerchantId") REFERENCES "public"."ExternalMerchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckoutSession" ADD CONSTRAINT "CheckoutSession_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
