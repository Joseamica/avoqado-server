-- IVA por producto, plan 5 (D5): un producto con renglones de venta ("OrderItem") no se borra de verdad; se ARCHIVA
-- ("deletedAt" + "deletedBy" + active = false). Defensa del plan maestro (v6 §2): ningún camino futuro —script, SQL directo,
-- código nuevo— vuelve a dejar ventas huérfanas: "OrderItem"."productId" es la referencia fiscal (sin producto, el IVA de una
-- venta no facturada se leería como 16 %). Los borrados duros que siguen (borrar un negocio LIVE_DEMO/TRIAL, la limpieza de
-- live demos, la conversión de demo y el rollback del asistente) quitan antes las órdenes o borran un producto recién creado.
-- El EXISTS usa el índice "OrderItem"("productId"). Un alta de renglón toma FOR KEY SHARE del producto: si el borrado espera,
-- al seguir ve el renglón. No toca "productIvaTratamientoGuard" ni sus triggers.
-- Reversión (Ruling P5-R17; no se ejecuta):
--   DROP TRIGGER IF EXISTS "Product_con_ventas_no_se_borra" ON "Product";
--   DROP FUNCTION IF EXISTS "productoConVentasNoSeBorra"();
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "productoConVentasNoSeBorra"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "OrderItem" WHERE "productId" = OLD.id) THEN
    RAISE EXCEPTION 'PRODUCTO_CON_VENTAS_NO_SE_BORRA' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS "Product_con_ventas_no_se_borra" ON "Product";
CREATE TRIGGER "Product_con_ventas_no_se_borra"
BEFORE DELETE ON "Product"
FOR EACH ROW EXECUTE FUNCTION "productoConVentasNoSeBorra"();
