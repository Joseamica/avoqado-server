-- Máquina de efectivo (QuickPay Mini), fase 1a · rediseño tras la ronda 3 de Codex sobre el código (plan
-- docs/superpowers/plans/2026-11-20-maquina-de-efectivo-fase-1a.md, D1–D3 y los ajustes de codex-r6.md 1, 3, 5 y 6).
-- Sólo tablas y columnas nuevas, opcionales; las tablas de la máquina nacieron en esta misma rama (20261120120000) y ningún cliente
-- publicado las lee. Las tablas son nuevas y vacías: los índices normales no frenan escrituras de nadie.

-- D1: un PAGADO comprobado que no pudo ser venta guarda su cierre físico con el motivo (el MCP «con deuda» lo encuentra una vez).
ALTER TABLE "CashMachineClose" ADD COLUMN     "motivoSinRegistro" VARCHAR(24);

-- D2 / r6-1: lo que el primer mensaje del folio congela (carrito completo, turno, reparto, dueño y emparejamiento) y su desenlace.
CREATE TABLE "CashMachineFolio" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "referenceCC" VARCHAR(32) NOT NULL,
    "deviceId" TEXT,
    "bindingId" TEXT,
    "pedido" JSONB,
    "cartHash" VARCHAR(64),
    "saleShiftId" TEXT,
    "dueCents" INTEGER NOT NULL,
    "saleCents" INTEGER NOT NULL,
    "tipCents" INTEGER NOT NULL,
    "decision" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashMachineFolio_pkey" PRIMARY KEY ("id")
);

-- r6-3: una fila por observación física distinta; la huella única compara contra TODO el historial del folio.
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
CREATE UNIQUE INDEX "CashMachineFolio_venueId_referenceCC_key" ON "CashMachineFolio"("venueId", "referenceCC");

-- CreateIndex
CREATE UNIQUE INDEX "CashMachineObservation_venueId_referenceCC_fingerprint_key" ON "CashMachineObservation"("venueId", "referenceCC", "fingerprint");

-- AddForeignKey
ALTER TABLE "CashMachineFolio" ADD CONSTRAINT "CashMachineFolio_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMachineObservation" ADD CONSTRAINT "CashMachineObservation_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- D3 / r6-5: UNA sola PC habilitada por negocio (antes, una por IP de máquina). Índice PARCIAL que Prisma no puede expresar
-- (comentado en el modelo CashMachineBinding). Si hubiera dos activas en un negocio, el CREATE falla y la migración no se aplica a
-- medias: la tabla nació en esta rama y en producción no existe.
DROP INDEX "CashMachineBinding_venueId_machineIp_activa_key";
CREATE UNIQUE INDEX "CashMachineBinding_venueId_activa_key" ON "CashMachineBinding"("venueId") WHERE "active";
