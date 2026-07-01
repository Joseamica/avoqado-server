-- CreateEnum
CREATE TYPE "public"."FinancialConnectionType" AS ENUM ('DIRECT_CREDENTIAL', 'DIRECT_OAUTH', 'AGGREGATOR');

-- CreateEnum
CREATE TYPE "public"."FinancialConnectionMode" AS ENUM ('SELF_CONNECT', 'SHARED_BROKER');

-- CreateEnum
CREATE TYPE "public"."FinancialConnectionStatus" AS ENUM ('PENDING_DEVICE_VALIDATION', 'PENDING_ACCOUNT_SELECTION', 'CONNECTED', 'NEEDS_REAUTH', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "public"."FinancialBalanceState" AS ENUM ('OK', 'ERROR', 'UNKNOWN');

-- DropForeignKey
ALTER TABLE "public"."MerchantAccount" DROP CONSTRAINT "MerchantAccount_balanceProviderId_fkey";

-- AlterTable
ALTER TABLE "public"."MerchantAccount" DROP COLUMN "balanceProviderAccountId",
DROP COLUMN "balanceProviderId",
ADD COLUMN     "financialAccountId" TEXT;

-- DropTable
DROP TABLE "public"."BalanceProvider";

-- CreateTable
CREATE TABLE "public"."FinancialProvider" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "connectionType" "public"."FinancialConnectionType" NOT NULL DEFAULT 'DIRECT_CREDENTIAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FinancialConnection" (
    "id" TEXT NOT NULL,
    "venueId" TEXT,
    "providerId" TEXT NOT NULL,
    "mode" "public"."FinancialConnectionMode" NOT NULL DEFAULT 'SELF_CONNECT',
    "status" "public"."FinancialConnectionStatus" NOT NULL DEFAULT 'PENDING_DEVICE_VALIDATION',
    "grantEnc" TEXT,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "challengeEnc" TEXT,
    "challengeExpiresAt" TIMESTAMP(3),
    "deviceIdentifier" TEXT,
    "createdByStaffId" TEXT,
    "connectedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FinancialAccount" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "label" TEXT,
    "institution" TEXT,
    "clabe" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "active" BOOLEAN,
    "lastBalance" DECIMAL(18,2),
    "lastSyncedAt" TIMESTAMP(3),
    "balanceState" "public"."FinancialBalanceState" NOT NULL DEFAULT 'UNKNOWN',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialProvider_code_key" ON "public"."FinancialProvider"("code");

-- CreateIndex
CREATE INDEX "FinancialProvider_active_idx" ON "public"."FinancialProvider"("active");

-- CreateIndex
CREATE INDEX "FinancialConnection_venueId_idx" ON "public"."FinancialConnection"("venueId");

-- CreateIndex
CREATE INDEX "FinancialConnection_providerId_idx" ON "public"."FinancialConnection"("providerId");

-- CreateIndex
CREATE INDEX "FinancialConnection_status_idx" ON "public"."FinancialConnection"("status");

-- CreateIndex
CREATE INDEX "FinancialAccount_connectionId_idx" ON "public"."FinancialAccount"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialAccount_connectionId_externalId_key" ON "public"."FinancialAccount"("connectionId", "externalId");

-- AddForeignKey
ALTER TABLE "public"."MerchantAccount" ADD CONSTRAINT "MerchantAccount_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "public"."FinancialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FinancialConnection" ADD CONSTRAINT "FinancialConnection_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FinancialConnection" ADD CONSTRAINT "FinancialConnection_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "public"."FinancialProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FinancialAccount" ADD CONSTRAINT "FinancialAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."FinancialConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
