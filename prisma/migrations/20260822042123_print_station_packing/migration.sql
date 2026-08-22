-- AlterTable
ALTER TABLE "PrintStation" ADD COLUMN     "isPacking" BOOLEAN NOT NULL DEFAULT false;

-- UNA estación de empaque por negocio. Índice único PARCIAL, igual que el de `isDefault`
-- (ver 20260713095533): el parcial permite que muchas filas tengan `false` y sólo restringe
-- las que valen `true`. Un unique normal dejaría marcar una sola estación en TODA la tabla.
CREATE UNIQUE INDEX "PrintStation_venueId_packing_key" ON "PrintStation"("venueId") WHERE "isPacking" = true;
