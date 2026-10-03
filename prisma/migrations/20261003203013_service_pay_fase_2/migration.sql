-- CreateEnum
CREATE TYPE "ServicePayPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ServiceEarningConcept" AS ENUM ('SERVICE', 'RECONCILE', 'MANUAL');

-- CreateEnum
CREATE TYPE "ServiceEarningSource" AS ENUM ('CLASS_SESSION');

-- CreateTable
CREATE TABLE "ServicePayPeriod" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "ServicePayPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "venueIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closeFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServicePayPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceEarning" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "concept" "ServiceEarningConcept" NOT NULL,
    "sourceType" "ServiceEarningSource",
    "sourceId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "payLevelId" TEXT,
    "payLevelName" TEXT,
    "tableVersionId" TEXT,
    "countMode" "ServicePayCountMode",
    "count" INTEGER,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT,
    "descriptor" JSONB NOT NULL,
    "clientKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceEarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPayStatement" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paidNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPayStatement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServicePayPeriod_organizationId_periodEnd_idx" ON "ServicePayPeriod"("organizationId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePayPeriod_organizationId_periodStart_key" ON "ServicePayPeriod"("organizationId", "periodStart");

-- CreateIndex
CREATE INDEX "ServiceEarning_periodId_staffId_idx" ON "ServiceEarning"("periodId", "staffId");

-- CreateIndex
CREATE INDEX "ServiceEarning_sourceType_sourceId_staffId_idx" ON "ServiceEarning"("sourceType", "sourceId", "staffId");

-- CreateIndex
CREATE INDEX "ServiceEarning_organizationId_staffId_idx" ON "ServiceEarning"("organizationId", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPayStatement_periodId_staffId_key" ON "StaffPayStatement"("periodId", "staffId");

-- AddForeignKey
ALTER TABLE "ClassSessionPayState" ADD CONSTRAINT "ClassSessionPayState_originPeriodId_fkey" FOREIGN KEY ("originPeriodId") REFERENCES "ServicePayPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSessionPayState" ADD CONSTRAINT "ClassSessionPayState_valuationVersionId_fkey" FOREIGN KEY ("valuationVersionId") REFERENCES "ServicePayTableVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePayPeriod" ADD CONSTRAINT "ServicePayPeriod_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceEarning" ADD CONSTRAINT "ServiceEarning_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ServicePayPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPayStatement" ADD CONSTRAINT "StaffPayStatement_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ServicePayPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Candado contra pagar doble (spec §5.6): la versión de tabla va en la foto, NO en la llave.
CREATE UNIQUE INDEX "ServiceEarning_service_unico" ON "ServiceEarning"("sourceType", "sourceId", "staffId")
  WHERE "concept" = 'SERVICE';
-- Idempotencia de las operaciones que insertan varias filas (spec §5.6).
CREATE UNIQUE INDEX "ServiceEarning_clientKey_unico" ON "ServiceEarning"("clientKey") WHERE "clientKey" IS NOT NULL;

-- MANUAL nunca inventa una clase; SERVICE y RECONCILE siempre traen las DOS mitades de la fuente (Codex R1-11:
-- con una igualdad, SERVICE + CLASS_SESSION + sourceId NULL pasaba).
ALTER TABLE "ServiceEarning" ADD CONSTRAINT "ServiceEarning_fuente_por_concepto"
  CHECK (
    ("concept" = 'MANUAL' AND "sourceType" IS NULL AND "sourceId" IS NULL)
    OR ("concept" <> 'MANUAL' AND "sourceType" IS NOT NULL AND "sourceId" IS NOT NULL)
  );
-- Un SERVICE es un pago de tabla o un monto ajustado: nunca negativo. RECONCILE y MANUAL sí pueden serlo.
ALTER TABLE "ServiceEarning" ADD CONSTRAINT "ServiceEarning_service_no_negativo"
  CHECK ("concept" <> 'SERVICE' OR "amount" >= 0);
ALTER TABLE "ServicePayPeriod" ADD CONSTRAINT "ServicePayPeriod_rango" CHECK ("periodEnd" >= "periodStart");
-- Un periodo cerrado siempre sabe quién y cuándo.
ALTER TABLE "ServicePayPeriod" ADD CONSTRAINT "ServicePayPeriod_cierre_completo"
  CHECK ("status" = 'OPEN' OR ("closedAt" IS NOT NULL AND "closeFingerprint" IS NOT NULL));
