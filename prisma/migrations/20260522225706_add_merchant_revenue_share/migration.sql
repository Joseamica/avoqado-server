-- CreateTable
CREATE TABLE "public"."MerchantRevenueShare" (
    "id" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "aggregatorPrice" JSONB,
    "aggregatorPriceIncludesTax" BOOLEAN NOT NULL DEFAULT false,
    "avoqadoShareOfProviderMargin" DECIMAL(5,4) NOT NULL DEFAULT 0.50,
    "avoqadoShareOfAggregatorMargin" DECIMAL(5,4),
    "taxRate" DECIMAL(5,4) NOT NULL DEFAULT 0.16,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantRevenueShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantRevenueShare_merchantAccountId_key" ON "public"."MerchantRevenueShare"("merchantAccountId");

-- CreateIndex
CREATE INDEX "MerchantRevenueShare_active_idx" ON "public"."MerchantRevenueShare"("active");

-- AddForeignKey
ALTER TABLE "public"."MerchantRevenueShare" ADD CONSTRAINT "MerchantRevenueShare_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
