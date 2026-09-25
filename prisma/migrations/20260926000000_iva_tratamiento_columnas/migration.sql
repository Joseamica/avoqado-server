-- IVA por producto (plan 1, paso 1 de 3): columnas nullable + tabla de bandera + trigger. Transacción corta, sin backfill.
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

CREATE OR REPLACE FUNCTION "productIvaTratamientoGuard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  derivado "IvaTratamiento";
  heredado "IvaTratamiento";
  encendido boolean;
BEGIN
  -- 0) El DEFAULT 'IVA_16' (Tarea 4) llega igual que una elección. Si la tupla del INSERT NO deriva a IVA_16, el
  --    escritor es viejo y mandó su tupla: se ignora el default y se deriva de la tupla (Ruling R2 del ledger).
  IF TG_OP = 'INSERT' AND NEW."ivaTratamiento" = 'IVA_16'
     AND "derivarIvaTratamiento"(NEW."taxRate", NEW."objetoImp") IS DISTINCT FROM 'IVA_16' THEN
    NEW."ivaTratamiento" := NULL;
  END IF;

  -- 1) ¿El escritor eligió el tratamiento? (INSERT con valor, o UPDATE que lo cambió). Si sí, la tupla sale de él.
  IF NEW."ivaTratamiento" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."ivaTratamiento" IS DISTINCT FROM OLD."ivaTratamiento") THEN
    -- Si además mandó una tupla distinta a la que ese tratamiento exige, es contradicción.
    IF TG_OP = 'UPDATE'
       AND (NEW."taxRate" IS DISTINCT FROM OLD."taxRate" OR NEW."objetoImp" IS DISTINCT FROM OLD."objetoImp")
       AND NEW."ivaTratamiento" NOT IN ('EXENTO','BLOQUEADO_03','BLOQUEADO_04')
       AND "derivarIvaTratamiento"(NEW."taxRate", NEW."objetoImp") IS DISTINCT FROM NEW."ivaTratamiento" THEN
      RAISE EXCEPTION 'IVA_TRATAMIENTO_CONTRADICTORIO' USING ERRCODE = 'P0001';
    END IF;
    NEW."objetoImp" := CASE NEW."ivaTratamiento"
      WHEN 'NO_OBJETO' THEN '01' WHEN 'BLOQUEADO_03' THEN '03' WHEN 'BLOQUEADO_04' THEN '04' ELSE '02' END;
    NEW."taxRate" := CASE NEW."ivaTratamiento"
      WHEN 'IVA_16' THEN 0.16 WHEN 'IVA_8' THEN 0.08 WHEN 'IVA_0' THEN 0 WHEN 'EXENTO' THEN 0 WHEN 'NO_OBJETO' THEN 0
      ELSE NEW."taxRate" END;
  ELSE
    -- 2) Escritor viejo: sólo tocó (o no tocó) la tupla. Si la tupla no cambió, se conserva el tratamiento.
    IF TG_OP = 'UPDATE' AND OLD."ivaTratamiento" IS NOT NULL
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

  -- 3) Barrera: ≠ IVA_16 sólo con el negocio encendido, salvo lo HEREDADO por ESA fila.
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
CREATE TRIGGER "Product_ivaTratamiento_guard"
BEFORE INSERT OR UPDATE OF "ivaTratamiento", "taxRate", "objetoImp" ON "Product"
FOR EACH ROW EXECUTE FUNCTION "productIvaTratamientoGuard"();
