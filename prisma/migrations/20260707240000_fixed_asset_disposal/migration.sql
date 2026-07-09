-- Baja de activo fijo (venta u obsolescencia): fecha de baja + precio de venta (para ganancia/pérdida).
ALTER TABLE "FixedAsset" ADD COLUMN "disposalDate" TIMESTAMP(3);
ALTER TABLE "FixedAsset" ADD COLUMN "disposalProceedsCents" INTEGER;
