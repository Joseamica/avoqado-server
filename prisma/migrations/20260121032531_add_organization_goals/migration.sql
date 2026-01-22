-- CreateTable
CREATE TABLE "public"."OrganizationGoal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'daily',
    "periodDate" TIMESTAMP(3) NOT NULL,
    "salesTarget" DECIMAL(12,2) NOT NULL,
    "volumeTarget" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationGoal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationGoal_organizationId_idx" ON "public"."OrganizationGoal"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationGoal_periodDate_idx" ON "public"."OrganizationGoal"("periodDate");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationGoal_organizationId_period_periodDate_key" ON "public"."OrganizationGoal"("organizationId", "period", "periodDate");

-- AddForeignKey
ALTER TABLE "public"."OrganizationGoal" ADD CONSTRAINT "OrganizationGoal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
