-- CreateEnum
CREATE TYPE "ServicePayTableKind" AS ENUM ('TOTAL_BY_COUNT');

-- CreateEnum
CREATE TYPE "ServicePayCountMode" AS ENUM ('BOOKED', 'ATTENDED');

-- CreateEnum
CREATE TYPE "ServicePayPeriodicity" AS ENUM ('MONTHLY', 'SEMIMONTHLY');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "servicePayPeriodicity" "ServicePayPeriodicity" NOT NULL DEFAULT 'MONTHLY';

-- CreateTable
CREATE TABLE "StaffPayLevel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffPayLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPayLevelAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "payLevelId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "revision" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPayLevelAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePayTable" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedFrom" DATE,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServicePayTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePayTableVersion" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" "ServicePayTableKind" NOT NULL DEFAULT 'TOTAL_BY_COUNT',
    "countMode" "ServicePayCountMode" NOT NULL DEFAULT 'BOOKED',
    "maxCount" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServicePayTableVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePayTableCell" (
    "versionId" TEXT NOT NULL,
    "payLevelId" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "ServicePayTableCell_pkey" PRIMARY KEY ("versionId","payLevelId","count")
);

-- CreateTable
CREATE TABLE "ClassSessionPayState" (
    "classSessionId" TEXT NOT NULL,
    "payCountOverride" INTEGER,
    "payAmountOverride" DECIMAL(12,2),
    "payExcluded" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "overrideById" TEXT,
    "overrideAt" TIMESTAMP(3),
    "originPeriodId" TEXT,
    "valuationDate" DATE,
    "valuationVersionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassSessionPayState_pkey" PRIMARY KEY ("classSessionId")
);

-- CreateIndex
CREATE INDEX "StaffPayLevel_organizationId_sortOrder_idx" ON "StaffPayLevel"("organizationId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPayLevel_organizationId_name_key" ON "StaffPayLevel"("organizationId", "name");

-- CreateIndex
CREATE INDEX "StaffPayLevelAssignment_organizationId_staffId_effectiveFro_idx" ON "StaffPayLevelAssignment"("organizationId", "staffId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPayLevelAssignment_organizationId_staffId_effectiveFro_key" ON "StaffPayLevelAssignment"("organizationId", "staffId", "effectiveFrom", "revision");

-- CreateIndex
CREATE INDEX "ServicePayTable_venueId_idx" ON "ServicePayTable"("venueId");

-- CreateIndex
CREATE INDEX "ServicePayTableVersion_tableId_effectiveFrom_idx" ON "ServicePayTableVersion"("tableId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePayTableVersion_tableId_effectiveFrom_revision_key" ON "ServicePayTableVersion"("tableId", "effectiveFrom", "revision");

-- CreateIndex
CREATE INDEX "ClassSessionPayState_originPeriodId_idx" ON "ClassSessionPayState"("originPeriodId");

-- AddForeignKey
ALTER TABLE "StaffPayLevel" ADD CONSTRAINT "StaffPayLevel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPayLevelAssignment" ADD CONSTRAINT "StaffPayLevelAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPayLevelAssignment" ADD CONSTRAINT "StaffPayLevelAssignment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPayLevelAssignment" ADD CONSTRAINT "StaffPayLevelAssignment_payLevelId_fkey" FOREIGN KEY ("payLevelId") REFERENCES "StaffPayLevel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePayTable" ADD CONSTRAINT "ServicePayTable_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePayTableVersion" ADD CONSTRAINT "ServicePayTableVersion_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "ServicePayTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePayTableCell" ADD CONSTRAINT "ServicePayTableCell_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "ServicePayTableVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePayTableCell" ADD CONSTRAINT "ServicePayTableCell_payLevelId_fkey" FOREIGN KEY ("payLevelId") REFERENCES "StaffPayLevel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSessionPayState" ADD CONSTRAINT "ClassSessionPayState_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Invariantes de dinero y conteo (spec §5.3)
ALTER TABLE "ServicePayTableVersion" ADD CONSTRAINT "ServicePayTableVersion_maxCount_rango" CHECK ("maxCount" BETWEEN 0 AND 500);
ALTER TABLE "ServicePayTableVersion" ADD CONSTRAINT "ServicePayTableVersion_revision_positiva" CHECK ("revision" >= 1);
ALTER TABLE "StaffPayLevelAssignment" ADD CONSTRAINT "StaffPayLevelAssignment_revision_positiva" CHECK ("revision" >= 1);
ALTER TABLE "ServicePayTableCell" ADD CONSTRAINT "ServicePayTableCell_count_no_negativo" CHECK ("count" >= 0);
ALTER TABLE "ServicePayTableCell" ADD CONSTRAINT "ServicePayTableCell_amount_no_negativo" CHECK ("amount" >= 0);
ALTER TABLE "ClassSessionPayState" ADD CONSTRAINT "ClassSessionPayState_conteo_no_negativo" CHECK ("payCountOverride" IS NULL OR "payCountOverride" >= 0);
ALTER TABLE "ClassSessionPayState" ADD CONSTRAINT "ClassSessionPayState_monto_no_negativo" CHECK ("payAmountOverride" IS NULL OR "payAmountOverride" >= 0);

-- Módulo SERVICE_PAY (apagado por default: sin VenueModule no hay acceso)
INSERT INTO "Module" ("id", "code", "name", "description", "defaultConfig", "active", "createdAt", "updatedAt")
VALUES ('cmsvcpay0000modulefase1', 'SERVICE_PAY', 'Pago por servicio',
        'Calcula el pago del staff por clase según una tabla por nivel y sede.', '{}'::jsonb, true, NOW(), NOW())
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "description" = EXCLUDED."description", "updatedAt" = NOW();
