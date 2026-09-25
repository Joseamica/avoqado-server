-- Paso 2 de 3: rellenar Product.ivaTratamiento desde SU tupla (~1 007 filas en prod). El trigger acepta cada fila porque
-- es heredado de su propia tupla. Idempotente. Sin DDL: sólo ROW EXCLUSIVE.
SET lock_timeout = '5s';

UPDATE "Product" SET "ivaTratamiento" = "derivarIvaTratamiento"("taxRate", "objetoImp")
WHERE "ivaTratamiento" IS NULL AND "derivarIvaTratamiento"("taxRate", "objetoImp") IS NOT NULL;

-- Una tupla contradictoria (objeto 02 con tasa que el SAT no admite) no se inventa: se detiene la migración.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Product" WHERE "ivaTratamiento" IS NULL) THEN
    RAISE EXCEPTION 'Hay productos con una tupla taxRate/objetoImp que el SAT no admite; revisarlos antes de seguir';
  END IF;
END $$;

-- Marca pegajosa inicial: toda organización con algún producto ≠ IVA_16, incluidos archivados y heredados.
UPDATE "Organization" o SET "ivaMixtoAlgunaVez" = true
WHERE o."ivaMixtoAlgunaVez" = false AND EXISTS (
  SELECT 1 FROM "Product" p JOIN "Venue" v ON v."id" = p."venueId"
  WHERE v."organizationId" = o."id" AND p."ivaTratamiento" <> 'IVA_16'
);
