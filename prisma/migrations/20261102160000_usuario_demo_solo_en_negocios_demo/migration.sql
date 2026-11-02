-- hz:f26b3afc:D5 — los usuarios demo (`@demo.avoqado.io`) tienen contraseña pública (va en el PDF de prospectos): sólo
-- pueden estar en negocios demo (`LIVE_DEMO`) de organizaciones donde TODOS los negocios son demo (el dueño de una sucursal
-- ve su organización entera, Codex r1-2), nunca como SUPERADMIN (en una sucursal da permisos globales, r1-1) y sin cambiar
-- de correo (con otro, su contraseña pública seguiría abriendo la cuenta sin que se le reconozca, r1-4). La barrera vive en
-- la BASE, como la del traslado de IVA: cubre todo camino que escriba membresías (SUPERADMIN, panel, alta, sync, scripts) y
-- el SQL directo. Las dos mitades (membresía y negocio) se escriben en transacciones distintas: el renglón de la
-- organización las forma en fila (r1-3). El código USUARIO_DEMO_EN_NEGOCIO_REAL lo traduce a un 400 `comoErrorDeUsuarioDemo`.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "usuarioDemoSoloEnDemosGuard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  org text;
BEGIN
  IF TG_TABLE_NAME = 'Staff' THEN
    IF lower(btrim(OLD.email)) LIKE '%@demo.avoqado.io' AND lower(btrim(NEW.email)) NOT LIKE '%@demo.avoqado.io' THEN
      RAISE EXCEPTION 'USUARIO_DEMO_EN_NEGOCIO_REAL' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'Venue' THEN
    -- Sólo lo que puede juntar a un usuario demo con un negocio real: un negocio real nuevo, uno demo que se vuelve real, o
    -- cualquiera que cambie de organización. Entre estados reales no se pide nada: el cambio de estado ya tiene el negocio
    -- y pedirle la organización formaría un ciclo con el traslado, que va organización → negocio (Codex D5 r2-4).
    IF TG_OP = 'INSERT' AND NEW.status = 'LIVE_DEMO' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."organizationId" IS NOT DISTINCT FROM OLD."organizationId"
       AND (NEW.status = 'LIVE_DEMO' OR OLD.status <> 'LIVE_DEMO') THEN
      RETURN NEW;
    END IF;
    org := NEW."organizationId";
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "Staff" s WHERE s.id = NEW."staffId" AND lower(btrim(s.email)) LIKE '%@demo.avoqado.io') THEN
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME = 'StaffVenue' THEN
      IF NEW.role = 'SUPERADMIN' THEN
        RAISE EXCEPTION 'USUARIO_DEMO_EN_NEGOCIO_REAL' USING ERRCODE = 'P0001';
      END IF;
      SELECT v."organizationId" INTO org FROM "Venue" v WHERE v.id = NEW."venueId";
      -- Un traslado que corría con el candado de la organización vieja ya movió el negocio: se revisa la nueva (r2-2).
      PERFORM 1 FROM "Organization" o WHERE o.id = org FOR NO KEY UPDATE;
      SELECT v."organizationId" INTO org FROM "Venue" v WHERE v.id = NEW."venueId";
    ELSE
      org := NEW."organizationId";
    END IF;
  END IF;

  PERFORM 1 FROM "Organization" o WHERE o.id = org FOR NO KEY UPDATE;

  IF TG_TABLE_NAME = 'Venue' THEN
    -- Un negocio real (nuevo, que deja de ser demo o que llega a otra organización) no queda con un usuario demo adentro
    -- ni en una organización con uno: miembro, o con sucursal en otro de sus negocios.
    IF NEW.status <> 'LIVE_DEMO' AND (
         EXISTS (SELECT 1 FROM "StaffOrganization" so JOIN "Staff" s ON s.id = so."staffId"
                  WHERE so."organizationId" = org AND lower(btrim(s.email)) LIKE '%@demo.avoqado.io')
      OR EXISTS (SELECT 1 FROM "StaffVenue" sv JOIN "Staff" s ON s.id = sv."staffId" JOIN "Venue" v ON v.id = sv."venueId"
                  WHERE (v."organizationId" = org OR sv."venueId" = NEW.id) AND lower(btrim(s.email)) LIKE '%@demo.avoqado.io')) THEN
      RAISE EXCEPTION 'USUARIO_DEMO_EN_NEGOCIO_REAL' USING ERRCODE = 'P0001';
    END IF;
    -- Un negocio demo con un usuario demo adentro tampoco llega a una organización con negocios reales (r2-1).
    IF EXISTS (SELECT 1 FROM "StaffVenue" sv JOIN "Staff" s ON s.id = sv."staffId"
                WHERE sv."venueId" = NEW.id AND lower(btrim(s.email)) LIKE '%@demo.avoqado.io')
       AND EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = org AND v.id <> NEW.id AND v.status <> 'LIVE_DEMO') THEN
      RAISE EXCEPTION 'USUARIO_DEMO_EN_NEGOCIO_REAL' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Aparte: `NEW."venueId"` sólo existe en StaffVenue, y una expresión que lo nombre truena en las otras tablas.
    IF TG_TABLE_NAME = 'StaffVenue' THEN
      IF NOT EXISTS (SELECT 1 FROM "Venue" v WHERE v.id = NEW."venueId" AND v.status = 'LIVE_DEMO') THEN
        RAISE EXCEPTION 'USUARIO_DEMO_EN_NEGOCIO_REAL' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = org AND v.status <> 'LIVE_DEMO') THEN
      RAISE EXCEPTION 'USUARIO_DEMO_EN_NEGOCIO_REAL' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "StaffVenue_usuarioDemo_guard" ON "StaffVenue";
CREATE TRIGGER "StaffVenue_usuarioDemo_guard"
BEFORE INSERT OR UPDATE OF "staffId", "venueId", role ON "StaffVenue"
FOR EACH ROW EXECUTE FUNCTION "usuarioDemoSoloEnDemosGuard"();

DROP TRIGGER IF EXISTS "StaffOrganization_usuarioDemo_guard" ON "StaffOrganization";
CREATE TRIGGER "StaffOrganization_usuarioDemo_guard"
BEFORE INSERT OR UPDATE OF "staffId", "organizationId" ON "StaffOrganization"
FOR EACH ROW EXECUTE FUNCTION "usuarioDemoSoloEnDemosGuard"();

DROP TRIGGER IF EXISTS "Venue_usuarioDemo_guard" ON "Venue";
CREATE TRIGGER "Venue_usuarioDemo_guard"
BEFORE INSERT OR UPDATE OF status, "organizationId" ON "Venue"
FOR EACH ROW EXECUTE FUNCTION "usuarioDemoSoloEnDemosGuard"();

DROP TRIGGER IF EXISTS "Staff_usuarioDemo_guard" ON "Staff";
CREATE TRIGGER "Staff_usuarioDemo_guard"
BEFORE UPDATE OF email ON "Staff"
FOR EACH ROW EXECUTE FUNCTION "usuarioDemoSoloEnDemosGuard"();
