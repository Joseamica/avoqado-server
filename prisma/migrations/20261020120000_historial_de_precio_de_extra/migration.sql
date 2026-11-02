-- Historial de precios de Modifier (extras) — hermano de 20261017150000_historial_de_precio_de_producto (spec cobrar-sin-red-tpv,
-- Task S2). Cada precio de un extra con su intervalo [validFrom, validTo) en UTC, para que el servidor sepa si el precio de
-- extra que vio el cliente fue real. Lo escriben SÓLO los disparadores de abajo: cubren a todo escritor de
-- "Modifier"."price" (Prisma, SQL directo, importaciones, apps viejas).
-- Diferencia con Product: "Modifier" no tiene "venueId". El disparador lo lee de "ModifierGroup"."venueId" por "groupId",
-- y la llave foránea es sólo al extra.
--
-- Reversión (no se ejecuta):
--   DROP TRIGGER IF EXISTS "Modifier_zz_historial_de_precio_ins" ON "Modifier";
--   DROP TRIGGER IF EXISTS "Modifier_zz_historial_de_precio_upd" ON "Modifier";
--   DROP FUNCTION IF EXISTS "modifierPriceHistoryWriter"();
--   DROP TABLE IF EXISTS "ModifierPriceHistory";
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "ModifierPriceHistory" (
    "id" BIGSERIAL NOT NULL,
    "venueId" TEXT NOT NULL,
    "modifierId" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "creadoEnTx" BIGINT NOT NULL DEFAULT ((pg_current_xact_id())::text)::bigint,

    CONSTRAINT "ModifierPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModifierPriceHistory_modifierId_validFrom_idx" ON "ModifierPriceHistory"("modifierId", "validFrom");

-- AddForeignKey
ALTER TABLE "ModifierPriceHistory" ADD CONSTRAINT "ModifierPriceHistory_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "Modifier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A lo más UN precio abierto por extra. Prisma no expresa índices parciales: vive sólo aquí.
CREATE UNIQUE INDEX "ModifierPriceHistory_una_abierta" ON "ModifierPriceHistory"("modifierId") WHERE "validTo" IS NULL;

-- Todo escritor de Modifier.price pasa por aquí. DIFERIDO: corre al final de la transacción, así el cambio queda fechado
-- cuando se vuelve visible (una importación de 2 min no deja «terminado» un precio que el catálogo todavía mostraba).
-- Varias actualizaciones de la misma fila en una transacción encolan un evento cada una y corren en orden al confirmar,
-- cada una con el NEW de su evento. Un precio intermedio nunca se publicó: si la fila abierta nació en ESTA transacción
-- (la escribió un evento anterior de esta misma confirmación), se corrige en su lugar en vez de dejar una fila de largo
-- cero que la búsqueda leería como «vigente». Así 10→15→20 deja 10 cerrado y 20 abierto, e INSERT + UPDATE una sola fila.
CREATE OR REPLACE FUNCTION "modifierPriceHistoryWriter"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ahora timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC'); -- columnas sin zona: Prisma escribe UTC
  negocio text;
  abierta record;
BEGIN
  -- Corre al confirmar: si la misma transacción ya borró el extra (o su grupo) no hay nada que fechar, y el INSERT chocaría
  -- con la llave foránea y tumbaría la transacción de quien escribe. El negocio se lee del grupo VIGENTE del extra.
  SELECT g."venueId" INTO negocio FROM "Modifier" m JOIN "ModifierGroup" g ON g."id" = m."groupId" WHERE m."id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT h."id", h."creadoEnTx", h."validFrom" INTO abierta FROM "ModifierPriceHistory" h WHERE h."modifierId" = NEW."id" AND h."validTo" IS NULL;
  IF FOUND THEN
    -- ¿Nació en esta transacción? Por "creadoEnTx" (default de la columna = xid8 de nivel superior, con época: no se
    -- repite y cubre un SAVEPOINT), NUNCA por xmin: cualquier reescritura de la fila le pone el xmin actual, pero no toca
    -- "creadoEnTx".
    IF abierta."creadoEnTx" = (pg_current_xact_id())::text::bigint THEN
      UPDATE "ModifierPriceHistory" SET "price" = NEW."price", "venueId" = negocio WHERE "id" = abierta."id";
      RETURN NULL;
    END IF;
    ahora := GREATEST(ahora, abierta."validFrom"); -- si el reloj retrocede: nunca un intervalo negativo, y siguen contiguos
    UPDATE "ModifierPriceHistory" SET "validTo" = ahora WHERE "id" = abierta."id";
  END IF;
  INSERT INTO "ModifierPriceHistory" ("venueId", "modifierId", "price", "validFrom") VALUES (negocio, NEW."id", NEW."price", ahora);
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS "Modifier_zz_historial_de_precio_ins" ON "Modifier";
CREATE CONSTRAINT TRIGGER "Modifier_zz_historial_de_precio_ins" AFTER INSERT ON "Modifier"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "modifierPriceHistoryWriter"();
DROP TRIGGER IF EXISTS "Modifier_zz_historial_de_precio_upd" ON "Modifier";
CREATE CONSTRAINT TRIGGER "Modifier_zz_historial_de_precio_upd" AFTER UPDATE OF "price" ON "Modifier"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD."price" IS DISTINCT FROM NEW."price")
  EXECUTE FUNCTION "modifierPriceHistoryWriter"();

-- RELLENO: el precio vigente de cada extra, abierto desde HOY. No se inventa historia anterior (no se conoce).
INSERT INTO "ModifierPriceHistory" ("venueId", "modifierId", "price", "validFrom")
SELECT g."venueId", m."id", m."price", (NOW() AT TIME ZONE 'UTC') FROM "Modifier" m JOIN "ModifierGroup" g ON g."id" = m."groupId"
WHERE NOT EXISTS (SELECT 1 FROM "ModifierPriceHistory" h WHERE h."modifierId" = m."id" AND h."validTo" IS NULL);
