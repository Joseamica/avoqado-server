-- IVA por producto, plan 4 (Tarea 2): la BASE impone la inversa contable, los sellos marcan y la marca no se apaga.
--
-- 1. Índice JournalEntry(venueId): la historia contable viaja con el NEGOCIO (una póliza suya en otra organización cuenta).
-- 2. "productIvaTratamientoGuard" se reemplaza con su cuerpo vigente (20260926000000_iva_tratamiento_columnas, ninguna
--    migración posterior lo tocó) más el bloque inverso: un producto que CAMBIA a ≠ IVA_16 en una organización —o un
--    negocio— con pólizas o periodos cerrados se rechaza con IVA_CONTABILIDAD_CON_HISTORIA. Los tres CREATE TRIGGER de
--    Product no cambian: CREATE OR REPLACE FUNCTION basta.
-- 3. "OrderItem_selloIva_marca": un renglón que sella ≠ IVA_16 marca a su organización (sólo marca; nunca frena la factura).
-- 4. "Organization_ivaMixto_pegajosa": la marca pasa de falso a verdadero, nunca al revés.
-- La inicialización de la marca va en la migración siguiente, cuando estos triggers ya existen.
SET LOCAL lock_timeout = '5s';

-- CreateIndex
CREATE INDEX "JournalEntry_venueId_idx" ON "JournalEntry"("venueId");

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

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "orderItemSelloIvaMarca"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Plan 4: un renglón que SELLA con IVA ≠ 16 % marca a su organización (pegajosa). Sólo marca: una razón contable
  -- nunca frena una factura (R3). No toca el negocio (esta transacción ya tiene la orden; un Order → Venue nuevo rompería
  -- el orden negocio → orden). Por la invariante, casi siempre no encuentra fila que cambiar y no toma candado.
  UPDATE "Organization" o SET "ivaMixtoAlgunaVez" = true
    FROM "Order" ord JOIN "Venue" v ON v.id = ord."venueId"
   WHERE ord.id = NEW."orderId" AND o.id = v."organizationId" AND o."ivaMixtoAlgunaVez" = false;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "OrderItem_selloIva_marca" ON "OrderItem";
CREATE TRIGGER "OrderItem_selloIva_marca"
AFTER INSERT OR UPDATE OF "ivaTratamiento" ON "OrderItem"
FOR EACH ROW WHEN (NEW."ivaTratamiento" IS NOT NULL AND NEW."ivaTratamiento" <> 'IVA_16')
EXECUTE FUNCTION "orderItemSelloIvaMarca"();

CREATE OR REPLACE FUNCTION "organizationIvaMixtoPegajosa"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."ivaMixtoAlgunaVez" AND NOT NEW."ivaMixtoAlgunaVez" THEN
    RAISE EXCEPTION 'IVA_MARCA_PEGAJOSA' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Organization_ivaMixto_pegajosa" ON "Organization";
CREATE TRIGGER "Organization_ivaMixto_pegajosa"
BEFORE UPDATE OF "ivaMixtoAlgunaVez" ON "Organization"
FOR EACH ROW EXECUTE FUNCTION "organizationIvaMixtoPegajosa"();
