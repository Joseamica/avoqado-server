-- Estación «No lleva comanda» (plan 2026-11-10). DEFAULT true: ninguna estación de hoy cambia.
ALTER TABLE "PrintStation" ADD COLUMN "sendsComanda" BOOLEAN NOT NULL DEFAULT true;
