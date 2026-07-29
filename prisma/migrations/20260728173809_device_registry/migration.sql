-- Device registry (2026-07-28): registro pasivo de dispositivos, estilo Square.
--
-- Todo es ADITIVO y nullable. Ninguna columna se quita ni se renombra: apps viejas
-- siguen funcionando idénticas. El @@unique([venueId, deviceUid]) no puede colisionar
-- al aplicarse porque deviceUid nace NULL en todas las filas existentes y PostgreSQL
-- trata los NULL como distintos entre sí en un índice único.
--
-- deviceUid NO es un identificador nuevo: es el MISMO deviceId que las apps ya usan
-- para el outbox offline (PosSyncIntent.deviceId) y la elección de árbitro del hub LAN.
-- Ver .claude/rules/offline-first-y-hub-lan.md §2.4.

-- CreateEnum
CREATE TYPE "DeviceFormFactor" AS ENUM ('PHONE', 'TABLET', 'HANDHELD_POS', 'COUNTERTOP_POS', 'DESKTOP', 'UNKNOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TerminalType" ADD VALUE 'POS_ANDROID';
ALTER TYPE "TerminalType" ADD VALUE 'POS_IOS';
ALTER TYPE "TerminalType" ADD VALUE 'POS_DESKTOP';

-- AlterTable
ALTER TABLE "Terminal" ADD COLUMN     "deviceUid" TEXT,
ADD COLUMN     "firstSeenAt" TIMESTAMP(3),
ADD COLUMN     "formFactor" "DeviceFormFactor",
ADD COLUMN     "lastStaffId" TEXT,
ADD COLUMN     "modelIdentifier" TEXT,
ADD COLUMN     "osVersion" TEXT,
ADD COLUMN     "selfRegistered" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Terminal_venueId_selfRegistered_idx" ON "Terminal"("venueId", "selfRegistered");

-- CreateIndex
CREATE INDEX "Terminal_venueId_formFactor_idx" ON "Terminal"("venueId", "formFactor");

-- CreateIndex
CREATE UNIQUE INDEX "Terminal_venueId_deviceUid_key" ON "Terminal"("venueId", "deviceUid");

