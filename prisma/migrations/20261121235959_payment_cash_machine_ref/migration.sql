-- Máquina de efectivo (QuickPay Mini), fase 1a: la referencia del folio de la máquina en el pago.
-- SOLA en su migración (revisión de apps viejas antes de publicar, 22-nov): ADD COLUMN de una columna nullable y sin default es sólo
-- metadatos en Postgres, pero toma un candado exclusivo de Payment; en un lote con las FK de las tablas nuevas (candados de Venue y
-- Terminal) Payment quedaba bloqueada mientras esas esperaban. Aquí lo único que espera es este candado, y se suelta al terminar.
-- AlterTable
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "cashMachineRef" VARCHAR(32);
