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

-- CreateIndex
CREATE UNIQUE INDEX "time_entries_staffId_llaveEntrada_key" ON "time_entries"("staffId", "llaveEntrada");

-- CreateIndex
CREATE UNIQUE INDEX "time_entries_staffId_llaveSalida_key" ON "time_entries"("staffId", "llaveSalida");

