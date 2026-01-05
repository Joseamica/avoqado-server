-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_productId_fkey";

-- DropForeignKey
ALTER TABLE "OrderItemModifier" DROP CONSTRAINT "OrderItemModifier_modifierId_fkey";

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "categoryName" TEXT,
ADD COLUMN     "productName" TEXT,
ADD COLUMN     "productSku" TEXT,
ALTER COLUMN "productId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "OrderItemModifier" ADD COLUMN     "name" TEXT,
ALTER COLUMN "modifierId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemModifier" ADD CONSTRAINT "OrderItemModifier_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "Modifier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: Populate denormalized fields from existing data (Toast/Square pattern)
-- This ensures order history is preserved even if products/modifiers are later deleted

-- Backfill OrderItem with product data
UPDATE "OrderItem" oi
SET
  "productName" = p.name,
  "productSku" = p.sku,
  "categoryName" = mc.name
FROM "Product" p
LEFT JOIN "MenuCategory" mc ON p."categoryId" = mc.id
WHERE oi."productId" = p.id
  AND oi."productName" IS NULL;

-- Backfill OrderItemModifier with modifier data
UPDATE "OrderItemModifier" oim
SET "name" = m.name
FROM "Modifier" m
WHERE oim."modifierId" = m.id
  AND oim."name" IS NULL;
