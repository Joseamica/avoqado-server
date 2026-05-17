-- Add Order.reservationId for check-in auto-conversion (Reservation → Order).
-- Additive + nullable: existing orders unaffected. Idempotency anchor for
-- createOrderFromReservation (skip-if-exists).

ALTER TABLE "Order" ADD COLUMN "reservationId" TEXT;

CREATE INDEX "Order_reservationId_idx" ON "Order"("reservationId");

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
