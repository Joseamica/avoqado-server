-- IVA por producto, bloque B2 (spec planes 6-7 §4.1, D7): el reparto por renglón de cada descuento.
-- Aditiva y nula: las filas viejas quedan sin reparto (la factura aplica D8). Sin backfill.
ALTER TABLE "OrderDiscount" ADD COLUMN "reparto" JSONB;
