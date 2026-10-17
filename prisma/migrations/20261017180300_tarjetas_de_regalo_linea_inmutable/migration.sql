-- Tarjetas de regalo (spec § 4.4): un sobre cuelga de UNA sola línea de venta, y esa línea NO lo suelta ni lo cambia.
-- El índice único "OrderItem_giftCardId_key" (20261015090010) impide que OTRA línea escriba el mismo giftCardId, pero no
-- basta: en una relación 1:1, el `giftCard: { connect }` anidado de Prisma primero le pone giftCardId = NULL a la línea
-- que ya tenía el sobre y luego se lo asigna a la nueva, sin P2002 (medido el 14-oct en A1). Un reintento o un error de
-- código movería así un sobre ya vendido de una cuenta a otra sin que nada truene. Este trigger lo vuelve garantía de la
-- base: una línea con sobre no cambia ni suelta su giftCardId (asignar a una línea SIN sobre sigue permitido).
-- No frena el borrado de la línea (DELETE) ni las escrituras que no tocan giftCardId (`UPDATE OF` + WHEN).
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION "orderItemTarjetaLineaInmutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TARJETA_LINEA_INMUTABLE: la línea que vende una tarjeta de regalo no suelta ni cambia su sobre'
    USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER "OrderItem_tarjeta_linea_inmutable"
BEFORE UPDATE OF "giftCardId" ON "OrderItem"
FOR EACH ROW WHEN (OLD."giftCardId" IS NOT NULL AND NEW."giftCardId" IS DISTINCT FROM OLD."giftCardId")
EXECUTE FUNCTION "orderItemTarjetaLineaInmutable"();
