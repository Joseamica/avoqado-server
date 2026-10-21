-- Variantes de producto, bloque 5 (Shopify e importación). Tres cambios chicos y sin mover datos:
--  1) ShopifyVariantLink.shopifyCatalog: lo que Shopify dice del catálogo de esa variante (título, opciones, fotos).
--  2) El único de ProductGroup(venueId, source, externalId) pasa a ser PARCIAL (sólo entre familias vivas): una familia
--     archivada ya no impide volver a crear otra con el mismo externalId. externalId lo usan las familias SHOPIFY (GID del
--     producto de Shopify) y las MANUAL creadas desde un CSV de Shopify (el Handle).
--  3) Se quita el único completo; el parcial se crea en la misma transacción, así que no queda un instante sin protección.
-- Si un candado vence (lock_timeout), `migrate deploy` marca la migración como fallida (P3009):
-- `prisma migrate resolve --rolled-back 20261018120000_variantes_bloque5` y reintentar en un horario de poco tráfico.
--
-- Reversión (no se ejecuta; falla si ya hay una viva y una archivada con el mismo externalId):
--   DROP INDEX "ProductGroup_venueId_source_externalId_vivo_key";
--   CREATE UNIQUE INDEX "ProductGroup_venueId_source_externalId_key" ON "ProductGroup"("venueId", "source", "externalId");
--   ALTER TABLE "ShopifyVariantLink" DROP COLUMN "shopifyCatalog";
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "ShopifyVariantLink" ADD COLUMN "shopifyCatalog" JSONB;

-- DropIndex
DROP INDEX "ProductGroup_venueId_source_externalId_key";

-- CreateIndex (parcial: Prisma no sabe expresarlo; el schema no lo declara y lo documenta con un comentario /// en ProductGroup; esta migración manda)
CREATE UNIQUE INDEX "ProductGroup_venueId_source_externalId_vivo_key" ON "ProductGroup"("venueId", "source", "externalId") WHERE "deletedAt" IS NULL;
