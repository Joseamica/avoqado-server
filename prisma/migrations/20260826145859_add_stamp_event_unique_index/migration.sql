-- Indice unico PARCIAL: un solo sello EARN por orden, por negocio.
--
-- 🔴 Esta es la garantia real de "un pago = exactamente un sello". El chequeo en
-- codigo (buscar antes de crear) es una optimizacion, NO una garantia: entre el
-- SELECT y el INSERT cabe otro cobro. Con el indice, PostgreSQL rechaza el segundo
-- con violacion de unicidad y el codigo lo trata como "ya estaba sellado".
--
-- Mismo patron que LoyaltyTransaction_customerId_orderId_earn_unique, que ya lleva
-- meses evitando el doble-acumulado de puntos en reintentos de cobro.
--
-- Se filtra por tipo EARN: las REVERSAL y ADJUST de la misma orden SI pueden ser
-- varias (un sello puede revertirse y volver a otorgarse tras una correccion).
CREATE UNIQUE INDEX "StampEvent_venueId_orderId_earn_unique"
ON "StampEvent" ("venueId", "orderId")
WHERE "type" = 'EARN' AND "orderId" IS NOT NULL;
