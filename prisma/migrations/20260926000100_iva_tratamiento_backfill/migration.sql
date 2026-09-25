-- Paso 2 de 3: rellenar Product.ivaTratamiento desde SU tupla (~1 007 filas en prod).
--
-- Fix round 1 (Ruling R8, revisión de la Tarea 4): este comentario decía "sólo se rellena/hereda tal cual",
-- lo cual no es exacto. El UPDATE de abajo únicamente pone SET "ivaTratamiento" = ... — pero al hacerlo
-- dispara el trigger "Product_ivaTratamiento_1_explicito" (BEFORE UPDATE OF "ivaTratamiento"), que ve que
-- la tupla taxRate/objetoImp NO cambió respecto a OLD (nunca cambia aquí: este UPDATE no la toca) y por eso
-- entra a su rama "se reescribe desde el enum": fuerza taxRate/objetoImp a la tupla CANÓNICA del tratamiento
-- derivado. Para IVA_16/IVA_8/IVA_0/EXENTO/BLOQUEADO_03/BLOQUEADO_04 la tupla canónica es idéntica a la tupla
-- legacy que produjo esa derivación, así que no hay cambio visible. El ÚNICO caso donde SÍ cambia: objetoImp
-- '01' (NO_OBJETO) con una taxRate legacy distinta de 0 —p. ej. (0.16, '01')— termina en (0, '01'), porque el
-- objeto 01 no traslada IVA y su tupla canónica exige taxRate = 0. Es fiscalmente inerte (el 01 no lleva
-- traslado de IVA que ese número pudiera alterar) y, medido en producción en modo sólo-lectura el 2026-09-25,
-- no toca ningún producto real hoy: 981 filas activas en (0.16, '02'), 25 borradas en (0.16, '02') y 1 activa
-- en (0.16, '04') — cero productos con objetoImp '01' en toda la tabla. Se acepta el comportamiento (Ruling
-- R8: no se toca la lógica del UPDATE ni del trigger); este comentario sólo se corrige para no afirmar algo
-- que el código no hace. Idempotente. Sin DDL propio: ROW EXCLUSIVE del UPDATE (el trigger no agrega DDL).
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
