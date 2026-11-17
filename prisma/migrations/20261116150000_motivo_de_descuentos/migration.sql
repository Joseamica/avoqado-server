-- Encargo f998c8: motivo obligatorio en los descuentos del POS. Sólo agrega columnas (con default o nulas): ninguna fila cambia.
ALTER TABLE "VenueSettings" ADD COLUMN "discountReasonRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "VenueSettings" ADD COLUMN "discountReasons" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "OrderDiscount" ADD COLUMN "reason" TEXT;
ALTER TABLE "OrderDiscount" ADD COLUMN "reasonComment" TEXT;
