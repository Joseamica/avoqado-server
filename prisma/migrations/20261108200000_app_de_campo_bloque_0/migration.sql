-- App de campo, bloque 0 (plan 2026-11-08-app-de-campo-bloque-0-tuberia): la ficha de la venta del celular y las columnas de
-- la checada del celular. Sólo agrega: dos enums, una tabla nueva (vacía, con sus índices) y 7 columnas NULLABLE sin default en
-- "time_entries" (sólo catálogo, sin reescribir la tabla). Ninguna fila existente se mueve.
-- `lock_timeout`: el ALTER de "time_entries" pide su candado exclusivo un instante; si una transacción larga lo tiene, esta
-- migración falla a los 5 s en vez de formar en fila detrás de ella a las checadas de las terminales y los POS.
-- Los dos únicos de las llaves de "time_entries" van aparte, CONCURRENTLY, en 20261108200100 y 20261108200200 (Codex C4): un
-- CREATE UNIQUE INDEX normal bloquearía las escrituras de checadas de todas las apps mientras se construye.
--
-- Reversión (no se ejecuta):
--   DROP INDEX CONCURRENTLY IF EXISTS "time_entries_staffId_llaveSalida_key";
--   DROP INDEX CONCURRENTLY IF EXISTS "time_entries_staffId_llaveEntrada_key";
--   ALTER TABLE "time_entries" DROP COLUMN "clockInOrigenHora", DROP COLUMN "clockInUbicacionFalsa", DROP COLUMN "clockOutOrigenHora",
--     DROP COLUMN "clockOutRecibidaAt", DROP COLUMN "clockOutUbicacionFalsa", DROP COLUMN "llaveEntrada", DROP COLUMN "llaveSalida";
--   DROP TABLE "ventas_de_campo";
--   DROP TYPE "EstadoVentaDeCampo", "OrigenDeLaHora";

BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "OrigenDeLaHora" AS ENUM ('SERVIDOR', 'RELOJ_ANCLADO', 'RELOJ_DEL_CELULAR');

-- CreateEnum
CREATE TYPE "EstadoVentaDeCampo" AS ENUM ('EN_CURSO', 'COMPLETA');

-- AlterTable
ALTER TABLE "time_entries" ADD COLUMN     "clockInOrigenHora" "OrigenDeLaHora",
ADD COLUMN     "clockInUbicacionFalsa" BOOLEAN,
ADD COLUMN     "clockOutOrigenHora" "OrigenDeLaHora",
ADD COLUMN     "clockOutRecibidaAt" TIMESTAMP(3),
ADD COLUMN     "clockOutUbicacionFalsa" BOOLEAN,
ADD COLUMN     "llaveEntrada" TEXT,
ADD COLUMN     "llaveSalida" TEXT;

-- CreateTable
CREATE TABLE "ventas_de_campo" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "llave" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "serializedItemId" TEXT,
    "precio" DECIMAL(10,2) NOT NULL,
    "ocurrioAt" TIMESTAMP(3) NOT NULL,
    "origenHora" "OrigenDeLaHora" NOT NULL,
    "estado" "EstadoVentaDeCampo" NOT NULL DEFAULT 'EN_CURSO',
    "orderId" TEXT,
    "paymentId" TEXT,
    "saleVerificationId" TEXT,
    "ocupacion" TEXT,
    "ocupadaHasta" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ventas_de_campo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ventas_de_campo_serializedItemId_key" ON "ventas_de_campo"("serializedItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ventas_de_campo_orderId_key" ON "ventas_de_campo"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ventas_de_campo_paymentId_key" ON "ventas_de_campo"("paymentId");

-- CreateIndex
CREATE INDEX "ventas_de_campo_staffId_createdAt_idx" ON "ventas_de_campo"("staffId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ventas_de_campo_venueId_llave_key" ON "ventas_de_campo"("venueId", "llave");

COMMIT;
