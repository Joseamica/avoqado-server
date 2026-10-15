-- Variantes de producto (spec docs/superpowers/specs/2026-10-14-variantes-de-producto-design.md, bloque 1).
-- El padre (ProductGroup) encima de los productos de hoy; cada variante sigue siendo un Product (su SKU, código, precio,
-- stock y ventas no cambian). Sólo agrega tablas y 3 columnas opcionales: ningún dato existente se mueve.
--
-- Orden (revisión final): primero lo nuevo (enum, tablas, índices y sus FKs a Venue/MenuCategory/PrintStation/
-- ModifierGroup); AL FINAL lo que toca "Product". Así el ACCESS EXCLUSIVE de "Product" (ADD COLUMN) se toma al último y no
-- se sostiene mientras se esperan los candados de las otras tablas. Si un candado vence (lock_timeout), `migrate deploy`
-- marca la migración como fallida (P3009): `prisma migrate resolve --rolled-back 20261014120000_product_variants` y
-- reintentar en un horario de poco tráfico.
--
-- Reversión (no se ejecuta):
--   ALTER TABLE "Product" DROP COLUMN "productGroupId", DROP COLUMN "variantKey", DROP COLUMN "variantImageUrl";
--   DROP TABLE "ProductVariantValue", "ProductGroupModifierGroup", "ProductGroupOptionValue", "ProductGroupOption", "ProductGroup";
--   DROP TYPE "ProductGroupSource";
SET LOCAL lock_timeout = '5s';

-- Shopify no liga una variante de Avoqado (quién manda nombre y foto llega en el bloque 5): queda en «Productos sin pareja».
ALTER TYPE "ShopifyIssueReason" ADD VALUE IF NOT EXISTS 'PRODUCTO_CON_VARIANTES';

-- CreateEnum
CREATE TYPE "ProductGroupSource" AS ENUM ('MANUAL', 'SHOPIFY');

-- CreateTable
CREATE TABLE "ProductGroup" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "categoryId" TEXT NOT NULL,
    "type" "ProductType" NOT NULL DEFAULT 'REGULAR',
    "ivaTratamiento" "IvaTratamiento" NOT NULL DEFAULT 'IVA_16',
    "satProductKey" TEXT,
    "satUnitKey" TEXT,
    "printStationId" TEXT,
    "source" "ProductGroupSource" NOT NULL DEFAULT 'MANUAL',
    "externalId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductGroupOption" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ProductGroupOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductGroupOptionValue" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ProductGroupOptionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductGroupModifierGroup" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "modifierGroupId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductGroupModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariantValue" (
    "productId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "optionValueId" TEXT NOT NULL,

    CONSTRAINT "ProductVariantValue_pkey" PRIMARY KEY ("productId","optionId")
);

-- CreateIndex
CREATE INDEX "ProductGroup_venueId_deletedAt_idx" ON "ProductGroup"("venueId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductGroup_venueId_source_externalId_key" ON "ProductGroup"("venueId", "source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductGroupOption_groupId_name_key" ON "ProductGroupOption"("groupId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ProductGroupOption_groupId_position_key" ON "ProductGroupOption"("groupId", "position");

-- CreateIndex
CREATE INDEX "ProductGroupOptionValue_optionId_position_idx" ON "ProductGroupOptionValue"("optionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ProductGroupOptionValue_optionId_value_key" ON "ProductGroupOptionValue"("optionId", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ProductGroupModifierGroup_groupId_modifierGroupId_key" ON "ProductGroupModifierGroup"("groupId", "modifierGroupId");

-- CreateIndex
CREATE INDEX "ProductVariantValue_optionValueId_idx" ON "ProductVariantValue"("optionValueId");

-- AddForeignKey
ALTER TABLE "ProductGroup" ADD CONSTRAINT "ProductGroup_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGroup" ADD CONSTRAINT "ProductGroup_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGroup" ADD CONSTRAINT "ProductGroup_printStationId_fkey" FOREIGN KEY ("printStationId") REFERENCES "PrintStation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGroupOption" ADD CONSTRAINT "ProductGroupOption_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ProductGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGroupOptionValue" ADD CONSTRAINT "ProductGroupOptionValue_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ProductGroupOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGroupModifierGroup" ADD CONSTRAINT "ProductGroupModifierGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ProductGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGroupModifierGroup" ADD CONSTRAINT "ProductGroupModifierGroup_modifierGroupId_fkey" FOREIGN KEY ("modifierGroupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantValue" ADD CONSTRAINT "ProductVariantValue_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ProductGroupOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantValue" ADD CONSTRAINT "ProductVariantValue_optionValueId_fkey" FOREIGN KEY ("optionValueId") REFERENCES "ProductGroupOptionValue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- "Product" al final (ver el encabezado).

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "productGroupId" TEXT,
ADD COLUMN     "variantImageUrl" TEXT,
ADD COLUMN     "variantKey" TEXT;

-- CreateIndex (también sirve las búsquedas sólo por "productGroupId": es la primera columna; no hay índice aparte)
CREATE UNIQUE INDEX "Product_productGroupId_variantKey_key" ON "Product"("productGroupId", "variantKey");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_productGroupId_fkey" FOREIGN KEY ("productGroupId") REFERENCES "ProductGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariantValue" ADD CONSTRAINT "ProductVariantValue_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
