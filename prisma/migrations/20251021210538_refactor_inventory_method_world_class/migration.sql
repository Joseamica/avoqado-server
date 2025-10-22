-- ==========================================
-- WORLD-CLASS REFACTOR: inventoryMethod Column
-- Migrates from externalData.inventoryType (JSON) to inventoryMethod (enum column)
-- Pattern: Toast/Square/Shopify
-- ==========================================

-- Step 1: Create enum type
CREATE TYPE "public"."InventoryMethod" AS ENUM ('QUANTITY', 'RECIPE');

-- Step 2: Add new column (nullable)
ALTER TABLE "public"."Product" ADD COLUMN "inventoryMethod" "public"."InventoryMethod";

-- Step 3: Migrate existing data from JSON to column
-- SIMPLE_STOCK → QUANTITY (world-class naming)
-- RECIPE_BASED → RECIPE
UPDATE "public"."Product"
SET "inventoryMethod" =
  CASE "externalData"->>'inventoryType'
    WHEN 'SIMPLE_STOCK' THEN 'QUANTITY'::"public"."InventoryMethod"
    WHEN 'RECIPE_BASED' THEN 'RECIPE'::"public"."InventoryMethod"
    ELSE NULL
  END
WHERE "externalData" ? 'inventoryType';

-- Step 4: Handle products with NULL/empty externalData but have Inventory records
-- These products are using quantity tracking but never had inventoryType set in JSON
UPDATE "public"."Product" p
SET "inventoryMethod" = 'QUANTITY'::"public"."InventoryMethod"
WHERE p."trackInventory" = true
  AND p."inventoryMethod" IS NULL
  AND EXISTS (
    SELECT 1 FROM "public"."Inventory" i WHERE i."productId" = p.id
  );

-- Step 5: Clean up externalData (remove inventoryType key, keep POS data)
UPDATE "public"."Product"
SET "externalData" = "externalData" - 'inventoryType'
WHERE "externalData" ? 'inventoryType';

-- Step 6: Add index for performance
CREATE INDEX "Product_inventoryMethod_idx" ON "public"."Product"("inventoryMethod");
