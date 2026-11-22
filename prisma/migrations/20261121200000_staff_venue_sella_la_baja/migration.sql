-- D19 (hz:248b195b:D19): toda baja de una membresía (`StaffVenue`) sella su fecha UNA vez, y reactivarla la limpia, la escriba
-- quien la escriba. Antes sólo «Desactivar» del menú de Equipo escribía `endDate`; el switch de la lista (y `update_staff_member`
-- del MCP, el botón de la organización y «quitar sucursal») apagaban `active` sin fecha, y la asistencia y la nómina
-- (`OR: [{ active: true, endDate: null }, { endDate: { gte: inicio } }]`) borraban a la persona de los días que sí trabajó.
-- Reactivar (switch, invitación, volver a asignar sucursal) dejaba la fecha vieja y la escondía de los rangos posteriores.
-- La regla vive en la BASE, como las otras guardas de membresía: cubre todo camino que escriba `active`, también el SQL directo.
--
--   · baja   (active true → false) sin fecha propia: endDate = ahora. Quien manda su propia fecha (seat cap, SUPERADMIN, CRM) la conserva.
--   · alta   (active false → true) sin fecha propia: endDate = NULL.
--   · baja repetida (false → false) con fecha ya puesta: se queda la primera; «Desactivar» sobre alguien ya dado de baja no la mueve.
--
-- Sólo dispara cuando la escritura nombra `active`: corregir o rellenar `endDate` sin tocar `active` no pasa por aquí.
-- `NOW() AT TIME ZONE 'UTC'`: la columna es timestamp sin zona y Prisma escribe UTC.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "staffVenueSellaBaja"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    IF NEW."endDate" IS NOT DISTINCT FROM OLD."endDate" THEN
      NEW."endDate" := (NOW() AT TIME ZONE 'UTC');
    END IF;
  ELSIF NOT OLD.active AND NEW.active THEN
    IF NEW."endDate" IS NOT DISTINCT FROM OLD."endDate" THEN
      NEW."endDate" := NULL;
    END IF;
  ELSIF NOT OLD.active AND NOT NEW.active AND OLD."endDate" IS NOT NULL THEN
    NEW."endDate" := OLD."endDate";
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "StaffVenue_sella_baja" ON "StaffVenue";
CREATE TRIGGER "StaffVenue_sella_baja"
BEFORE UPDATE OF active ON "StaffVenue"
FOR EACH ROW EXECUTE FUNCTION "staffVenueSellaBaja"();
