-- Paso 3 de 3: CHECK NOT VALID → VALIDATE → SET NOT NULL (lo evita reescanear la tabla: con el CHECK ya
-- validado, SET NOT NULL sólo revisa el catálogo).
--
-- Fix round 1 (minor, revisión de la Tarea 4): este comentario decía que VALIDATE corre bajo SHARE UPDATE
-- EXCLUSIVE — cierto SÓLO si fuera su propia transacción. Prisma envuelve TODO este archivo en una única
-- transacción, y el ADD CONSTRAINT ... NOT VALID de la línea de abajo toma ACCESS EXCLUSIVE (aunque sea
-- breve, sólo cambia catálogo); Postgres no libera ni degrada un lock a media transacción, así que el
-- VALIDATE CONSTRAINT que sigue escanea la tabla sosteniendo ESE ACCESS EXCLUSIVE heredado, no el SHARE
-- UPDATE EXCLUSIVE más ligero que tendría si corriera solo. Es decir: aquí NO se logra el beneficio real de
-- partir NOT VALID/VALIDATE (que exige transacciones separadas). Inofensivo a ~1,007 filas — el escaneo es
-- de milisegundos — así que no se reestructura en archivos separados; este comentario sólo deja de afirmar
-- un beneficio que el archivo, tal como está, no entrega.
--
-- Nota: Prisma envuelve cada archivo de migración en su propia transacción; por eso el backfill (paso 2) y este
-- paso 3 van en carpetas distintas — el backfill y este ALTER no deben compartir transacción entre sí.
SET lock_timeout = '5s';
ALTER TABLE "Product" ADD CONSTRAINT "Product_ivaTratamiento_not_null" CHECK ("ivaTratamiento" IS NOT NULL) NOT VALID;
ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_ivaTratamiento_not_null";
ALTER TABLE "Product" ALTER COLUMN "ivaTratamiento" SET NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "ivaTratamiento" SET DEFAULT 'IVA_16';
-- El CHECK se conserva a propósito (Codex ronda 5: no eliminarlo en el mismo comando).
