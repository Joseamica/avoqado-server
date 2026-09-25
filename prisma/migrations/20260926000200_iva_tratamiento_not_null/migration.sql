-- Paso 3 de 3: CHECK NOT VALID → VALIDATE (SHARE UPDATE EXCLUSIVE) → SET NOT NULL (lo evita escanear el CHECK válido).
--
-- Nota: Prisma envuelve cada archivo de migración en su propia transacción; por eso el backfill (paso 2) y este
-- paso 3 van en carpetas distintas — VALIDATE y SET NOT NULL no deben compartir la transacción del backfill.
SET lock_timeout = '5s';
ALTER TABLE "Product" ADD CONSTRAINT "Product_ivaTratamiento_not_null" CHECK ("ivaTratamiento" IS NOT NULL) NOT VALID;
ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_ivaTratamiento_not_null";
ALTER TABLE "Product" ALTER COLUMN "ivaTratamiento" SET NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "ivaTratamiento" SET DEFAULT 'IVA_16';
-- El CHECK se conserva a propósito (Codex ronda 5: no eliminarlo en el mismo comando).
