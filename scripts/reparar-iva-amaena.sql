-- ============================================================================
-- Reparación puntual — Amaena, orden RES-14508324
-- ============================================================================
-- QUÉ PASÓ
--   La reserva de "Manicure + Pedicure Spa + Gel" (clienta Regina Porter,
--   31-ago-2026) nació sumando 16% de IVA ENCIMA del precio de catálogo.
--   En México ese precio ya lo incluye, y la dueña del salón confirmó por
--   WhatsApp el 2026-09-03 que el paquete cuesta $1,000, no $1,160.
--
--   La causa: `Product.taxRate` tiene `@default(0.16)` y
--   `createOrderFromReservation` lo suma de forma ADITIVA
--   (lineTax = lineSubtotal * taxRate). Nadie configuró ese 16% — la bitácora
--   del alta del producto (PRODUCT_CREATED, 16-jul, source customer-mcp)
--   registra sólo nombre, tipo, precio y categoría, sin tasa alguna.
--
-- QUÉ CORRIGE
--   Orden  cmthsqxba005isg2auac1loxh
--     antes:   subtotal 1000 · IVA 160 · total 1160 · por cobrar 1160
--     después: subtotal 1000 · IVA   0 · total 1000 · por cobrar 1000
--   Renglón cmthsqxe3005ksg2aa9mj960u  (IVA 160 -> 0, total 1160 -> 1000)
--   + una fila en ActivityLog con el antes/después y el motivo.
--
-- POR QUÉ ES SEGURO
--   Los valores actuales van DENTRO del WHERE y todo corre en un solo bloque
--   transaccional. Si la orden cambió desde la verificación (alguien la cobró,
--   la facturó o la editó), el bloque lanza excepción y hace ROLLBACK: no deja
--   nada a medias y no pisa trabajo de nadie.
--
-- CÓMO CORRERLO (desde avoqado-server/)
--   psql "$(grep -E '^RENDER_DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'"'"')" \
--     -X -v ON_ERROR_STOP=1 -f scripts/reparar-iva-amaena.sql
--
-- 🔴 Esto escribe en PRODUCCIÓN. Correr una sola vez. Es idempotente por
--    construcción: una segunda corrida falla con "ya no esta como se verifico"
--    y no cambia nada.
-- ============================================================================

DO $$
DECLARE
  v_order CONSTANT text := 'cmthsqxba005isg2auac1loxh';
  v_item  CONSTANT text := 'cmthsqxe3005ksg2aa9mj960u';
  v_venue text;
  n int;
BEGIN
  SELECT "venueId" INTO v_venue FROM "Order" WHERE id = v_order;
  IF v_venue IS NULL THEN
    RAISE EXCEPTION 'Orden % no encontrada', v_order;
  END IF;

  UPDATE "Order"
     SET "taxAmount"        = 0,
         total              = 1000.00,
         "remainingBalance" = 1000.00,
         version            = version + 1,
         "updatedAt"        = (NOW() AT TIME ZONE 'UTC')
   WHERE id = v_order
     AND "paymentStatus" = 'PENDING'
     AND "paidAmount"    = 0
     AND subtotal        = 1000.00
     AND "taxAmount"     = 160.00
     AND total           = 1160.00
     AND version         = 1
     AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId" = v_order)
     AND NOT EXISTS (SELECT 1 FROM "Cfdi"    c WHERE c."orderId" = v_order);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'La orden ya no esta como se verifico (filas afectadas=%). Nada se toco.', n;
  END IF;

  UPDATE "OrderItem"
     SET "taxAmount" = 0,
         total       = 1000.00
   WHERE id          = v_item
     AND "orderId"   = v_order
     AND "taxAmount" = 160.00
     AND total       = 1160.00;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'El renglon ya no esta como se verifico (filas afectadas=%). Rollback.', n;
  END IF;

  INSERT INTO "ActivityLog" (id, action, entity, "entityId", "venueId", data, "createdAt")
  VALUES (
    'cmtlpxgkrnq8aiaemiut9me11',
    'ORDER_TAX_CORRECTED',
    'Order',
    v_order,
    v_venue,
    jsonb_build_object(
      'motivo',   'El precio de catalogo ya incluye IVA (convencion MX). La reserva sumo 16% encima por el taxRate por default de Product; la duena del venue confirmo que el precio del paquete es 1000.',
      'antes',    jsonb_build_object('taxAmount', 160.00, 'total', 1160.00, 'remainingBalance', 1160.00),
      'despues',  jsonb_build_object('taxAmount', 0, 'total', 1000.00, 'remainingBalance', 1000.00),
      'servicio', 'Manicure + Pedicure Spa + Gel',
      'orderNumber', 'RES-14508324',
      'autorizado_por', 'founder, confirmado con la duena del venue por WhatsApp el 2026-09-03'
    ),
    (NOW() AT TIME ZONE 'UTC')
  );

  RAISE NOTICE 'LISTO: orden y renglon corregidos, bitacora escrita.';
END $$;

-- Verificación (debe salir: iva 0, total 1000.00, por_cobrar 1000.00, version 2)
SELECT o."orderNumber",
       o.subtotal,
       o."taxAmount"        AS iva,
       o.total,
       o."remainingBalance" AS por_cobrar,
       o.version,
       oi."taxAmount"       AS iva_renglon,
       oi.total             AS total_renglon
FROM "Order" o
JOIN "OrderItem" oi ON oi."orderId" = o.id
WHERE o.id = 'cmthsqxba005isg2auac1loxh';
