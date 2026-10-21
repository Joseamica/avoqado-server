-- Historial de precios de Product (spec 2026-10-17-precio-que-vio-el-cliente, Task 1). Cada precio con su intervalo
-- [validFrom, validTo) en UTC, para que el servidor sepa si el precio que vio el cliente fue real. Lo escriben SÓLO los
-- disparadores de abajo: cubren a todo escritor de "Product"."price" (Prisma, SQL directo, importaciones, apps viejas).
--
-- Reversión (no se ejecuta):
--   DROP TRIGGER IF EXISTS "Product_zz_historial_de_precio_ins" ON "Product";
--   DROP TRIGGER IF EXISTS "Product_zz_historial_de_precio_upd" ON "Product";
--   DROP FUNCTION IF EXISTS "productPriceHistoryWriter"();
--   DROP TABLE IF EXISTS "ProductPriceHistory";
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "ProductPriceHistory" (
    "id" BIGSERIAL NOT NULL,
    "venueId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "creadoEnTx" BIGINT NOT NULL DEFAULT ((pg_current_xact_id())::text)::bigint,

    CONSTRAINT "ProductPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductPriceHistory_productId_validFrom_idx" ON "ProductPriceHistory"("productId", "validFrom");

-- AddForeignKey
ALTER TABLE "ProductPriceHistory" ADD CONSTRAINT "ProductPriceHistory_productId_venueId_fkey" FOREIGN KEY ("productId", "venueId") REFERENCES "Product"("id", "venueId") ON DELETE CASCADE ON UPDATE CASCADE;

-- A lo más UN precio abierto por producto. Prisma no expresa índices parciales: vive sólo aquí.
CREATE UNIQUE INDEX "ProductPriceHistory_una_abierta" ON "ProductPriceHistory"("productId") WHERE "validTo" IS NULL;

-- Todo escritor de Product.price pasa por aquí. DIFERIDO: corre al final de la transacción, así el cambio queda fechado
-- cuando se vuelve visible (una importación de 2 min no deja «terminado» un precio que el catálogo todavía mostraba).
-- Varias actualizaciones de la misma fila en una transacción encolan un evento cada una y corren en orden al confirmar,
-- cada una con el NEW de su evento. Un precio intermedio nunca se publicó: si la fila abierta nació en ESTA transacción
-- (la escribió un evento anterior de esta misma confirmación), se corrige en su lugar en vez de dejar una fila de largo
-- cero que la búsqueda leería como «vigente». Así 45→50→55 deja 45 cerrado y 55 abierto, e INSERT + UPDATE una sola fila.
CREATE OR REPLACE FUNCTION "productPriceHistoryWriter"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ahora timestamp(3) := (clock_timestamp() AT TIME ZONE 'UTC'); -- columnas sin zona: Prisma escribe UTC
  negocio text;
  abierta record;
BEGIN
  -- Corre al confirmar: si la misma transacción ya borró el producto no hay nada que fechar, y el INSERT chocaría con la
  -- llave foránea y tumbaría la transacción de quien escribe. El negocio se lee de la fila VIGENTE (por si también cambió).
  SELECT "venueId" INTO negocio FROM "Product" WHERE "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT h."id", h."creadoEnTx", h."validFrom" INTO abierta FROM "ProductPriceHistory" h WHERE h."productId" = NEW."id" AND h."validTo" IS NULL;
  IF FOUND THEN
    -- ¿Nació en esta transacción? Por "creadoEnTx" (default de la columna = xid8 de nivel superior, con época: no se
    -- repite y cubre un SAVEPOINT), NUNCA por xmin: la cascada de la FK al cambiar el negocio del producto reescribe la
    -- abierta de una transacción anterior y le pone el xmin actual, pero no toca "creadoEnTx".
    IF abierta."creadoEnTx" = (pg_current_xact_id())::text::bigint THEN
      UPDATE "ProductPriceHistory" SET "price" = NEW."price", "venueId" = negocio WHERE "id" = abierta."id";
      RETURN NULL;
    END IF;
    ahora := GREATEST(ahora, abierta."validFrom"); -- si el reloj retrocede: nunca un intervalo negativo, y siguen contiguos
    UPDATE "ProductPriceHistory" SET "validTo" = ahora WHERE "id" = abierta."id";
  END IF;
  INSERT INTO "ProductPriceHistory" ("venueId", "productId", "price", "validFrom") VALUES (negocio, NEW."id", NEW."price", ahora);
  RETURN NULL;
END; $$;

DROP TRIGGER IF EXISTS "Product_zz_historial_de_precio_ins" ON "Product";
CREATE CONSTRAINT TRIGGER "Product_zz_historial_de_precio_ins" AFTER INSERT ON "Product"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "productPriceHistoryWriter"();
DROP TRIGGER IF EXISTS "Product_zz_historial_de_precio_upd" ON "Product";
CREATE CONSTRAINT TRIGGER "Product_zz_historial_de_precio_upd" AFTER UPDATE OF "price" ON "Product"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD."price" IS DISTINCT FROM NEW."price")
  EXECUTE FUNCTION "productPriceHistoryWriter"();

-- RELLENO: el precio vigente de cada producto, abierto desde HOY. No se inventa historia anterior (no se conoce).
INSERT INTO "ProductPriceHistory" ("venueId", "productId", "price", "validFrom")
SELECT p."venueId", p."id", p."price", (NOW() AT TIME ZONE 'UTC') FROM "Product" p
WHERE NOT EXISTS (SELECT 1 FROM "ProductPriceHistory" h WHERE h."productId" = p."id" AND h."validTo" IS NULL);
