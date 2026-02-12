-- CreateTable
CREATE TABLE "public"."OrganizationSalesGoalConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "goal" DECIMAL(12,2) NOT NULL,
    "goalType" TEXT NOT NULL DEFAULT 'AMOUNT',
    "period" TEXT NOT NULL DEFAULT 'MONTHLY',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationSalesGoalConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationSalesGoalConfig_organizationId_idx" ON "public"."OrganizationSalesGoalConfig"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSalesGoalConfig_organizationId_period_goalType_key" ON "public"."OrganizationSalesGoalConfig"("organizationId", "period", "goalType");

-- AddForeignKey
ALTER TABLE "public"."OrganizationSalesGoalConfig" ADD CONSTRAINT "OrganizationSalesGoalConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
