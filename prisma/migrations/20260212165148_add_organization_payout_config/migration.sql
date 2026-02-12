-- CreateTable
CREATE TABLE "public"."OrganizationPayoutConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "aggregationPeriod" TEXT NOT NULL DEFAULT 'MONTHLY',
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "paymentMethods" TEXT[] DEFAULT ARRAY['CASH', 'BANK_TRANSFER']::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationPayoutConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationPayoutConfig_organizationId_key" ON "public"."OrganizationPayoutConfig"("organizationId");

-- AddForeignKey
ALTER TABLE "public"."OrganizationPayoutConfig" ADD CONSTRAINT "OrganizationPayoutConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
