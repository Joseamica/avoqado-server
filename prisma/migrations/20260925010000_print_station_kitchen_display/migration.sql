-- A mano (no `migrate dev`) porque la base local es COMPARTIDA entre sesiones.
-- Aditiva e idempotente: default false = nadie cambia de comportamiento hasta que Avoqado la prenda.
ALTER TABLE "PrintStation" ADD COLUMN IF NOT EXISTS "hasKitchenDisplay" BOOLEAN NOT NULL DEFAULT false;
