-- Categoría eliminada (encargo de la nube bc1dcc, 19-nov-2026; lo vio Flautas Coyoacán con «EVENTO»): «Eliminar» una categoría
-- que sólo guarda productos ARCHIVADOS o una familia no puede borrar la fila (`Product.categoryId` y `ProductGroup.categoryId`
-- son RESTRICT) y hasta hoy sólo la apagaba: el dueño la seguía viendo apagada y con 0, igual que una que apagó a propósito.
--
-- Ahora, además de apagarla y sacarla de los menús (como hoy), se marca `deletedAt`: ESCONDIDA para el dueño. No cambia nada más:
-- para la caja, la tienda, los reportes y las reglas es la misma categoría apagada de hoy. Dos reglas en la base, por cualquier
-- camino (Prisma, SQL, uno nuevo):
-- 1. Prender una escondida la vuelve a mostrar (`active = true` ⇒ `deletedAt = NULL`), nunca una prendida escondida.
-- 2. Si un producto o una familia vuelve a vivir en ella (la importación o Shopify restauran un archivado, o una alta que ganó la
--    carrera al «Eliminar»), se vuelve a mostrar, APAGADA, igual que hoy: nunca queda algo vivo donde el dueño no lo encuentra.
--    Toma `FOR KEY SHARE` de la categoría antes de decidir: espera a un «Eliminar» en curso (que la tiene `FOR UPDATE`) y lee lo
--    que dejó; si llegó primero, el «Eliminar» espera por él y lo ve al contar.
--
-- Datos viejos: una que se «eliminó» antes de esto (quedó apagada) se esconde si la bitácora tiene su `MENU_CATEGORY_DELETED` y
-- su última escritura es la de ese «Eliminar»: `updatedAt` (reloj del servidor) ANTES del registro (reloj de la base, que lo
-- escribe milisegundos después), con 500 ms de holgura por la diferencia de relojes. Sin productos vivos ni menús. Cualquier
-- escritura posterior (prenderla y apagarla, «Reemplazar menú», el ruteo) la deja fuera: para esconder una apagada a propósito
-- habría que prenderla y apagarla en medio segundo. Las dos fechas son UTC en producción (Render); en una base local con otra
-- zona la ventana no coincide y no se esconde nada (nunca de más). Lo que quede fuera: basta volver a dar «Eliminar».
--
-- Columna nula sin default: en Postgres 11+ no reescribe la tabla.
--
-- Reversión (no se ejecuta):
--   DROP TRIGGER IF EXISTS "Product_categoria_eliminada_vuelve" ON "Product";
--   DROP TRIGGER IF EXISTS "ProductGroup_categoria_eliminada_vuelve" ON "ProductGroup";
--   DROP TRIGGER IF EXISTS "MenuCategory_prendida_se_ve" ON "MenuCategory";
--   DROP FUNCTION IF EXISTS "menuCategoryShowForLiveRow"();
--   DROP FUNCTION IF EXISTS "menuCategoryActiveIsShown"();
--   ALTER TABLE "MenuCategory" DROP COLUMN IF EXISTS "deletedAt";
SET LOCAL lock_timeout = '5s';

ALTER TABLE "MenuCategory" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Datos viejos (antes de los triggers).
UPDATE "MenuCategory" c
   SET "deletedAt" = l."createdAt"
  FROM (
    SELECT "entityId", max("createdAt") AS "createdAt"
      FROM "ActivityLog"
     WHERE "action" = 'MENU_CATEGORY_DELETED' AND "entity" = 'MenuCategory' AND "entityId" IS NOT NULL
     GROUP BY "entityId"
  ) l
 WHERE l."entityId" = c.id
   AND c."active" = false
   AND c."deletedAt" IS NULL
   AND c."updatedAt" BETWEEN l."createdAt" - interval '5 seconds' AND l."createdAt" + interval '500 milliseconds'
   AND NOT EXISTS (SELECT 1 FROM "Product" p WHERE p."categoryId" = c.id AND p."deletedAt" IS NULL)
   AND NOT EXISTS (SELECT 1 FROM "MenuCategoryAssignment" a WHERE a."categoryId" = c.id);

-- 1. Prendida ⇒ se ve.
CREATE OR REPLACE FUNCTION "menuCategoryActiveIsShown"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."active" AND NEW."deletedAt" IS NOT NULL THEN
    NEW."deletedAt" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "MenuCategory_prendida_se_ve" ON "MenuCategory";
CREATE TRIGGER "MenuCategory_prendida_se_ve"
BEFORE INSERT OR UPDATE OF "active", "deletedAt" ON "MenuCategory"
FOR EACH ROW EXECUTE FUNCTION "menuCategoryActiveIsShown"();

-- 2. Algo vivo dentro ⇒ se ve (apagada, como hoy).
CREATE OR REPLACE FUNCTION "menuCategoryShowForLiveRow"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deletedAt" IS NULL AND NEW."categoryId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD."deletedAt" IS NOT NULL OR OLD."categoryId" IS DISTINCT FROM NEW."categoryId") THEN
    -- El candado primero: con él, la instrucción de abajo (otra foto) ve el «Eliminar» que terminó mientras esperaba.
    PERFORM 1 FROM "MenuCategory" WHERE id = NEW."categoryId" FOR KEY SHARE;
    UPDATE "MenuCategory" SET "deletedAt" = NULL, "updatedAt" = (now() AT TIME ZONE 'UTC')
     WHERE id = NEW."categoryId" AND "deletedAt" IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "Product_categoria_eliminada_vuelve" ON "Product";
CREATE TRIGGER "Product_categoria_eliminada_vuelve"
AFTER INSERT OR UPDATE OF "deletedAt", "categoryId" ON "Product"
FOR EACH ROW EXECUTE FUNCTION "menuCategoryShowForLiveRow"();

DROP TRIGGER IF EXISTS "ProductGroup_categoria_eliminada_vuelve" ON "ProductGroup";
CREATE TRIGGER "ProductGroup_categoria_eliminada_vuelve"
AFTER INSERT OR UPDATE OF "deletedAt", "categoryId" ON "ProductGroup"
FOR EACH ROW EXECUTE FUNCTION "menuCategoryShowForLiveRow"();
