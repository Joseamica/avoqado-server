-- D7 (hz:033d44ca:D7, encargo b61791): la ronda que llega después de que otra caja cobró la mesa cae en una cuenta aparte.
-- Sólo columnas nulas, sin reescribir filas (ALTER instantáneo). Sus índices van CONCURRENTLY en 20261116180010 y 20261116180020
-- (una sentencia por archivo: Prisma manda cada archivo como un lote y CONCURRENTLY no corre dentro de una transacción).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Order"
  ADD COLUMN "rondaTardiaDeId" TEXT,
  ADD COLUMN "rondaTardiaAparato" TEXT;
