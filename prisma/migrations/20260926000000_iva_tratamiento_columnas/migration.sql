-- IVA por producto (plan 1, paso 1 de 3): columnas nullable + tabla de bandera + trigger. Transacción corta, sin backfill.
--
-- Fix round 1 (Ruling R5): el guard vivía en UN solo trigger BEFORE INSERT OR UPDATE OF "ivaTratamiento",
-- "taxRate", "objetoImp", y plpgsql no puede ver la lista SET de un UPDATE — así que "el enum se re-envió"
-- se veía igual que "el enum no se envió", y por eso la contradicción sólo se revisaba cuando el enum
-- CAMBIABA de valor, y ni eso: EXENTO/BLOQUEADO_03/BLOQUEADO_04 estaban exentos de la revisión por completo.
-- Eso dejaba pasar en silencio un SET que afirma un enum y a la vez manda una tupla que lo contradice.
--
-- El arreglo parte el UPDATE en DOS triggers columnares, cada uno atado a "BEFORE UPDATE OF" un grupo de
-- columnas distinto — eso SÍ lo puede ver Postgres (dispara si la columna es OBJETIVO del SET, sin
-- importar si el valor cambia), aunque plpgsql no pueda leer la lista directamente:
--   1_explicito (OF "ivaTratamiento") dispara siempre que el enum esté en el SET, y el enum manda.
--   2_tupla     (OF "taxRate","objetoImp") dispara siempre que la tupla esté en el SET; si el enum TAMBIÉN
--               cambió en esta misma sentencia (1_explicito ya corrió, orden alfabético), sólo revalida
--               coherencia. Si el enum no cambió, es la ruta del escritor viejo (deriva o conserva).
-- El INSERT sigue en su propio trigger, sin revisión de contradicción: un DEFAULT de la base es
-- indistinguible de una elección explícita en ese momento.
SET lock_timeout = '5s';

DO $$ BEGIN
  CREATE TYPE "IvaTratamiento" AS ENUM ('IVA_16','IVA_8','IVA_0','EXENTO','NO_OBJETO','BLOQUEADO_03','BLOQUEADO_04');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "ivaTratamiento" "IvaTratamiento";
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "ivaMixtoAlgunaVez" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "VenueIvaPorProducto" (
  "venueId" TEXT PRIMARY KEY REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "habilitadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "habilitadoPorStaffId" TEXT
);

-- Réplica EXACTA de tratamientoDesdeTupla (src/services/fiscal/ivaTratamiento.ts). NULL = contradicción.
CREATE OR REPLACE FUNCTION "derivarIvaTratamiento"(tasa numeric, objeto text) RETURNS "IvaTratamiento"
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN objeto = '01' THEN 'NO_OBJETO'::"IvaTratamiento"
    WHEN objeto = '03' THEN 'BLOQUEADO_03'::"IvaTratamiento"
    WHEN objeto = '04' THEN 'BLOQUEADO_04'::"IvaTratamiento"
    WHEN objeto = '02' AND round(tasa, 4) = 0.16 THEN 'IVA_16'::"IvaTratamiento"
    WHEN objeto = '02' AND round(tasa, 4) = 0.08 THEN 'IVA_8'::"IvaTratamiento"
    WHEN objeto = '02' AND round(tasa, 4) = 0    THEN 'IVA_0'::"IvaTratamiento"
    ELSE NULL
  END
$$;

-- Réplica EXACTA de tuplaDesdeTratamiento (src/services/fiscal/ivaTratamiento.ts): ¿la tupla (tasa, objeto)
-- es EXACTAMENTE la que ese tratamiento exige? BLOQUEADO_03/04 sólo fijan objetoImp — la tasa es libre
-- (tuplaDesdeTratamiento las deja en aCentesimas(tasaActual), la tasa vigente, no una constante).
CREATE OR REPLACE FUNCTION "tuplaCoincideConTratamiento"(trat "IvaTratamiento", tasa numeric, objeto text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE trat
    WHEN 'IVA_16' THEN round(tasa, 4) = 0.16 AND objeto = '02'
    WHEN 'IVA_8' THEN round(tasa, 4) = 0.08 AND objeto = '02'
    WHEN 'IVA_0' THEN round(tasa, 4) = 0 AND objeto = '02'
    WHEN 'EXENTO' THEN round(tasa, 4) = 0 AND objeto = '02'
    WHEN 'NO_OBJETO' THEN round(tasa, 4) = 0 AND objeto = '01'
    WHEN 'BLOQUEADO_03' THEN objeto = '03'
    WHEN 'BLOQUEADO_04' THEN objeto = '04'
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION "productIvaTratamientoGuard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  modo text := TG_ARGV[0];
  derivado "IvaTratamiento";
  heredado "IvaTratamiento";
  encendido boolean;
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
    END IF;
    -- Marca pegajosa de la organización (nunca se apaga en la v1).
    UPDATE "Organization" o SET "ivaMixtoAlgunaVez" = true
      FROM "Venue" v WHERE v."id" = NEW."venueId" AND o."id" = v."organizationId" AND o."ivaMixtoAlgunaVez" = false;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Product_ivaTratamiento_guard" ON "Product";

DROP TRIGGER IF EXISTS "Product_ivaTratamiento_ins" ON "Product";
CREATE TRIGGER "Product_ivaTratamiento_ins"
BEFORE INSERT ON "Product"
FOR EACH ROW EXECUTE FUNCTION "productIvaTratamientoGuard"('insert');

DROP TRIGGER IF EXISTS "Product_ivaTratamiento_1_explicito" ON "Product";
CREATE TRIGGER "Product_ivaTratamiento_1_explicito"
BEFORE UPDATE OF "ivaTratamiento" ON "Product"
FOR EACH ROW EXECUTE FUNCTION "productIvaTratamientoGuard"('explicito');

DROP TRIGGER IF EXISTS "Product_ivaTratamiento_2_tupla" ON "Product";
CREATE TRIGGER "Product_ivaTratamiento_2_tupla"
BEFORE UPDATE OF "taxRate", "objetoImp" ON "Product"
FOR EACH ROW EXECUTE FUNCTION "productIvaTratamientoGuard"('tupla');
