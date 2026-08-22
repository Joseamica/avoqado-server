-- Fase 0.C — UNA orden viva por reserva.
--
-- Dos check-ins concurrentes de la misma reserva podían abrir dos órdenes TPV: el
-- `findFirst` de idempotencia de createOrderFromReservation no es atómico. Este índice
-- parcial lo garantiza en la base: el perdedor recibe P2002, que el wrapper de check-in
-- atrapa FUERA de la transacción y resuelve devolviendo la orden del ganador.
--
-- Predicado = "orden viva": CANCELLED y DELETED no cuentan (una orden cancelada no debe
-- bloquear su reemplazo). COMPLETED sí cuenta. Es el MISMO predicado que usa el
-- `findFirst` previo (createOrderFromReservation.ts, ALIVE_ORDER_EXCLUDED_STATUSES).
--
-- ANTES de aplicar en prod: `npx tsx scripts/audit-duplicate-reservation-orders.ts`
-- debe salir con "Sin duplicados"; si hay reservas con >1 orden viva, la creación del
-- índice falla y hay que resolverlas a mano (nunca cancelar una orden PAGADA por script).
--
-- Prisma no puede expresar índices parciales en schema.prisma (precedente en este repo:
-- PrintStation_venueId_default_key, TerminalPaymentRequest_active_slot).
CREATE UNIQUE INDEX "Order_reservationId_alive_key"
  ON "Order" ("reservationId")
  WHERE "reservationId" IS NOT NULL AND "status" NOT IN ('CANCELLED', 'DELETED');
