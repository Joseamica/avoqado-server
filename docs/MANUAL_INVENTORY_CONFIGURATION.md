# Manual Inventory Configuration Guide

This guide explains how to manually configure inventory for products **without using the Product Wizard**.

## Overview

There are two ways to attach inventory to products:

1. **Using the Product Wizard** (Recommended) - User-friendly guided process
2. **Manual Database Configuration** (Advanced) - Direct SQL manipulation

This document covers Method #2.

## Prerequisites

- PostgreSQL database access
- Product must exist in the database
- Venue must have `INVENTORY_MANAGEMENT` feature enabled

## Step-by-Step Manual Configuration

### Step 1: Verify Venue Has Inventory Feature

```sql
-- Check if venue has INVENTORY_MANAGEMENT feature
SELECT
  v.id as venue_id,
  v.name as venue_name,
  f.code as feature_code,
  vf.active as feature_active
FROM "Venue" v
LEFT JOIN "VenueFeature" vf ON vf."venueId" = v.id
LEFT JOIN "Feature" f ON f.id = vf."featureId"
WHERE v.id = 'YOUR_VENUE_ID'
  AND f.code = 'INVENTORY_MANAGEMENT';
```

If no rows returned, enable the feature:

```sql
-- Create INVENTORY_MANAGEMENT feature (if it doesn't exist)
WITH new_feature AS (
  INSERT INTO "Feature" (id, code, name, description, category, "monthlyPrice", active)
  VALUES (
    'cm' || substr(md5(random()::text), 1, 23),
    'INVENTORY_MANAGEMENT',
    'Inventory Management',
    'Track raw materials, stock levels, and recipe costs',
    'OPERATIONS'::"FeatureCategory",
    99.00,
    true
  )
  ON CONFLICT (code) DO UPDATE SET id = "Feature".id
  RETURNING id
)
-- Activate it for your venue
INSERT INTO "VenueFeature" (id, "venueId", "featureId", active, "monthlyPrice")
SELECT
  'cm' || substr(md5(random()::text), 1, 23),
  'YOUR_VENUE_ID',
  new_feature.id,
  true,
  99.00
FROM new_feature;
```

### Step 2: Configure Product for Quantity Inventory

Update the product to use quantity-based inventory tracking:

```sql
UPDATE "Product"
SET "trackInventory" = true,
    "inventoryMethod" = 'QUANTITY'::"InventoryMethod"
WHERE id = 'YOUR_PRODUCT_ID'
RETURNING id, name, "trackInventory", "inventoryMethod";
```

**Note**: The old approach using `externalData.inventoryType = 'SIMPLE_STOCK'` has been replaced with a dedicated `inventoryMethod` column
for better performance and type safety.

### Step 3: Create RawMaterial Record

```sql
WITH new_id AS (
  SELECT 'cm' || substr(md5(random()::text), 1, 23) as id
)
INSERT INTO "RawMaterial" (
  id,
  "venueId",
  name,
  description,
  sku,
  category,
  "currentStock",
  "minimumStock",
  "reorderPoint",
  "costPerUnit",
  "avgCostPerUnit",
  "unitType",
  unit,
  active,
  "updatedAt"
)
SELECT
  new_id.id,
  'YOUR_VENUE_ID',
  'Product Name (Stock)',
  'Auto-generated raw material for simple stock product',
  'RM-YOUR-SKU-001',
  'OTHER'::"RawMaterialCategory",
  0,      -- currentStock (will be updated in next step)
  5,      -- minimumStock
  10,     -- reorderPoint
  10.00,  -- costPerUnit
  10.00,  -- avgCostPerUnit
  'COUNT'::"UnitType",
  'PIECE'::"Unit",
  true,
  NOW()
FROM new_id
RETURNING id, name, sku;
```

**Save the returned `id` - you'll need it for the next steps.**

### Step 4: Create Inventory Record

With the new schema, products with `inventoryMethod = 'QUANTITY'` use the `Inventory` table instead of RawMaterial:

```sql
INSERT INTO "Inventory" (
  id,
  "productId",
  "venueId",
  "currentStock",
  "minimumStock",
  "updatedAt"
)
VALUES (
  'cm' || substr(md5(random()::text), 1, 23),
  'YOUR_PRODUCT_ID',
  'YOUR_VENUE_ID',
  100,  -- Initial stock
  10,   -- Minimum stock threshold
  NOW()
)
RETURNING id, "productId", "currentStock", "minimumStock";
```

**Note**: The old approach stored `rawMaterialId` in `externalData`. The new architecture uses the `Inventory` relation table for cleaner
data modeling.

### Step 5: Verify Configuration

