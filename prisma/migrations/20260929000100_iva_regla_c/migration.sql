-- IVA por producto, plan 4b · regla C (opción C del founder, 29-sep; mecanismo: marca pegajosa, auditoría de Codex): un producto
-- con "ajusteDeliveryAlgunaVez" no cambia de IVA en ninguna dirección; se crea un producto nuevo. "productIvaTratamientoGuard" se
-- reemplaza con su cuerpo VIGENTE (20260928000300_iva_sin_repeatable_read) copiado verbatim más SÓLO el bloque de la regla C,
-- después de la barrera ≠ IVA_16 (con la bandera apagada manda IVA_POR_PRODUCTO_APAGADO). Los CREATE TRIGGER no cambian:
-- CREATE OR REPLACE FUNCTION basta. "venueTrasladoIvaGuard" no se toca.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "productIvaTratamientoGuard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  modo text := TG_ARGV[0];
  derivado "IvaTratamiento";
  heredado "IvaTratamiento";
  encendido boolean;
  org text;
  org_confirmada text;
BEGIN
  IF modo = 'insert' THEN
    -- 0) El DEFAULT 'IVA_16' llega igual que una elección. Si la tupla del INSERT NO deriva a IVA_16, el
    --    escritor es viejo y mandó su tupla: se ignora el default y se deriva de la tupla (Ruling R2).
    IF NEW."ivaTratamiento" = 'IVA_16'
       AND "derivarIvaTratamiento"(NEW."taxRate", NEW."objetoImp") IS DISTINCT FROM 'IVA_16' THEN
      NEW."ivaTratamiento" := NULL;
    END IF;

    -- El INSERT nunca revisa contradicción: un DEFAULT de la base es indistinguible de una elección.
    IF NEW."ivaTratamiento" IS NOT NULL THEN
      NEW."objetoImp" := CASE NEW."ivaTratamiento"
        WHEN 'NO_OBJETO' THEN '01' WHEN 'BLOQUEADO_03' THEN '03' WHEN 'BLOQUEADO_04' THEN '04' ELSE '02' END;
      NEW."taxRate" := CASE NEW."ivaTratamiento"
        WHEN 'IVA_16' THEN 0.16 WHEN 'IVA_8' THEN 0.08 WHEN 'IVA_0' THEN 0 WHEN 'EXENTO' THEN 0 WHEN 'NO_OBJETO' THEN 0
        ELSE NEW."taxRate" END;
    ELSE
      derivado := "derivarIvaTratamiento"(NEW."taxRate", NEW."objetoImp");
      IF derivado IS NULL THEN
        RAISE EXCEPTION 'IVA_TRATAMIENTO_CONTRADICTORIO' USING ERRCODE = 'P0001';
      END IF;
      NEW."ivaTratamiento" := derivado;
    END IF;

  ELSIF modo = 'explicito' THEN
    -- Dispara siempre que "ivaTratamiento" esté en la lista SET (aunque el valor no cambie: es un trigger
    -- "BEFORE UPDATE OF", que en Postgres se activa por ser OBJETIVO del SET, no por el valor). El enum manda.
    IF NEW."taxRate" IS DISTINCT FROM OLD."taxRate" OR NEW."objetoImp" IS DISTINCT FROM OLD."objetoImp" THEN
      -- La tupla TAMBIÉN cambió respecto a OLD: debe coincidir EXACTO con lo que el enum exige, sin excepción
      -- para EXENTO/BLOQUEADO_03/BLOQUEADO_04 (esa exención blanket es justo lo que dejaba pasar el hueco).
      IF NOT "tuplaCoincideConTratamiento"(NEW."ivaTratamiento", NEW."taxRate", NEW."objetoImp") THEN
        RAISE EXCEPTION 'IVA_TRATAMIENTO_CONTRADICTORIO' USING ERRCODE = 'P0001';
      END IF;
    ELSE
      -- La tupla no cambió respecto a OLD: se reescribe desde el enum (como hoy).
      NEW."objetoImp" := CASE NEW."ivaTratamiento"
        WHEN 'NO_OBJETO' THEN '01' WHEN 'BLOQUEADO_03' THEN '03' WHEN 'BLOQUEADO_04' THEN '04' ELSE '02' END;
      NEW."taxRate" := CASE NEW."ivaTratamiento"
        WHEN 'IVA_16' THEN 0.16 WHEN 'IVA_8' THEN 0.08 WHEN 'IVA_0' THEN 0 WHEN 'EXENTO' THEN 0 WHEN 'NO_OBJETO' THEN 0
        ELSE NEW."taxRate" END;
    END IF;

  ELSIF modo = 'tupla' THEN
    IF NEW."ivaTratamiento" IS DISTINCT FROM OLD."ivaTratamiento" THEN
      -- El trigger explícito ya corrió en esta misma sentencia (orden alfabético: 1_explicito antes que
      -- 2_tupla). Sólo revalida la MISMA coherencia exacta; no repite ninguna otra rama.
      IF NOT "tuplaCoincideConTratamiento"(NEW."ivaTratamiento", NEW."taxRate", NEW."objetoImp") THEN
        RAISE EXCEPTION 'IVA_TRATAMIENTO_CONTRADICTORIO' USING ERRCODE = 'P0001';
      END IF;
    ELSE
      -- Escritor viejo: sólo tocó (o no tocó) la tupla, el enum no cambió. Si la tupla tampoco cambió,
      -- se conserva el tratamiento; si cambió, se deriva (NULL en la derivación = contradicción).
      IF OLD."ivaTratamiento" IS NOT NULL
         AND NEW."taxRate" IS NOT DISTINCT FROM OLD."taxRate" AND NEW."objetoImp" IS NOT DISTINCT FROM OLD."objetoImp" THEN
        NEW."ivaTratamiento" := OLD."ivaTratamiento";
      ELSE
        derivado := "derivarIvaTratamiento"(NEW."taxRate", NEW."objetoImp");
        IF derivado IS NULL THEN
          RAISE EXCEPTION 'IVA_TRATAMIENTO_CONTRADICTORIO' USING ERRCODE = 'P0001';
        END IF;
        NEW."ivaTratamiento" := derivado;
      END IF;
    END IF;
  END IF;

  -- Barrera: ≠ IVA_16 sólo con el negocio encendido, salvo lo HEREDADO por ESA fila. Corre en TODOS los modos
  -- (INSERT, explicito, tupla) — es idempotente y es la MISMA regla sin importar quién la disparó.
  IF NEW."ivaTratamiento" <> 'IVA_16' THEN
    heredado := CASE
      WHEN TG_OP = 'INSERT' THEN NULL
      WHEN OLD."ivaTratamiento" IS NOT NULL THEN OLD."ivaTratamiento"
      ELSE "derivarIvaTratamiento"(OLD."taxRate", OLD."objetoImp")  -- backfill: lo que su tupla previa ya decía
    END;
    IF heredado IS DISTINCT FROM NEW."ivaTratamiento" THEN
      SELECT EXISTS (SELECT 1 FROM "VenueIvaPorProducto" v WHERE v."venueId" = NEW."venueId") INTO encendido;
      IF NOT encendido THEN
        RAISE EXCEPTION 'IVA_POR_PRODUCTO_APAGADO' USING ERRCODE = 'P0001';
      END IF;
      -- Plan 4 · inversa contable: una organización —o un negocio— con contabilidad no puede tener productos ≠ IVA_16.
      -- Orden global organización → negocio (esta sentencia ya tiene la fila del producto; R10). Sólo en este camino
      -- (el producto CAMBIA a ≠ IVA_16); lo heredado sin cambio no toma candados. Si la app ya los tomó, son no-ops.
      SELECT v."organizationId" INTO org FROM "Venue" v WHERE v.id = NEW."venueId";
      PERFORM 1 FROM "Organization" o WHERE o.id = org FOR NO KEY UPDATE;
      SELECT v."organizationId" INTO org_confirmada FROM "Venue" v WHERE v.id = NEW."venueId" FOR SHARE;
      IF org_confirmada IS DISTINCT FROM org THEN
        RAISE EXCEPTION 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION' USING ERRCODE = 'P0001';
      END IF;
      -- Ola 2: REPEATABLE READ no tiene SSI y su foto vieja no vería una póliza recién confirmada (sólo SQL directo).
      IF current_setting('transaction_isolation') = 'repeatable read' THEN
        RAISE EXCEPTION 'IVA_REPEATABLE_READ_NO_ADMITIDO' USING ERRCODE = 'P0001';
      END IF;
      IF EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."organizationId" = org)
         OR EXISTS (SELECT 1 FROM "JournalEntry" j WHERE j."venueId" = NEW."venueId")
         OR EXISTS (SELECT 1 FROM "AccountingPeriodLock" l WHERE l."organizationId" = org) THEN
        RAISE EXCEPTION 'IVA_CONTABILIDAD_CON_HISTORIA' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    -- Marca pegajosa de la organización (nunca se apaga en la v1).
    UPDATE "Organization" o SET "ivaMixtoAlgunaVez" = true
      FROM "Venue" v WHERE v."id" = NEW."venueId" AND o."id" = v."organizationId" AND o."ivaMixtoAlgunaVez" = false;
  END IF;

  -- Plan 4b · regla C: con la marca encendida, el tratamiento no cambia. La marca vive en la MISMA fila que este UPDATE escribe:
  -- en READ COMMITTED el UPDATE espera a la conciliación que la tiene tomada y relee la fila; en REPEATABLE READ o SERIALIZABLE
  -- una fila escrita después de su foto da 40001 antes de llegar aquí. Ninguna foto vieja la esconde. Un INSERT nunca entra.
  IF TG_OP = 'UPDATE' THEN
    IF OLD."ajusteDeliveryAlgunaVez" AND NEW."ivaTratamiento" IS DISTINCT FROM OLD."ivaTratamiento" THEN
      RAISE EXCEPTION 'IVA_PRODUCTO_CON_AJUSTE_DE_DELIVERY' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
