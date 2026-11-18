-- D30 (17-nov-2026): el folio de la orden lo pone la base. Aditiva: no renumera ventas ni pone índice único (los folios de
-- integraciones y repartos se guardan tal cual). Un proceso viejo que todavía manda `ORD-<ms>` sigue funcionando.

-- La secuencia compartida por todos los procesos. Tope de 12 cifras y SIN vuelta: al agotarse falla, nunca repite.
CREATE SEQUENCE "order_number_seq" AS BIGINT MINVALUE 1 MAXVALUE 999999999999 START 1 NO CYCLE;

-- `ORD-0` + 12 cifras, p. ej. `ORD-0000000000001`: el valor por defecto de Order.orderNumber y el tronco de los folios con
-- sufijo (dividir por asiento: `<tronco>-S2`). El cero de en medio la separa de los `ORD-<ms>` de siempre (13 cifras desde 1).
CREATE FUNCTION order_number_next() RETURNS TEXT LANGUAGE SQL VOLATILE AS $$
  SELECT 'ORD-0' || lpad(nextval('order_number_seq')::text, 12, '0')
$$;

-- Arranque, medido aquí mismo (r3 #8: no hace falta medir producción a mano): por encima del mayor `ORD-0<12 cifras>` que ya
-- exista, también con sufijo (`ORD-0…-S2`). Sin margen (menos de mil millones de folios libres) la migración FALLA y no se
-- aplica nada: nunca da la vuelta ni arranca a punto de agotarse.
DO $$
DECLARE
  mayor BIGINT;
BEGIN
  SELECT max(substring("orderNumber" FROM 6 FOR 12)::BIGINT) INTO mayor
  FROM "Order"
  WHERE "orderNumber" ~ '^ORD-0[0-9]{12}([^0-9]|$)';
  IF mayor IS NOT NULL AND 999999999999 - mayor < 1000000000 THEN
    RAISE EXCEPTION 'D30: ya existe el folio ORD-0% y quedan menos de mil millones de folios libres: la secuencia no tiene margen. Usa otro prefijo propio antes de migrar.', lpad(mayor::text, 12, '0');
  END IF;
  PERFORM setval('order_number_seq', coalesce(mayor, 0) + 1, false);
END $$;

-- Al final: la lectura de arriba no retiene el candado fuerte de "Order"; este cambio sólo toca el catálogo.
ALTER TABLE "Order" ALTER COLUMN "orderNumber" SET DEFAULT order_number_next();
