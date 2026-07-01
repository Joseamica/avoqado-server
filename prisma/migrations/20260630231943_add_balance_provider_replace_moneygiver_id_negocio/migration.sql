-- Generalize the Moneygiver-only balance lookup into a provider-agnostic
-- catalog: a merchant can have ANY banking/fintech provider integrated, not
-- just Moneygiver. Confirmed zero rows had moneygiverIdNegocio set, so this
-- is a clean swap (no data migration needed).

-- AlterTable
ALTER TABLE "public"."MerchantAccount" DROP COLUMN "moneygiverIdNegocio",
ADD COLUMN     "balanceProviderAccountId" TEXT,
ADD COLUMN     "balanceProviderId" TEXT;

-- CreateTable
CREATE TABLE "public"."BalanceProvider" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BalanceProvider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BalanceProvider_code_key" ON "public"."BalanceProvider"("code");

-- CreateIndex
CREATE INDEX "BalanceProvider_active_idx" ON "public"."BalanceProvider"("active");

-- AddForeignKey
ALTER TABLE "public"."MerchantAccount" ADD CONSTRAINT "MerchantAccount_balanceProviderId_fkey" FOREIGN KEY ("balanceProviderId") REFERENCES "public"."BalanceProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
