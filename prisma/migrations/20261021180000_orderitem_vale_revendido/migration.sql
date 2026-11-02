-- Aditiva: una columna vacía y su índice. No toca una sola fila existente (tablero hz:11d84b54:D1, 21-oct-2026).
-- Procedencia de un renglón de vale cuya venta se canceló y cuyo vale se volvió a cobrar en otra cuenta.
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "releasedAreaTicketLineId" TEXT;

CREATE INDEX IF NOT EXISTS "OrderItem_releasedAreaTicketLineId_idx" ON "OrderItem"("releasedAreaTicketLineId");