```sql
SELECT
  p.id as product_id,
  p.name as product_name,
  p.price as product_price,
  p."trackInventory",
  p."inventoryMethod",
  i.id as inventory_id,
  i."currentStock",
  i."minimumStock"
FROM "Product" p
LEFT JOIN "Inventory" i ON i."productId" = p.id
WHERE p.id = 'YOUR_PRODUCT_ID';
```

Expected output should show:

- Product with `trackInventory = true` and `inventoryMethod = 'QUANTITY'`
- Linked Inventory record with current stock and minimum stock
- No `externalData.inventoryType` field (migrated to column)

## Example: Real Configuration

Here's an example configuration for a product with quantity tracking:

```sql
-- Product ID: prod_123
-- Venue ID: venue_456

UPDATE "Product"
SET "trackInventory" = true,
    "inventoryMethod" = 'QUANTITY'::"InventoryMethod"
WHERE id = 'prod_123';

INSERT INTO "Inventory" (
  id, "productId", "venueId", "currentStock", "minimumStock", "updatedAt"
)
VALUES (
  'inv_789', 'prod_123', 'venue_456', 50, 10, NOW()
);

-- Result:
-- - 50 units in stock
-- - Minimum stock threshold: 10 units
-- - Inventory automatically deducted when product sold
-- - Low stock alert when stock <= 10
```

## Testing the Configuration

You can test the inventory deduction by running:

```bash
cd avoqado-server
npx tsx test-inventory-deduction.ts
```

This will:

1. Show stock before sale
2. Simulate selling 3 units
3. Show stock after sale
4. Display movement records

## Important Notes

### Unit Types and Units

The system supports various unit types:

- **UnitType**: `WEIGHT`, `VOLUME`, `COUNT`, `LENGTH`, `TEMPERATURE`, `TIME`
- **Unit**: `GRAM`, `KILOGRAM`, `LITER`, `PIECE`, `UNIT`, `DOZEN`, etc.

For retail products (jewelry, clothing, electronics), use:

- `unitType: COUNT`
- `unit: PIECE` or `UNIT`

### RawMaterial Categories

Available categories:

- `MEAT`, `POULTRY`, `SEAFOOD`, `DAIRY`, `VEGETABLES`, `FRUITS`
- `GRAINS`, `SPICES`, `OILS`, `BEVERAGES`, `ALCOHOL`
- `CLEANING`, `PACKAGING`, `OTHER`

For finished retail goods, use `OTHER`.

### Batch Statuses

- `ACTIVE` - Batch is available for use
- `DEPLETED` - Batch has been fully consumed
- `EXPIRED` - Batch has passed expiration date

### How the Service Works

The product inventory system now uses dedicated columns for cleaner architecture:

1. **Check Product Inventory Method**:

   - Reads `Product.trackInventory` and `Product.inventoryMethod`
   - No JSON parsing - direct column access for performance

2. **Quantity Tracking (`inventoryMethod = 'QUANTITY'`)**:

   - Uses `Inventory` table for stock management
   - Simple stock counting (bottles, units, pieces)
   - Direct stock deduction via `Inventory.currentStock`
   - Creates `InventoryMovement` record for audit trail

3. **Recipe-Based (`inventoryMethod = 'RECIPE'`)**:

   - Uses `Recipe` + `RawMaterial` tables
   - Ingredient-based tracking with FIFO costing
   - Deducts from `RawMaterial.currentStock` for each ingredient
   - Creates `RawMaterialMovement` records

4. **No Tracking (`trackInventory = false`)**:
   - No stock deduction
   - Only records revenue

## Advantages of Manual Configuration

1. **Full control** over SKU naming conventions
2. **Custom cost allocation** - set exact cost per unit
3. **Batch management** - pre-create batches with specific costs
4. **Bulk imports** - script multiple products at once
5. **Migration** - import from existing inventory systems

## Disadvantages of Manual Configuration

1. **More error-prone** - typos in IDs can break links
2. **No validation** - SQL won't catch business logic errors
3. **Harder to maintain** - changes require multiple queries
4. **No rollback** - if you make a mistake, manual cleanup required

## Recommended Approach

**For most users**: Use the Product Wizard (guided UI)

**Use manual configuration when**:

- Migrating from legacy system
- Bulk importing products
- Integrating with external ERP
- Advanced customization needed

## Related Files

- **Service**: `src/services/dashboard/productInventoryIntegration.service.ts`
- **Controller**: `src/controllers/dashboard/inventory/productWizard.controller.ts`
- **Frontend Component**: `src/pages/Inventory/components/ProductWizardDialog.tsx`
- **Test Script**: `test-inventory-deduction.ts`

## Troubleshooting

### "No inventory deduction needed" error

**Problem**: Service returns `inventoryMethod: null` or doesn't deduct stock

**Solutions**:

