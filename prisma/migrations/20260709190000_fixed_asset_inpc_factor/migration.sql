-- Factor de actualización INPC (art. 31 LISR) por activo, capturado por el contador (null = histórico).
ALTER TABLE "FixedAsset" ADD COLUMN "inpcFactor" DECIMAL(6,4);
