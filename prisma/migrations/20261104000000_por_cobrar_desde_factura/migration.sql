-- «Por cobrar» desde una factura, con o sin factura y de una sola vez (spec 2026-11-03-por-cobrar-desde-factura-y-filtros, «Modelo»).
-- Migración ADITIVA: dos valores nuevos de enum y una columna opcional. No toca ninguna fila.
-- Comprobada contra `prisma migrate diff` entre el schema anterior y el nuevo (sin base): sale exactamente esto.
-- Un valor nuevo de un enum no se puede USAR en la misma transacción que lo crea, y esta migración no lo usa.

-- AlterEnum
ALTER TYPE "PlatformChargeFrequency" ADD VALUE 'ONE_TIME';

-- AlterEnum
ALTER TYPE "PlatformChargeInvoiceMode" ADD VALUE 'NONE';

-- AlterTable
ALTER TABLE "PlatformCfdi" ADD COLUMN     "chargeLinkedAt" TIMESTAMP(3);
