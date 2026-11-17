-- Extra ligado a un PLATILLO del menú (encargo 27771e, founder 16-nov-2026: como Fudo y Toast).
-- Columna opcional: las filas existentes quedan en NULL y nada cambia para ellas.
ALTER TABLE "Modifier" ADD COLUMN "linkedProductId" TEXT;

-- La tabla Modifier es chica (miles de filas por negocio, no millones): el índice normal no frena nada.
CREATE INDEX "Modifier_linkedProductId_idx" ON "Modifier"("linkedProductId");

ALTER TABLE "Modifier" ADD CONSTRAINT "Modifier_linkedProductId_fkey" FOREIGN KEY ("linkedProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
