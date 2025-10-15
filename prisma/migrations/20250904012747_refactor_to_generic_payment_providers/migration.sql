-- CreateEnum
CREATE TYPE "public"."PaymentProcessor" AS ENUM ('LEGACY', 'MENTA', 'CLIP', 'BANK_DIRECT', 'AUTO');

-- CreateEnum
CREATE TYPE "public"."ProviderType" AS ENUM ('PAYMENT_PROCESSOR', 'BANK_DIRECT', 'WALLET', 'GATEWAY', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."EventStatus" AS ENUM ('PENDING', 'PROCESSED', 'ERROR');

-- AlterTable
ALTER TABLE "public"."Terminal" ADD COLUMN     "preferredProcessor" "public"."PaymentProcessor" NOT NULL DEFAULT 'AUTO';

-- CreateTable
CREATE TABLE "public"."PaymentProvider" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "public"."ProviderType" NOT NULL,
    "countryCode" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "configSchema" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MerchantAccount" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "externalMerchantId" TEXT NOT NULL,
    "alias" TEXT,
    "credentialsEncrypted" JSONB NOT NULL,
    "providerConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."VenuePaymentConfig" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "primaryAccountId" TEXT NOT NULL,
    "secondaryAccountId" TEXT,
    "tertiaryAccountId" TEXT,
    "routingRules" JSONB,
    "preferredProcessor" "public"."PaymentProcessor" NOT NULL DEFAULT 'AUTO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenuePaymentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MentaWebhookSubscription" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "providerId" TEXT,
    "url" TEXT NOT NULL,
    "secretEncrypted" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentaWebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProviderEventLog" (
    "id" TEXT NOT NULL,
    "provider" "public"."ProviderType" NOT NULL DEFAULT 'PAYMENT_PROCESSOR',
    "venueId" TEXT,
    "providerId" TEXT,
    "eventId" TEXT,
    "type" TEXT,
    "payload" JSONB NOT NULL,
    "status" "public"."EventStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProvider_code_key" ON "public"."PaymentProvider"("code");

-- CreateIndex
CREATE INDEX "PaymentProvider_code_idx" ON "public"."PaymentProvider"("code");

-- CreateIndex
CREATE INDEX "PaymentProvider_type_idx" ON "public"."PaymentProvider"("type");

-- CreateIndex
CREATE INDEX "MerchantAccount_providerId_idx" ON "public"."MerchantAccount"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantAccount_providerId_externalMerchantId_key" ON "public"."MerchantAccount"("providerId", "externalMerchantId");

-- CreateIndex
CREATE UNIQUE INDEX "VenuePaymentConfig_venueId_key" ON "public"."VenuePaymentConfig"("venueId");

-- CreateIndex
CREATE INDEX "VenuePaymentConfig_primaryAccountId_idx" ON "public"."VenuePaymentConfig"("primaryAccountId");

-- CreateIndex
CREATE INDEX "VenuePaymentConfig_secondaryAccountId_idx" ON "public"."VenuePaymentConfig"("secondaryAccountId");

-- CreateIndex
CREATE INDEX "VenuePaymentConfig_tertiaryAccountId_idx" ON "public"."VenuePaymentConfig"("tertiaryAccountId");

-- CreateIndex
CREATE INDEX "MentaWebhookSubscription_venueId_idx" ON "public"."MentaWebhookSubscription"("venueId");

-- CreateIndex
CREATE INDEX "MentaWebhookSubscription_providerId_idx" ON "public"."MentaWebhookSubscription"("providerId");

-- CreateIndex
CREATE INDEX "ProviderEventLog_provider_idx" ON "public"."ProviderEventLog"("provider");

-- CreateIndex
CREATE INDEX "ProviderEventLog_venueId_idx" ON "public"."ProviderEventLog"("venueId");

-- CreateIndex
CREATE INDEX "ProviderEventLog_status_idx" ON "public"."ProviderEventLog"("status");

-- CreateIndex
CREATE INDEX "ProviderEventLog_providerId_idx" ON "public"."ProviderEventLog"("providerId");

-- AddForeignKey
ALTER TABLE "public"."MerchantAccount" ADD CONSTRAINT "MerchantAccount_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "public"."PaymentProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VenuePaymentConfig" ADD CONSTRAINT "VenuePaymentConfig_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VenuePaymentConfig" ADD CONSTRAINT "VenuePaymentConfig_primaryAccountId_fkey" FOREIGN KEY ("primaryAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VenuePaymentConfig" ADD CONSTRAINT "VenuePaymentConfig_secondaryAccountId_fkey" FOREIGN KEY ("secondaryAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VenuePaymentConfig" ADD CONSTRAINT "VenuePaymentConfig_tertiaryAccountId_fkey" FOREIGN KEY ("tertiaryAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MentaWebhookSubscription" ADD CONSTRAINT "MentaWebhookSubscription_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MentaWebhookSubscription" ADD CONSTRAINT "MentaWebhookSubscription_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "public"."PaymentProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProviderEventLog" ADD CONSTRAINT "ProviderEventLog_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProviderEventLog" ADD CONSTRAINT "ProviderEventLog_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "public"."PaymentProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
