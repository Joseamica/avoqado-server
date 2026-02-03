-- CreateTable
CREATE TABLE "public"."OrganizationPaymentConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "primaryAccountId" TEXT NOT NULL,
    "secondaryAccountId" TEXT,
    "tertiaryAccountId" TEXT,
    "routingRules" JSONB,
    "preferredProcessor" "public"."PaymentProcessor" NOT NULL DEFAULT 'AUTO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationPaymentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrganizationPricingStructure" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountType" "public"."AccountType" NOT NULL,
    "debitRate" DECIMAL(5,4) NOT NULL,
    "creditRate" DECIMAL(5,4) NOT NULL,
    "amexRate" DECIMAL(5,4) NOT NULL,
    "internationalRate" DECIMAL(5,4) NOT NULL,
    "fixedFeePerTransaction" DECIMAL(8,4),
    "monthlyServiceFee" DECIMAL(10,2),
    "minimumMonthlyVolume" DECIMAL(12,2),
    "volumePenalty" DECIMAL(10,2),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "contractReference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationPricingStructure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationPaymentConfig_organizationId_key" ON "public"."OrganizationPaymentConfig"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationPaymentConfig_primaryAccountId_idx" ON "public"."OrganizationPaymentConfig"("primaryAccountId");

-- CreateIndex
CREATE INDEX "OrganizationPaymentConfig_secondaryAccountId_idx" ON "public"."OrganizationPaymentConfig"("secondaryAccountId");

-- CreateIndex
CREATE INDEX "OrganizationPaymentConfig_tertiaryAccountId_idx" ON "public"."OrganizationPaymentConfig"("tertiaryAccountId");

-- CreateIndex
CREATE INDEX "OrganizationPricingStructure_organizationId_idx" ON "public"."OrganizationPricingStructure"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationPricingStructure_accountType_idx" ON "public"."OrganizationPricingStructure"("accountType");

-- CreateIndex
CREATE INDEX "OrganizationPricingStructure_effectiveFrom_idx" ON "public"."OrganizationPricingStructure"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationPricingStructure_organizationId_accountType_eff_key" ON "public"."OrganizationPricingStructure"("organizationId", "accountType", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "public"."OrganizationPaymentConfig" ADD CONSTRAINT "OrganizationPaymentConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationPaymentConfig" ADD CONSTRAINT "OrganizationPaymentConfig_primaryAccountId_fkey" FOREIGN KEY ("primaryAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationPaymentConfig" ADD CONSTRAINT "OrganizationPaymentConfig_secondaryAccountId_fkey" FOREIGN KEY ("secondaryAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationPaymentConfig" ADD CONSTRAINT "OrganizationPaymentConfig_tertiaryAccountId_fkey" FOREIGN KEY ("tertiaryAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationPricingStructure" ADD CONSTRAINT "OrganizationPricingStructure_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
