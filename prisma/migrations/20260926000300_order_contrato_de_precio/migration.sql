-- IVA por producto, plan 2: contrato de precio de cada venta. Aditiva y SIN backfill: todas las órdenes existentes
-- quedan DESCONOCIDO (spec v5 §1). ADD COLUMN con DEFAULT constante es metadata-only en PG11+ (no reescribe "Order").
SET LOCAL lock_timeout = '5s';

DO $$ BEGIN
  CREATE TYPE "ContratoDePrecio" AS ENUM ('IVA_INCLUIDO', 'IVA_APARTE', 'DESCONOCIDO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "contratoDePrecio" "ContratoDePrecio" NOT NULL DEFAULT 'DESCONOCIDO';