1. Check venue has `INVENTORY_MANAGEMENT` feature active
2. Verify product has `trackInventory = true`
3. Verify product has `inventoryMethod = 'QUANTITY'` or `'RECIPE'`
4. For Quantity tracking: Check `Inventory` record exists
5. For Recipe tracking: Check `Recipe` record exists

**Verification query**:

```sql
SELECT
  p.id,
  p.name,
  p."trackInventory",
  p."inventoryMethod",
  i.id as inventory_id,
  r.id as recipe_id
FROM "Product" p
LEFT JOIN "Inventory" i ON i."productId" = p.id
LEFT JOIN "Recipe" r ON r."productId" = p.id
WHERE p.id = 'YOUR_PRODUCT_ID';
```

### "Insufficient stock" error

**Problem**: `Available: 0, Requested: 3`

**Solutions**:

**For Quantity Tracking**:

1. Check `Inventory.currentStock` is greater than 0
2. Verify the `Inventory.productId` matches the product

**For Recipe-Based**:

1. Check `RawMaterial.currentStock` for each ingredient
2. Ensure `StockBatch` has `remainingQuantity > 0`
3. Verify recipe has ingredients defined

### Stock not deducting

**Problem**: Sale completes but stock unchanged

**Solutions**:

1. Check if venue feature is active
2. Verify product has `trackInventory = true`
3. Verify `inventoryMethod` is set (`'QUANTITY'` or `'RECIPE'`)
4. For Quantity: Check `InventoryMovement` table for errors
5. For Recipe: Check `RawMaterialMovement` table for errors
6. Check backend logs for deduction errors

## Migration from Old Schema

### What Changed (October 2024)

The inventory system was refactored from JSON-based to column-based storage:

**Before**:

```sql
-- Old approach (JSON field)
UPDATE "Product"
SET "externalData" = '{"inventoryType": "SIMPLE_STOCK", "rawMaterialId": "rm_123"}'::jsonb
WHERE id = 'prod_123';
```

**After**:

```sql
-- New approach (dedicated columns)
UPDATE "Product"
SET "trackInventory" = true,
    "inventoryMethod" = 'QUANTITY'::"InventoryMethod"
WHERE id = 'prod_123';

-- Inventory table (instead of rawMaterialId reference)
INSERT INTO "Inventory" (id, "productId", "venueId", "currentStock", "minimumStock")
VALUES ('inv_456', 'prod_123', 'venue_789', 100, 10);
```

### Migration Benefits

1. **Performance**: Indexed columns instead of JSON queries
2. **Type Safety**: PostgreSQL enum validation
3. **Cleaner Architecture**: Dedicated `Inventory` table for quantity tracking
4. **Easier Queries**: No JSON parsing required
5. **World-Class Pattern**: Follows Toast/Square/Shopify standards

### Migration Guide

If you have products using the old `externalData.inventoryType` approach:

```sql
-- 1. Check if migration is needed
SELECT
  id,
  name,
  "trackInventory",
  "inventoryMethod",
  "externalData"->>'inventoryType' as old_field
FROM "Product"
WHERE "externalData" ? 'inventoryType';

-- 2. Apply migration (if needed)
UPDATE "Product"
SET "inventoryMethod" =
  CASE "externalData"->>'inventoryType'
    WHEN 'SIMPLE_STOCK' THEN 'QUANTITY'::"InventoryMethod"
    WHEN 'RECIPE_BASED' THEN 'RECIPE'::"InventoryMethod"
  END,
  "trackInventory" = true
WHERE "externalData" ? 'inventoryType';

-- 3. Clean up old JSON field
UPDATE "Product"
SET "externalData" = "externalData" - 'inventoryType' - 'rawMaterialId'
WHERE "externalData" ? 'inventoryType';

-- 4. Create Inventory records for QUANTITY products
-- (Manual step - requires knowing which products need Inventory)
INSERT INTO "Inventory" (id, "productId", "venueId", "currentStock", "minimumStock")
SELECT
  'cm' || substr(md5(random()::text), 1, 23),
  p.id,
  p."venueId",
  0,  -- Set initial stock
  10  -- Set minimum threshold
FROM "Product" p
WHERE p."inventoryMethod" = 'QUANTITY'
  AND NOT EXISTS (SELECT 1 FROM "Inventory" i WHERE i."productId" = p.id);
```

## Support

For questions or issues, refer to:

- Main documentation: `CLAUDE.md`
- Database schema: `DATABASE_SCHEMA.md`
- Inventory workflow: `INVENTORY_WORKFLOW.md`
- Migration details: `prisma/migrations/20251021210538_refactor_inventory_method_world_class/migration.sql`

**Last updated**: 2025-01-21 (Schema refactor)
