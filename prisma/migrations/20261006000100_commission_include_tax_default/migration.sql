-- Fase 3 de pago por servicio (D5, spec §9-1): la comisión se calcula sobre lo que pagó el cliente, CON IVA, como todos
-- los precios de la plataforma. Antes el interruptor sumaba el IVA otra vez o prometía «sin IVA» sin restarlo.
-- Los esquemas existentes pasan a «con IVA»: sus números no cambian (ninguna orden registra hoy su IVA) y la pantalla deja
-- de mentir. Quien quiera la base sin IVA lo elige en el esquema.
ALTER TABLE "CommissionConfig" ALTER COLUMN "includeTax" SET DEFAULT true;
UPDATE "CommissionConfig" SET "includeTax" = true WHERE "includeTax" = false;
