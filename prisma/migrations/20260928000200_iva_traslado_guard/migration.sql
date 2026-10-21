-- IVA por producto, plan 4 (Tarea 3): trasladar un negocio entre organizaciones no mezcla IVA mixto con contabilidad ni
-- duplica pólizas. La barrera vive en la BASE (cubre el endpoint del superadmin y el SQL directo):
--   IVA_TRASLADO_CON_CONTABILIDAD  el negocio ya tiene pólizas propias (su idempotencia es por organización: autoPosting
--                                  volvería a postear sus pagos en la nueva);
--   IVA_TRASLADO_INCOMPATIBLE      el negocio es mixto (producto o renglón sellado ≠ IVA_16) y el destino lleva contabilidad;
--   si es mixto y pasa, el destino queda marcado (la marca es pegajosa).
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "venueTrasladoIvaGuard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  destino_marcada boolean;
  destino_con_libros boolean;
  negocio_mixto boolean;
BEGIN
  IF NEW."organizationId" IS NOT DISTINCT FROM OLD."organizationId" THEN
    RETURN NEW;
  END IF;
  -- La app ya tomó las dos organizaciones (orden de id) y luego el negocio; por SQL directo el negocio va primero (R10).
  PERFORM 1 FROM "Organization" o WHERE o.id IN (OLD."organizationId", NEW."organizationId") ORDER BY o.id FOR NO KEY UPDATE;
  -- Un negocio con pólizas no se traslada: su idempotencia es por organización y sus pagos se postearían otra vez.
  IF EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."venueId" = NEW.id) THEN
    RAISE EXCEPTION 'IVA_TRASLADO_CON_CONTABILIDAD' USING ERRCODE = 'P0001';
  END IF;
  SELECT o."ivaMixtoAlgunaVez" INTO destino_marcada FROM "Organization" o WHERE o.id = NEW."organizationId";
  destino_con_libros :=
    EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."organizationId" = NEW."organizationId")
    OR EXISTS (SELECT 1 FROM "AccountingPeriodLock" l WHERE l."organizationId" = NEW."organizationId");
  -- Mixto = algún producto (aunque esté borrado) ≠ IVA_16, o algún renglón SELLADO ≠ IVA_16 en un CFDI de este
  -- negocio. Un sello en vuelo no se escapa: la emisión tiene los productos de la orden FOR SHARE (admisionIva.ts).
  negocio_mixto :=
    EXISTS (SELECT 1 FROM "Product" p WHERE p."venueId" = NEW.id AND p."ivaTratamiento" <> 'IVA_16')
    OR EXISTS (SELECT 1 FROM "Cfdi" c
                 JOIN "OrderItemSelloIva" s ON s."cfdiId" = c.id
                 JOIN "OrderItem" oi ON oi.id = s."orderItemId"
                WHERE c."venueId" = NEW.id AND oi."ivaTratamiento" <> 'IVA_16');
  IF negocio_mixto AND destino_con_libros THEN
    RAISE EXCEPTION 'IVA_TRASLADO_INCOMPATIBLE' USING ERRCODE = 'P0001';
  END IF;
  IF negocio_mixto AND NOT destino_marcada THEN
    UPDATE "Organization" SET "ivaMixtoAlgunaVez" = true WHERE id = NEW."organizationId";
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Venue_trasladoIva_guard" ON "Venue";
CREATE TRIGGER "Venue_trasladoIva_guard"
BEFORE UPDATE OF "organizationId" ON "Venue"
FOR EACH ROW EXECUTE FUNCTION "venueTrasladoIvaGuard"();
