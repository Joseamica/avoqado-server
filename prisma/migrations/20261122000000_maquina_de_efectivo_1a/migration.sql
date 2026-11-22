-- Máquina de efectivo (QuickPay Mini), fase 1a: plan docs/superpowers/plans/2026-11-20-maquina-de-efectivo-fase-1a.md.
-- UNA migración con el esquema final de la 1a (ronda 4 de Codex sobre el código, F1/F2): nada de la 1a salió de su rama, así que las
-- intermedias (columna cartHash, rediseño r3) se aplastaron aquí. Sólo tablas y columnas nuevas; nada se quita ni se renombra.
-- Los índices de Payment y de CashMachineClose.occurredAt van CONCURRENTLY, cada uno en su migración (20261122000001 y 20261122000003):
-- Payment recibe escrituras en cada cobro y Prisma manda el archivo como un lote (CONCURRENTLY no cabe en una transacción implícita).
-- La columna `Payment.cashMachineRef` va SOLA en 20261121235959_payment_cash_machine_ref (revisión de apps viejas antes de publicar,
-- 22-nov): aquí las FK piden candados de Venue y Terminal, y en el mismo lote Payment quedaba con su candado exclusivo mientras esperaba.

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
    "saleCents" INTEGER,
    "tipCents" INTEGER,
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
    "cartHash" VARCHAR(64),
    "motivoSinRegistro" VARCHAR(24),

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

-- CreateTable
CREATE TABLE "CashMachineFolio" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "referenceCC" VARCHAR(32) NOT NULL,
    "deviceId" TEXT,
    "bindingId" TEXT,
    "pedido" JSONB,
    "cartHash" VARCHAR(64),
    "saleShiftId" TEXT,
    "dueCents" DOUBLE PRECISION NOT NULL,
    "saleCents" DOUBLE PRECISION,
    "tipCents" DOUBLE PRECISION,
    "decision" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "maxCreditCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashMachineFolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMachineObservation" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "referenceCC" VARCHAR(32) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMachineObservation_pkey" PRIMARY KEY ("id")
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

-- CreateIndex
CREATE UNIQUE INDEX "CashMachineFolio_venueId_referenceCC_key" ON "CashMachineFolio"("venueId", "referenceCC");

-- CreateIndex
CREATE UNIQUE INDEX "CashMachineObservation_venueId_referenceCC_fingerprint_key" ON "CashMachineObservation"("venueId", "referenceCC", "fingerprint");

-- AddForeignKey
ALTER TABLE "CashMachineClose" ADD CONSTRAINT "CashMachineClose_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMachineIncident" ADD CONSTRAINT "CashMachineIncident_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMachineBinding" ADD CONSTRAINT "CashMachineBinding_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMachineBinding" ADD CONSTRAINT "CashMachineBinding_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMachineFolio" ADD CONSTRAINT "CashMachineFolio_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMachineObservation" ADD CONSTRAINT "CashMachineObservation_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rediseño r3 (D3, r6-5): UNA sola PC habilitada por negocio. Índice PARCIAL que Prisma no puede expresar (comentado en el modelo
-- CashMachineBinding de schema.prisma). La tabla nace vacía en esta misma migración: no hay filas viejas que lo choquen (F2).
CREATE UNIQUE INDEX "CashMachineBinding_venueId_activa_key" ON "CashMachineBinding"("venueId") WHERE "active";
