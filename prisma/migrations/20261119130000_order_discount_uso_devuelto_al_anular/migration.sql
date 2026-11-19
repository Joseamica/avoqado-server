-- D24 (hz:e82938e1:D24, encargo ea1827): al anular una cuenta sin cobrar, la fila del descuento de cuenta del POS que sumó su uso
-- (`usoContado`) lo devuelve y queda marcada, para que ningún otro camino (la TPV al quitar el descuento de una cuenta que revivió por
-- dinero tardío) lo vuelva a restar. Columna nueva con default constante: en Postgres 11+ no reescribe la tabla.
ALTER TABLE "OrderDiscount" ADD COLUMN "usoDevueltoAlAnular" BOOLEAN NOT NULL DEFAULT false;
