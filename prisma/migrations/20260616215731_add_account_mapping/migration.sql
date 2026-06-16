-- CreateEnum
CREATE TYPE "public"."AccountMovementType" AS ENUM ('SALES_REVENUE', 'SALES_RETURN', 'CASH_RECEIPT', 'BANK_RECEIPT', 'PETTY_CASH', 'TIPS_PAYABLE', 'ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE', 'INVENTORY', 'INVENTORY_ADJUSTMENT', 'COST_OF_GOODS_SOLD', 'PROCESSOR_FEE', 'ROUNDING_DIFFERENCE', 'NET_INCOME_PROFIT', 'NET_INCOME_LOSS', 'RETAINED_EARNINGS');

-- CreateTable
CREATE TABLE "public"."AccountMapping" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "movementType" "public"."AccountMovementType" NOT NULL,
    "ledgerAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountMapping_organizationId_rfc_idx" ON "public"."AccountMapping"("organizationId", "rfc");

-- CreateIndex
CREATE UNIQUE INDEX "AccountMapping_organizationId_rfc_movementType_key" ON "public"."AccountMapping"("organizationId", "rfc", "movementType");

-- AddForeignKey
ALTER TABLE "public"."AccountMapping" ADD CONSTRAINT "AccountMapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AccountMapping" ADD CONSTRAINT "AccountMapping_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "public"."LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
