-- D662 parte 2 v5 (Codex p2v5-r4 #5): la VERSIÓN de los ajustes de la tienda en línea. El panel ordena sus lecturas por ella: la que
-- leyó una versión mayor gana aunque haya entrado antes. Antes era `updatedAt`, que Prisma fecha ANTES de esperar el candado de la fila:
-- un guardado que esperó podía quedar con una hora menor que el que confirmó antes, y el panel descartaba la lectura nueva.
-- La sube la BASE en cada UPDATE, bajo el candado de la fila (OLD es la versión ya confirmada): crece en el mismo orden en que se
-- confirman las escrituras, venga de Prisma, de SQL a mano o de un escritor futuro. Aditiva: las apps y el SERVIDOR anterior la ignoran.
--
-- Reversión (no se ejecuta):
--   DROP TRIGGER IF EXISTS "OnlineOrderingSettings_sube_version" ON "OnlineOrderingSettings";
--   DROP FUNCTION IF EXISTS "onlineOrderingSettingsSubeVersion"();
--   ALTER TABLE "OnlineOrderingSettings" DROP COLUMN IF EXISTS "version";
SET LOCAL lock_timeout = '5s';

ALTER TABLE "OnlineOrderingSettings" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION "onlineOrderingSettingsSubeVersion"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."version" := OLD."version" + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "OnlineOrderingSettings_sube_version"
  BEFORE UPDATE ON "OnlineOrderingSettings"
  FOR EACH ROW EXECUTE FUNCTION "onlineOrderingSettingsSubeVersion"();
