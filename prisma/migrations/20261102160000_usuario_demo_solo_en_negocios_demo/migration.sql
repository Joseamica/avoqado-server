-- hz:f26b3afc:D5 — los usuarios demo (`@demo.avoqado.io`) tienen contraseña pública (va en el PDF de prospectos): sólo
-- pueden estar en negocios demo (`LIVE_DEMO`) y en organizaciones sin negocios reales. La barrera vive en la BASE, como la
-- del traslado de IVA: cubre todo camino que escriba membresías (SUPERADMIN, panel, alta, sync, scripts) y el SQL directo.
-- El código USUARIO_DEMO_EN_NEGOCIO_REAL lo traduce a un 400 el manejador general (`esUsuarioDemoEnNegocioReal`).
-- ponytail: sin candado entre las dos tablas; una carrera entre el SUPERADMIN y otra persona en el mismo segundo no se cubre.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "usuarioDemoSoloEnDemosGuard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'StaffVenue' THEN
    IF EXISTS (SELECT 1 FROM "Staff" s WHERE s.id = NEW."staffId" AND lower(btrim(s.email)) LIKE '%@demo.avoqado.io')
       AND NOT EXISTS (SELECT 1 FROM "Venue" v WHERE v.id = NEW."venueId" AND v.status = 'LIVE_DEMO') THEN
      RAISE EXCEPTION 'USUARIO_DEMO_EN_NEGOCIO_REAL' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'StaffOrganization' THEN
    IF EXISTS (SELECT 1 FROM "Staff" s WHERE s.id = NEW."staffId" AND lower(btrim(s.email)) LIKE '%@demo.avoqado.io')
       AND EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = NEW."organizationId" AND v.status <> 'LIVE_DEMO') THEN
      RAISE EXCEPTION 'USUARIO_DEMO_EN_NEGOCIO_REAL' USING ERRCODE = 'P0001';
    END IF;
  ELSIF TG_TABLE_NAME = 'Venue' THEN
    -- Un negocio real (nuevo, que deja de ser demo o que llega a otra organización) no puede tener un usuario demo adentro.
    IF NEW.status <> 'LIVE_DEMO' AND (
         EXISTS (SELECT 1 FROM "StaffVenue" sv JOIN "Staff" s ON s.id = sv."staffId"
                  WHERE sv."venueId" = NEW.id AND lower(btrim(s.email)) LIKE '%@demo.avoqado.io')
      OR EXISTS (SELECT 1 FROM "StaffOrganization" so JOIN "Staff" s ON s.id = so."staffId"
                  WHERE so."organizationId" = NEW."organizationId" AND lower(btrim(s.email)) LIKE '%@demo.avoqado.io')) THEN
      RAISE EXCEPTION 'USUARIO_DEMO_EN_NEGOCIO_REAL' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "StaffVenue_usuarioDemo_guard" ON "StaffVenue";
CREATE TRIGGER "StaffVenue_usuarioDemo_guard"
BEFORE INSERT OR UPDATE OF "staffId", "venueId" ON "StaffVenue"
FOR EACH ROW EXECUTE FUNCTION "usuarioDemoSoloEnDemosGuard"();

DROP TRIGGER IF EXISTS "StaffOrganization_usuarioDemo_guard" ON "StaffOrganization";
CREATE TRIGGER "StaffOrganization_usuarioDemo_guard"
BEFORE INSERT OR UPDATE OF "staffId", "organizationId" ON "StaffOrganization"
FOR EACH ROW EXECUTE FUNCTION "usuarioDemoSoloEnDemosGuard"();

DROP TRIGGER IF EXISTS "Venue_usuarioDemo_guard" ON "Venue";
CREATE TRIGGER "Venue_usuarioDemo_guard"
BEFORE INSERT OR UPDATE OF status, "organizationId" ON "Venue"
FOR EACH ROW EXECUTE FUNCTION "usuarioDemoSoloEnDemosGuard"();
