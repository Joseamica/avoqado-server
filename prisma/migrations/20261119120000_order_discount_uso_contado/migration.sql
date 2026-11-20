-- D19 (hz:e82938e1:D19, encargo 01765a): la fila del descuento de cuenta del POS dice si sumó un uso a "Discount"."currentUses",
-- para que quitarla devuelva sólo lo que sumó. Columna nueva con default constante: en Postgres 11+ no reescribe la tabla.
ALTER TABLE "OrderDiscount" ADD COLUMN "usoContado" BOOLEAN NOT NULL DEFAULT false;
