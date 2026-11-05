-- Llaves del CRM más finas (plan docs/superpowers/plans/2026-11-04-crm-llaves-finas.md, L2 y L11).
--
-- 1. Las 8 llaves finas y `llavesVersion` en "PlatformAccess" (todas en false / 0).
-- 2. L2: se traducen las llaves viejas, para que nadie pierda lo que hoy tiene:
--      campanas OR admin  → las 4 de correo masivo (hoy `admin` también entra a campañas);
--      admin              → las 3 de administración;
--      editarScope        → «Cerrar negocios» (hoy quien edita también cierra).
--    Y el espejo viejo (`campanas`, `admin`) se recalcula con la regla de L11, que falla cerrado.
-- 3. L11, AL FINAL (sus propios UPDATE no deben pasar por él): un disparador que, en TODA escritura de la fila en la que
--    `llavesVersion` no sube, apaga las 8 finas. El código nuevo la sube en cada escritura; la versión vieja del servidor
--    no la conoce, así que lo que escriba (cambiar llaves, dar de baja, volver a dar de alta, reclamar) deja a esa persona
--    sin llaves finas. Lo que la versión vieja no toca se queda exacto.
--
-- Reversión (no se ejecuta):
--   DROP TRIGGER IF EXISTS "PlatformAccess_llaves_finas_por_version" ON "PlatformAccess";
--   DROP FUNCTION IF EXISTS "platformAccessLlavesFinasPorVersion"();
--   ALTER TABLE "PlatformAccess" DROP COLUMN "plantillas", DROP COLUMN "preparar", DROP COLUMN "mandar",
--     DROP COLUMN "verCampanas", DROP COLUMN "equipo", DROP COLUMN "configurar", DROP COLUMN "bajas", DROP COLUMN "cerrar",
--     DROP COLUMN "llavesVersion";
SET LOCAL lock_timeout = '5s';

ALTER TABLE "PlatformAccess"
  ADD COLUMN "plantillas" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "preparar" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mandar" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "verCampanas" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "equipo" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "configurar" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bajas" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cerrar" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "llavesVersion" INTEGER NOT NULL DEFAULT 0;

-- L2: las llaves viejas, traducidas.
UPDATE "PlatformAccess" SET "plantillas" = true, "preparar" = true, "mandar" = true, "verCampanas" = true
WHERE "campanas" OR "admin";

UPDATE "PlatformAccess" SET "equipo" = true, "configurar" = true, "bajas" = true
WHERE "admin";

UPDATE "PlatformAccess" SET "cerrar" = true
WHERE "editarScope" IS NOT NULL;

-- El espejo de L11: `campanas` = las 4 de correo; `admin` = las 3 de administración Y las 4 de correo.
UPDATE "PlatformAccess" SET
  "campanas" = ("plantillas" AND "preparar" AND "mandar" AND "verCampanas"),
  "admin" = ("equipo" AND "configurar" AND "bajas" AND "plantillas" AND "preparar" AND "mandar" AND "verCampanas");

-- L11: en TODA escritura de la fila en la que `llavesVersion` no sube, las 8 finas se apagan. Sin excepciones por valores
-- (r9): un UPDATE pasa por aquí aunque no cambie nada, también el de un upsert. Las columnas viejas (`campanas`, `admin`)
-- se quedan como las escribió quien escribió: la versión vieja las sigue leyendo.
CREATE OR REPLACE FUNCTION "platformAccessLlavesFinasPorVersion"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."llavesVersion" <= OLD."llavesVersion" THEN
    NEW."plantillas" := false;
    NEW."preparar" := false;
    NEW."mandar" := false;
    NEW."verCampanas" := false;
    NEW."equipo" := false;
    NEW."configurar" := false;
    NEW."bajas" := false;
    NEW."cerrar" := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "PlatformAccess_llaves_finas_por_version" ON "PlatformAccess";
CREATE TRIGGER "PlatformAccess_llaves_finas_por_version"
  BEFORE UPDATE ON "PlatformAccess"
  FOR EACH ROW EXECUTE FUNCTION "platformAccessLlavesFinasPorVersion"();
