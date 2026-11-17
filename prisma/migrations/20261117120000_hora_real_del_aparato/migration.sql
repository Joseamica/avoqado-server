-- D93 (encargo 18cc7f, founder 16-nov «B», como Square): la hora del aparato de una venta o cobro hecho sin internet, sólo para
-- reportes. Columnas opcionales sin default: ADD COLUMN es instantáneo en Postgres (sin reescribir la tabla) y las filas de hoy
-- quedan en NULL (= su hora de llegada). Sin índice nuevo: los lectores filtran por el `(venueId, createdAt)` de siempre ensanchado.
ALTER TABLE "Order" ADD COLUMN "clientCreatedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "clientCreatedAt" TIMESTAMP(3);
