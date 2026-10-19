-- Una línea de tarjeta de regalo (NO_OBJETO, con giftCardId) no es mercancía con IVA distinto: no enciende la marca
-- pegajosa `ivaMixtoAlgunaVez` de la organización (spec § 4.4; sin esto la primera tarjeta pausaría la contabilidad).
-- Sólo se recrea el TRIGGER de 20260928000000_iva_contabilidad_exclusion; la función "orderItemSelloIvaMarca" no cambia.
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS "OrderItem_selloIva_marca" ON "OrderItem";
CREATE TRIGGER "OrderItem_selloIva_marca"
AFTER INSERT OR UPDATE OF "ivaTratamiento" ON "OrderItem"
FOR EACH ROW WHEN (NEW."ivaTratamiento" IS NOT NULL AND NEW."ivaTratamiento" <> 'IVA_16' AND NEW."giftCardId" IS NULL)
EXECUTE FUNCTION "orderItemSelloIvaMarca"();
