-- Variantes, escritor único (spec 2026-10-14 §6): los campos del padre de una VARIANTE sólo los cambia el motor
-- `productGroup.service.ts`, que marca `set_config('avoqado.product_group_writer', 'on', true)` en su transacción.
-- Cubre Prisma, scripts, seeds y SQL a mano. Mismo patrón que `avoqado.stock_origen` del conector Shopify.
-- El nombre empieza con «Product_zz_» para correr DESPUÉS de los triggers del IVA (Postgres los ordena por nombre) y ver
-- el ivaTratamiento ya derivado de la tupla vieja.
--
-- Reversión (no se ejecuta):
--   DROP TRIGGER IF EXISTS "Product_zz_grupo_escritor_unico" ON "Product";
--   DROP FUNCTION IF EXISTS "productGroupSingleWriterGuard"();
--   DROP INDEX IF EXISTS "ProductGroupModifierGroup_modifierGroupId_idx";
--   DROP INDEX IF EXISTS "ProductVariantValue_optionId_idx";
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "productGroupSingleWriterGuard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('avoqado.product_group_writer', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."productGroupId" IS NOT NULL OR NEW."variantKey" IS NOT NULL THEN
      RAISE EXCEPTION 'PRODUCT_GROUP_FIELD_OWNED_BY_PARENT' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: entrar o salir de una familia, o cambiar su llave, sólo por el motor.
  IF NEW."productGroupId" IS DISTINCT FROM OLD."productGroupId"
     OR NEW."variantKey" IS DISTINCT FROM OLD."variantKey"
     OR NEW."variantImageUrl" IS DISTINCT FROM OLD."variantImageUrl" THEN
    RAISE EXCEPTION 'PRODUCT_GROUP_FIELD_OWNED_BY_PARENT' USING ERRCODE = 'P0001';
  END IF;

  IF OLD."productGroupId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."categoryId" IS DISTINCT FROM OLD."categoryId"
     OR NEW."ivaTratamiento" IS DISTINCT FROM OLD."ivaTratamiento"
     OR NEW."taxRate" IS DISTINCT FROM OLD."taxRate"
     OR NEW."objetoImp" IS DISTINCT FROM OLD."objetoImp"
     OR NEW."satProductKey" IS DISTINCT FROM OLD."satProductKey"
     OR NEW."satUnitKey" IS DISTINCT FROM OLD."satUnitKey"
     OR NEW."description" IS DISTINCT FROM OLD."description"
     -- A NULL sólo por la cascada ON DELETE SET NULL: la estación ya no existe (la del padre también queda en NULL). Un
     -- escritor que la quita mientras la estación existe se rechaza (auditoría N3).
     OR (NEW."printStationId" IS DISTINCT FROM OLD."printStationId"
         AND (NEW."printStationId" IS NOT NULL
              OR EXISTS (SELECT 1 FROM "PrintStation" WHERE id = OLD."printStationId")))
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."imageUrl" IS DISTINCT FROM OLD."imageUrl" THEN
    RAISE EXCEPTION 'PRODUCT_GROUP_FIELD_OWNED_BY_PARENT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Product_zz_grupo_escritor_unico" ON "Product";
CREATE TRIGGER "Product_zz_grupo_escritor_unico"
BEFORE INSERT OR UPDATE ON "Product"
FOR EACH ROW EXECUTE FUNCTION "productGroupSingleWriterGuard"();

-- Índices de las FK sin índice propio (revisión de la tarea 1): borrar una opción o un grupo de modificadores no barre la tabla.
-- CreateIndex
CREATE INDEX "ProductGroupModifierGroup_modifierGroupId_idx" ON "ProductGroupModifierGroup"("modifierGroupId");

-- CreateIndex
CREATE INDEX "ProductVariantValue_optionId_idx" ON "ProductVariantValue"("optionId");
