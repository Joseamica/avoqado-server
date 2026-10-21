-- Tarjetas de regalo (A1 ⭐ del cierre): el sobre nace con SU línea (el INSERT de createGiftCardOrder) y ninguna línea lo toma
-- después. El trigger de 20261017180300 sólo frenaba soltar o cambiar el sobre (OLD con giftCardId); un UPDATE que le ponía un
-- sobre a una línea SIN sobre (NULL → id) pasaba y convertía en «venta de tarjeta» un renglón de mercancía ya cobrado. Ahora
-- frena TODO cambio de giftCardId en un UPDATE. Los INSERT no cambian (el trigger es BEFORE UPDATE) y el borrado de la línea
-- tampoco. Sólo se recrea el TRIGGER y el texto de la función; su nombre y su código de error (P0001) no cambian.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "orderItemTarjetaLineaInmutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TARJETA_LINEA_INMUTABLE: el sobre de una tarjeta de regalo nace con su línea de venta; ninguna línea lo toma, lo suelta ni lo cambia'
    USING ERRCODE = 'P0001';
END $$;

DROP TRIGGER IF EXISTS "OrderItem_tarjeta_linea_inmutable" ON "OrderItem";
CREATE TRIGGER "OrderItem_tarjeta_linea_inmutable"
BEFORE UPDATE OF "giftCardId" ON "OrderItem"
FOR EACH ROW WHEN (NEW."giftCardId" IS DISTINCT FROM OLD."giftCardId")
EXECUTE FUNCTION "orderItemTarjetaLineaInmutable"();
