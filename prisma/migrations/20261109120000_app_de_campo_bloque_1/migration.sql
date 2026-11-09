-- App de campo, bloque 1 (plan 2026-11-09-app-de-campo-bloque-1-entrada-por-persona): el celular de la persona, su código de
-- activación y lo que un celular desvinculado subió y espera revisión. Sólo agrega tres tablas nuevas (vacías) con sus índices:
-- ningún enum, ningún ALTER de una tabla existente, ninguna fila se mueve. Las tablas nacen vacías, así que sus índices se
-- crean al instante y no bloquean a nadie.
--
-- Reversión (no se ejecuta):
--   DROP TABLE "envios_retenidos_de_campo"; DROP TABLE "codigos_de_celular"; DROP TABLE "celulares_de_campo";

-- CreateTable
CREATE TABLE "celulares_de_campo" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "staffIdVinculado" TEXT,
    "credencialHash" TEXT NOT NULL,
    "sesionId" TEXT,
    "pinSal" TEXT NOT NULL,
    "aparatoId" TEXT NOT NULL,
    "marca" TEXT,
    "modelo" TEXT,
    "versionAndroid" TEXT,
    "versionApp" TEXT,
    "codigoId" TEXT,
    "vistoAt" TIMESTAMP(3),
    "porSubir" INTEGER NOT NULL DEFAULT 0,
    "porSubirDetalle" JSONB,
    "huellasPorSubir" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "huellasReportadasAt" TIMESTAMP(3),
    "pinFallos" INTEGER NOT NULL DEFAULT 0,
    "pinBloqueadoHasta" TIMESTAMP(3),
    "desvinculadoAt" TIMESTAMP(3),
    "desvinculadoPor" TEXT,
    "motivoDesvinculo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "celulares_de_campo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codigos_de_celular" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "expiraAt" TIMESTAMP(3) NOT NULL,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "generadoPor" TEXT NOT NULL,
    "usadoAt" TIMESTAMP(3),
    "usadoPorAparatoId" TEXT,
    "anuladoAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codigos_de_celular_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "envios_retenidos_de_campo" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "celularId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "huella" TEXT NOT NULL,
    "cuerpoJson" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "rechazo" JSONB,
    "enProcesoHasta" TIMESTAMP(3),
    "resueltoAt" TIMESTAMP(3),
    "resueltoPor" TEXT,
    "resolucion" TEXT,
    "nota" TEXT,
    "resultado" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "envios_retenidos_de_campo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "celulares_de_campo_staffIdVinculado_key" ON "celulares_de_campo"("staffIdVinculado");

-- CreateIndex
CREATE UNIQUE INDEX "celulares_de_campo_credencialHash_key" ON "celulares_de_campo"("credencialHash");

-- CreateIndex
CREATE UNIQUE INDEX "celulares_de_campo_sesionId_key" ON "celulares_de_campo"("sesionId");

-- CreateIndex
CREATE INDEX "celulares_de_campo_organizationId_staffId_idx" ON "celulares_de_campo"("organizationId", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "codigos_de_celular_codigo_key" ON "codigos_de_celular"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "codigos_de_celular_organizationId_staffId_key" ON "codigos_de_celular"("organizationId", "staffId");

-- CreateIndex
CREATE INDEX "envios_retenidos_de_campo_organizationId_resueltoAt_created_idx" ON "envios_retenidos_de_campo"("organizationId", "resueltoAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "envios_retenidos_de_campo_celularId_huella_key" ON "envios_retenidos_de_campo"("celularId", "huella");

