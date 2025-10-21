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

### Step 2: Configure Product for SIMPLE_STOCK Inventory

Update the product's `externalData` field to indicate it uses simple stock tracking:

```sql
UPDATE "Product"
SET "externalData" = jsonb_build_object(
  'inventoryType', 'SIMPLE_STOCK',
  'inventoryConfigured', true,
  'wizardCompleted', true,
  'trackStock', true
)
WHERE id = 'YOUR_PRODUCT_ID'
RETURNING id, name, "externalData";
```

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

### Step 4: Link RawMaterial to Product

```sql
UPDATE "Product"
SET "externalData" = jsonb_build_object(
  'inventoryType', 'SIMPLE_STOCK',
  'inventoryConfigured', true,
  'wizardCompleted', true,
  'trackStock', true,
  'rawMaterialId', 'RAW_MATERIAL_ID_FROM_STEP_3'
)
WHERE id = 'YOUR_PRODUCT_ID'
RETURNING id, name, "externalData";
```

### Step 5: Create Initial Stock Batch

```sql
WITH new_batch_id AS (
  SELECT 'cm' || substr(md5(random()::text), 1, 23) as id
)
INSERT INTO "StockBatch" (
  id,
  "rawMaterialId",
  "venueId",
  "batchNumber",
  "initialQuantity",
  "remainingQuantity",
  unit,
  "costPerUnit",
  "receivedDate",
  status,
  "updatedAt"
)
SELECT
  new_batch_id.id,
  'RAW_MATERIAL_ID_FROM_STEP_3',
  'YOUR_VENUE_ID',
  'BATCH-001',
  100.000,  -- Initial quantity
  100.000,  -- Remaining quantity
  'PIECE'::"Unit",
  10.00,    -- Cost per unit
  NOW(),
  'ACTIVE'::"BatchStatus",
  NOW()
FROM new_batch_id
RETURNING id, "batchNumber", "initialQuantity", "remainingQuantity";
```

### Step 6: Update RawMaterial Current Stock

```sql
UPDATE "RawMaterial"
SET "currentStock" = 100.000,
    "updatedAt" = NOW()
WHERE id = 'RAW_MATERIAL_ID_FROM_STEP_3'
RETURNING id, name, "currentStock";
```

### Step 7: Verify Configuration

```sql
SELECT
  p.id as product_id,
  p.name as product_name,
  p.price as product_price,
  p."externalData" as product_config,
  rm.id as raw_material_id,
  rm.name as raw_material_name,
  rm."currentStock" as current_stock,
  rm."minimumStock" as min_stock,
  rm."costPerUnit" as cost_per_unit,
  sb.id as batch_id,
  sb."batchNumber" as batch_number,
  sb."remainingQuantity" as batch_remaining
FROM "Product" p
LEFT JOIN "RawMaterial" rm ON rm.id = (p."externalData"->>'rawMaterialId')
LEFT JOIN "StockBatch" sb ON sb."rawMaterialId" = rm.id
WHERE p.id = 'YOUR_PRODUCT_ID';
```

Expected output should show:

- Product with `inventoryType: SIMPLE_STOCK` in externalData
- Linked RawMaterial with current stock
- StockBatch with initial quantity

## Example: Real Configuration

Here's the actual example from "Small Ceramic Mouse" product:

```sql
-- Product ID: cmgpk66hu00e9eqls2er060mz
-- Venue ID: cmgpk66ab009oeqlsnnyzx82z
-- RawMaterial ID: cm2f01688f7f44027bb3d246e
-- Batch ID: cm684d049b1bc78cd8b9deeeb

-- Result:
-- - 50 units of "Small Ceramic Mouse" in stock
-- - Cost per unit: $52.95
-- - Inventory successfully deducted when product sold
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

The `productInventoryIntegration.service.ts` will:

1. Check if venue has `INVENTORY_MANAGEMENT` feature
2. Read product's `externalData.inventoryType`
3. If `SIMPLE_STOCK`:
   - Look for RawMaterial by `externalData.rawMaterialId` (manual config)
   - OR look for RawMaterial by SKU `PRODUCT-${productId}` (auto-created)
4. Deduct stock when product is sold
5. Create RawMaterialMovement record for audit trail

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

**Problem**: Service returns `inventoryType: 'NONE'`

**Solutions**:

1. Check venue has `INVENTORY_MANAGEMENT` feature active
2. Verify product's `externalData.inventoryType` is set to `SIMPLE_STOCK`
3. Ensure RawMaterial is linked via `externalData.rawMaterialId`

### "Insufficient stock" error

**Problem**: `Available: 0, Requested: 3`

**Solutions**:

1. Check `RawMaterial.currentStock` is greater than 0
2. Verify the `rawMaterialId` in product's `externalData` matches actual RawMaterial
3. Ensure StockBatch has `remainingQuantity > 0`

### Stock not deducting

**Problem**: Sale completes but stock unchanged

**Solutions**:

1. Check if venue feature is active
2. Verify product has correct `inventoryType` in `externalData`
3. Look for error logs in `RawMaterialMovement` table

## Support

For questions or issues, refer to:

- Main documentation: `CLAUDE.md`
- Database schema: `DATABASE_SCHEMA.md`
- Inventory architecture: `productInventoryIntegration.service.ts` comments
