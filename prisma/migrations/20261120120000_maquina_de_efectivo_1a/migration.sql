-- Máquina de efectivo (QuickPay Mini), fase 1a: plan docs/superpowers/plans/2026-11-20-maquina-de-efectivo-fase-1a.md (Task A1).
-- Sólo tablas y columnas nuevas; nada se quita ni se renombra. El índice de Payment va CONCURRENTLY en la migración siguiente
-- (20261120120001): Payment recibe escrituras en cada cobro y un CREATE INDEX normal las frenaría mientras se construye.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "cashMachineRef" VARCHAR(32);

-- CreateTable
CREATE TABLE "CashMachineClose" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "referenceCC" VARCHAR(32) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "resolvedBy" VARCHAR(16) NOT NULL,
    "resolvedByStaffId" TEXT,
    "evidence" TEXT,
    "dueCents" INTEGER NOT NULL,
    "saleCents" INTEGER NOT NULL,
    "tipCents" INTEGER NOT NULL,
    "creditCents" INTEGER NOT NULL,
    "changeDispensedCents" INTEGER NOT NULL,
    "appliedCents" INTEGER NOT NULL,
    "excedenteCents" INTEGER NOT NULL DEFAULT 0,
    "owedCents" INTEGER NOT NULL,
    "owedKind" VARCHAR(16),
    "orderId" TEXT,
    "paymentId" TEXT,
    "saleShiftId" TEXT,
    "shiftStatus" VARCHAR(24),
    "deviceId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "occurredAtKnown" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "CashMachineClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMachineIncident" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "referenceCC" VARCHAR(32) NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ABIERTO',
    "payload" JSONB NOT NULL,
    "deviceId" TEXT,
    "resolvedByStaffId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "CashMachineIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMachineBinding" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "machineIp" VARCHAR(64) NOT NULL,
    "credentialHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "enabledByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

CONSTRAINT "CashMachineBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashMachineClose_venueId_createdAt_idx" ON "CashMachineClose"("venueId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CashMachineClose_venueId_referenceCC_key" ON "CashMachineClose"("venueId", "referenceCC");

-- CreateIndex
CREATE INDEX "CashMachineIncident_venueId_status_createdAt_idx" ON "CashMachineIncident"("venueId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CashMachineIncident_venueId_referenceCC_kind_key" ON "CashMachineIncident"("venueId", "referenceCC", "kind");

-- CreateIndex
CREATE INDEX "CashMachineBinding_venueId_deviceId_idx" ON "CashMachineBinding"("venueId", "deviceId");

-- AddForeignKey
ALTER TABLE "CashMachineClose" ADD CONSTRAINT "CashMachineClose_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMachineIncident" ADD CONSTRAINT "CashMachineIncident_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMachineBinding" ADD CONSTRAINT "CashMachineBinding_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMachineBinding" ADD CONSTRAINT "CashMachineBinding_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Una sola PC activa por máquina (venueId + IP): habilitar otra PC revoca la anterior en la misma transacción.
-- Índice PARCIAL que Prisma no puede expresar (comentado en el modelo CashMachineBinding de schema.prisma).
CREATE UNIQUE INDEX "CashMachineBinding_venueId_machineIp_activa_key" ON "CashMachineBinding"("venueId", "machineIp") WHERE "active";
