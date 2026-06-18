-- CreateEnum
CREATE TYPE "public"."PayrollPeriodicity" AS ENUM ('SEMANAL', 'QUINCENAL', 'MENSUAL');

-- CreateEnum
CREATE TYPE "public"."PayrollRunStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateTable
CREATE TABLE "public"."Employee" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "venueId" TEXT,
    "nombre" TEXT NOT NULL,
    "rfcEmpleado" TEXT NOT NULL,
    "curp" TEXT,
    "nss" TEXT,
    "puesto" TEXT,
    "salarioMensualBrutoCents" INTEGER NOT NULL,
    "sbcMensualCents" INTEGER,
    "periodicidadPago" "public"."PayrollPeriodicity" NOT NULL DEFAULT 'MENSUAL',
    "fechaIngreso" TIMESTAMP(3),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PayrollRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "venueId" TEXT,
    "period" TEXT NOT NULL,
    "periodicidad" "public"."PayrollPeriodicity" NOT NULL DEFAULT 'MENSUAL',
    "fechaPago" TIMESTAMP(3) NOT NULL,
    "status" "public"."PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "empleados" INTEGER NOT NULL DEFAULT 0,
    "totalPercepcionesCents" INTEGER NOT NULL DEFAULT 0,
    "totalIsrCents" INTEGER NOT NULL DEFAULT 0,
    "totalSubsidioCents" INTEGER NOT NULL DEFAULT 0,
    "totalImssObreroCents" INTEGER NOT NULL DEFAULT 0,
    "totalOtrasDeduccCents" INTEGER NOT NULL DEFAULT 0,
    "totalNetoCents" INTEGER NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PayrollLine" (
    "id" TEXT NOT NULL,
    "payrollRunId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "rfcEmpleado" TEXT NOT NULL,
    "diasPagados" INTEGER NOT NULL DEFAULT 30,
    "percepcionGravadaCents" INTEGER NOT NULL DEFAULT 0,
    "percepcionExentaCents" INTEGER NOT NULL DEFAULT 0,
    "totalPercepcionesCents" INTEGER NOT NULL DEFAULT 0,
    "isrCents" INTEGER NOT NULL DEFAULT 0,
    "subsidioCents" INTEGER NOT NULL DEFAULT 0,
    "imssObreroCents" INTEGER NOT NULL DEFAULT 0,
    "otrasDeduccionesCents" INTEGER NOT NULL DEFAULT 0,
    "netoCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Employee_organizationId_rfc_idx" ON "public"."Employee"("organizationId", "rfc");

-- CreateIndex
CREATE INDEX "Employee_venueId_idx" ON "public"."Employee"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_organizationId_rfc_rfcEmpleado_key" ON "public"."Employee"("organizationId", "rfc", "rfcEmpleado");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_journalEntryId_key" ON "public"."PayrollRun"("journalEntryId");

-- CreateIndex
CREATE INDEX "PayrollRun_organizationId_rfc_period_idx" ON "public"."PayrollRun"("organizationId", "rfc", "period");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_organizationId_rfc_period_periodicidad_key" ON "public"."PayrollRun"("organizationId", "rfc", "period", "periodicidad");

-- CreateIndex
CREATE INDEX "PayrollLine_payrollRunId_idx" ON "public"."PayrollLine"("payrollRunId");

-- CreateIndex
CREATE INDEX "PayrollLine_employeeId_idx" ON "public"."PayrollLine"("employeeId");

