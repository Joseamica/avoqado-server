# Inventory System - Technical Reference

**Quick Navigation:**

- 📐 **Architecture & Flow**: See `CLAUDE.md` lines 190-250 (Order → Payment → Inventory)
- 🧪 **Testing & Bugs**: See `INVENTORY_TESTING.md` (15 integration tests, 3 critical bugs fixed)
- 💻 **Code Locations**: `src/services/dashboard/rawMaterial.service.ts`, `src/services/dashboard/fifoBatch.service.ts`
- 🍳 **Modifier Inventory**: See section below (Toast/Square pattern for modifier stock tracking)

**Last Updated**: 2025-11-29

---

## 🎯 Core Concepts

### Three Pillars of Inventory

#### 1. Raw Materials (Materias Primas)

Base ingredients purchased from suppliers.

**Key Fields:**

- `currentStock` - Available quantity in warehouse
- `costPerUnit` - Cost per kg/liter/unit
- `reorderPoint` - Threshold for low stock alerts
- `minimumStock` - Critical minimum level

**Example**: Beef (kg), Cheese (kg), Bread (kg), Lettuce (kg), Sauce (liters)

#### 2. Recipes (Recetas)

Defines ingredients and quantities needed to make ONE product.

**Example - "Simple Burger" Recipe:**

```
1 portion = 1 burger:
  - 200g Bread
  - 300g Ground Beef
  - 50g Cheese

Total cost = (0.2kg × $50/kg) + (0.3kg × $200/kg) + (0.05kg × $100/kg)
           = $10 + $60 + $5 = $75 MXN
```

#### 3. Products (Productos)

Menu items customers can order. Three tracking modes:

| Mode             | `trackInventory` | `inventoryMethod` | Use Case                               |
| ---------------- | ---------------- | ----------------- | -------------------------------------- |
| **No tracking**  | `false`          | `null`            | Unlimited items (e.g., coffee refills) |
| **Quantity**     | `true`           | `QUANTITY`        | Count-based (e.g., wine bottles)       |
| **Recipe-based** | `true`           | `RECIPE`          | Composed items (e.g., burgers)         |

---

## 🏗️ Dual-Inventory Architecture (Toast/Square Pattern)

**WHY**: Different business models need different inventory tracking. Retail businesses need simple counting, restaurants need ingredient-level FIFO costing. This is why world-class systems like Toast and Square use separate tracking systems.

### Two Inventory Systems

| System | Tables | Use Case | Complexity |
|--------|--------|----------|------------|
| **QUANTITY** | `Inventory` → `InventoryMovement` | Retail (jewelry, wine, clothing) | Simple counting |
| **RECIPE** | `RawMaterial` → `StockBatch` → `RawMaterialMovement` | Restaurants | FIFO batch tracking |

### QUANTITY Method (Simple Counting)

**Data Flow:**
```
Product Wizard → Creates Inventory record
Status Check → Reads Inventory.currentStock
Deduction → Updates Inventory.currentStock
Audit Trail → Creates InventoryMovement (type: SALE)
```

**Key Files:**
- Creation: `src/services/dashboard/productWizard.service.ts:setupSimpleStockStep3()`
- Deduction: `src/services/dashboard/productInventoryIntegration.service.ts:deductSimpleStock()`
- Status: `src/services/dashboard/productInventoryIntegration.service.ts:getProductInventoryStatus()`

**Database Tables:**
```sql
-- Inventory record (one per QUANTITY product)
SELECT * FROM "Inventory" WHERE "productId" = 'your-product-id';

-- Movement audit trail
SELECT * FROM "InventoryMovement" WHERE "inventoryId" = 'your-inventory-id'
ORDER BY "createdAt" DESC;
```

### RECIPE Method (FIFO Batch Tracking)

**Data Flow:**
```
Recipe Wizard → Creates Recipe + RecipeLine linking to RawMaterial
Status Check → Calculates max portions from RawMaterial stock
Deduction → Updates StockBatch.remainingQuantity (FIFO)
Audit Trail → Creates RawMaterialMovement (one per batch)
```

**Key Files:**
- Creation: `src/services/dashboard/recipe.service.ts:createRecipe()`
- Deduction: `src/services/dashboard/fifoBatch.service.ts:deductStockFIFO()`
- Status: `src/services/dashboard/productInventoryIntegration.service.ts:getProductInventoryStatus()`

### ⚠️ Critical Design Rule

**A product uses ONLY ONE inventory system.** The wizard enforces this:

```typescript
// If switching from RECIPE → QUANTITY: Deletes Recipe
// If switching from QUANTITY → RECIPE: Deletes linked RawMaterial
await switchInventoryMethod(venueId, productId, newMethod)
```

### Fix History (2025-11-29)

**Bug**: QUANTITY products checked stock from `Inventory` table but deducted from `RawMaterial` table, causing out-of-sync data.

**Fix**: `deductSimpleStock()` now uses `Inventory` table exclusively:
- Queries `Inventory.findUnique({ where: { productId } })`
- Updates `Inventory.currentStock`
- Creates `InventoryMovement` with `type: SALE`

**Unit Tests**: 15 tests in `tests/unit/services/dashboard/productInventoryIntegration.service.test.ts`

---

## 🔄 FIFO Batch System

**WHY**: First-In-First-Out ensures oldest ingredients are used first, reducing waste and maintaining consistent costing.

**How It Works:**

```typescript
// Stock batches ordered by receivedDate
Batch 1: 50 units, received Oct 4, expires Oct 9  (OLDEST)
Batch 2: 100 units, received Oct 9, expires Oct 14
Batch 3: 150 units, received Oct 14, expires Oct 19 (NEWEST)

// Order requires 60 units:
Step 1: Deduct 50 from Batch 1 → Batch 1 DEPLETED
Step 2: Deduct 10 from Batch 2 → Batch 2 has 90 remaining
Step 3: Batch 3 untouched (still 150)
```

**Key SQL:**

```sql
SELECT * FROM "StockBatch"
WHERE "rawMaterialId" = $1
  AND status = 'ACTIVE'
  AND "remainingQuantity" > 0
ORDER BY "receivedDate" ASC  -- ← Oldest first (FIFO)
FOR UPDATE NOWAIT             -- ← Row-level lock for concurrency
```

**⚠️ Critical**: `ORDER BY` MUST come before `FOR UPDATE NOWAIT` (PostgreSQL syntax requirement).

---

## 🛠️ Manual Configuration (Advanced)

### When to Use Manual Configuration

- ✅ Migrating from legacy system
- ✅ Bulk importing products via script
- ✅ Integrating with external ERP
- ✅ Custom batch creation with specific dates

### SQL: Configure Product for Quantity Tracking

```sql
-- 1. Enable inventory tracking
UPDATE "Product"
SET "trackInventory" = true,
    "inventoryMethod" = 'QUANTITY'::"InventoryMethod"
WHERE id = 'YOUR_PRODUCT_ID';

-- 2. Create Inventory record
INSERT INTO "Inventory" (
  id, "productId", "venueId", "currentStock", "minimumStock", "updatedAt"
)
VALUES (
  'cm' || substr(md5(random()::text), 1, 23),
  'YOUR_PRODUCT_ID',
  'YOUR_VENUE_ID',
  100,  -- Initial stock
  10,   -- Minimum threshold
  NOW()
);
```

### SQL: Configure Product for Recipe-Based Tracking

```sql
-- 1. Enable recipe tracking
UPDATE "Product"
SET "trackInventory" = true,
    "inventoryMethod" = 'RECIPE'::"InventoryMethod"
WHERE id = 'YOUR_PRODUCT_ID';

-- 2. Create Recipe
INSERT INTO "Recipe" (
  id, "productId", "venueId", "portionYield", "prepTime", "cookTime"
)
VALUES (
  'cm' || substr(md5(random()::text), 1, 23),
  'YOUR_PRODUCT_ID',
  'YOUR_VENUE_ID',
  1,     -- Yields 1 portion
  5,     -- 5 min prep
  10     -- 10 min cook
);

-- 3. Add recipe lines (ingredients)
INSERT INTO "RecipeLine" (
  id, "recipeId", "rawMaterialId", quantity, unit, "isOptional"
)
VALUES
  ('cm' || substr(md5(random()::text), 1, 23), 'RECIPE_ID', 'RAW_MATERIAL_ID_1', 200, 'GRAM', false),
  ('cm' || substr(md5(random()::text), 1, 23), 'RECIPE_ID', 'RAW_MATERIAL_ID_2', 300, 'GRAM', false);
```

### SQL: Create Raw Material with Initial Stock

```sql
-- 1. Create raw material
WITH new_material AS (
  INSERT INTO "RawMaterial" (
    id, "venueId", name, sku, unit, "unitType", "costPerUnit",
    "avgCostPerUnit", "currentStock", "minimumStock", "reorderPoint", active
  )
  VALUES (
    'cm' || substr(md5(random()::text), 1, 23),
    'YOUR_VENUE_ID',
    'Ground Beef',
    'BEEF-001',
    'KILOGRAM',
    'WEIGHT'::"UnitType",
    200.00,  -- Cost per kg
    200.00,  -- Average cost
    0,       -- Will be set via batch
    10,      -- Min stock
    20,      -- Reorder point
    true
  )
  RETURNING id
)
-- 2. Create initial stock batch (FIFO)
INSERT INTO "StockBatch" (
  id, "venueId", "rawMaterialId", "batchNumber", "receivedDate",
  "initialQuantity", "remainingQuantity", "costPerUnit", status
)
SELECT
  'cm' || substr(md5(random()::text), 1, 23),
  'YOUR_VENUE_ID',
  new_material.id,
  'BATCH-' || extract(epoch from now())::bigint,
  NOW(),
  100,     -- Initial quantity
  100,     -- Remaining quantity
  200.00,  -- Cost per unit
  'ACTIVE'::"BatchStatus"
FROM new_material;

-- 3. Update raw material current stock
UPDATE "RawMaterial" rm
SET "currentStock" = (
  SELECT COALESCE(SUM("remainingQuantity"), 0)
  FROM "StockBatch"
  WHERE "rawMaterialId" = rm.id AND status = 'ACTIVE'
)
WHERE id = (SELECT id FROM new_material);
```

---

## 📊 Database Schema (Key Tables)

```
Order → OrderItem → Product → Recipe → RecipeLine → RawMaterial → StockBatch
                                                                 ↓
                                                      RawMaterialMovement
                                                                 ↓
                                                        LowStockAlert
```

### Critical Relationships

| Parent        | Child         | Relationship | Purpose                              |
| ------------- | ------------- | ------------ | ------------------------------------ |
| `Product`     | `Recipe`      | 1:1          | One product = one recipe             |
| `Recipe`      | `RecipeLine`  | 1:N          | Recipe has multiple ingredients      |
| `RecipeLine`  | `RawMaterial` | N:1          | Multiple recipes use same ingredient |
| `RawMaterial` | `StockBatch`  | 1:N          | FIFO batch tracking                  |
| `Product`     | `Inventory`   | 1:1          | Quantity-based tracking              |
| `Modifier`    | `RawMaterial` | N:1          | Modifier inventory tracking          |

---

## 🍳 Modifier Inventory Tracking (Toast/Square Pattern)

**WHY**: Modifiers like "Extra Bacon" or "Almond Milk instead of Whole Milk" affect inventory. This system tracks raw material consumption
when modifiers are selected.

### Database Schema

```prisma
model Modifier {
  // ... basic fields ...

  // ✅ INVENTORY TRACKING
  rawMaterialId   String?               // Links to raw material for deduction
  rawMaterial     RawMaterial?          @relation(...)
  quantityPerUnit Decimal?              // Amount to deduct per selection (e.g., 0.03 kg)
  unit            Unit?                 // Unit of measurement
  inventoryMode   ModifierInventoryMode @default(ADDITION)
  cost            Decimal?              // Auto-calculated: avgCostPerUnit × quantityPerUnit
}

enum ModifierInventoryMode {
  ADDITION      // Adds extra ingredient (e.g., "Extra Bacon" adds 30g bacon)
  SUBSTITUTION  // Replaces recipe ingredient (e.g., "Almond Milk" replaces "Whole Milk")
}
```

### Two Inventory Modes

| Mode             | Behavior                               | Example                                               |
| ---------------- | -------------------------------------- | ----------------------------------------------------- |
| **ADDITION**     | Adds extra on top of recipe            | "Extra Cheese" → deducts 50g cheese in ADDITION       |
| **SUBSTITUTION** | Replaces variable ingredient in recipe | "Almond Milk" → replaces 200ml whole milk with almond |

### Deduction Flow

```
Order Payment Complete
    ↓
productInventoryIntegration.service.ts → processInventoryDeduction()
    ↓
    ├── deductStockForRecipe()      → Base recipe ingredients (FIFO)
    │   └── SUBSTITUTION modifiers handled here (replace variable ingredients)
    │
    └── deductStockForModifiers()   → ADDITION modifiers only
        └── Extra ingredients added on top
```

### Cost Auto-Calculation

When a modifier is linked to a raw material, cost is auto-calculated:

```
modifier.cost = rawMaterial.avgCostPerUnit × modifier.quantityPerUnit
```

This happens automatically when:

- Creating/updating a modifier with `rawMaterialId` and `quantityPerUnit`
- Raw material's `avgCostPerUnit` changes (via FIFO batch updates)

### API Endpoints

Base URL: `/api/v1/dashboard/venues/:venueId/modifiers/inventory`

| Endpoint     | Method | Description                                       |
| ------------ | ------ | ------------------------------------------------- |
| `/usage`     | GET    | Usage stats (times used, quantity, cost impact)   |
| `/low-stock` | GET    | Modifiers with raw materials below reorder point  |
| `/summary`   | GET    | Comprehensive summary (totals, alerts, top costs) |
| `/list`      | GET    | All modifiers with inventory configuration        |

**Query Parameters:**

- `startDate` / `endDate` - ISO 8601 format
- `modifierGroupId` - Filter by group
- `limit` - Max results (1-500, default 50)
- `includeInactive` - Include inactive modifiers

### Response Types

```typescript
interface ModifierUsageStats {
  modifierId: string
  modifierName: string
  groupId: string
  groupName: string
  timesUsed: number // Selection count
  totalQuantityUsed: number // Raw material consumed
  totalCostImpact: number // Cost in currency
  rawMaterial?: {
    id: string
    name: string
    unit: string
    currentStock: number
    costPerUnit: number
  }
  inventoryMode: 'ADDITION' | 'SUBSTITUTION' | null
  quantityPerUnit: number | null
}

interface ModifierLowStockItem {
  modifierId: string
  modifierName: string
  rawMaterialId: string
  rawMaterialName: string
  currentStock: number
  reorderPoint: number
  estimatedUsesRemaining: number // currentStock / quantityPerUnit
}

interface ModifierInventorySummary {
  totalModifiersWithInventory: number
  totalModifiersLowStock: number
  totalCostImpactPeriod: number
  topCostModifiers: ModifierUsageStats[]
  lowStockModifiers: ModifierLowStockItem[]
}
```

### Key Files

| File                                                                 | Purpose                     |
| -------------------------------------------------------------------- | --------------------------- |
| `src/services/dashboard/modifierInventoryAnalytics.service.ts`       | Analytics queries           |
| `src/services/dashboard/rawMaterial.service.ts`                      | `deductStockForModifiers()` |
| `src/services/dashboard/productInventoryIntegration.service.ts`      | Orchestrates deduction      |
| `src/controllers/dashboard/modifierInventoryAnalytics.controller.ts` | API handlers                |
| `src/schemas/dashboard/modifierInventoryAnalytics.schema.ts`         | Request validation (Zod)    |

### SQL: Check Modifier Inventory Configuration

```sql
-- List all modifiers with inventory tracking
SELECT
  m.id,
  m.name as modifier_name,
  mg.name as group_name,
  rm.name as raw_material,
  m."quantityPerUnit",
  m.unit,
  m."inventoryMode",
  m.cost,
  rm."currentStock"
FROM "Modifier" m
JOIN "ModifierGroup" mg ON m."groupId" = mg.id
LEFT JOIN "RawMaterial" rm ON m."rawMaterialId" = rm.id
WHERE mg."venueId" = 'YOUR_VENUE_ID'
  AND m."rawMaterialId" IS NOT NULL
ORDER BY mg.name, m.name;

-- Check low stock modifiers
SELECT
  m.name as modifier,
  rm.name as raw_material,
  rm."currentStock",
  rm."reorderPoint",
  FLOOR(rm."currentStock" / NULLIF(m."quantityPerUnit", 0)) as uses_remaining
FROM "Modifier" m
JOIN "ModifierGroup" mg ON m."groupId" = mg.id
JOIN "RawMaterial" rm ON m."rawMaterialId" = rm.id
WHERE mg."venueId" = 'YOUR_VENUE_ID'
  AND rm."currentStock" <= rm."reorderPoint";
```

---

## 🔧 Migration: inventoryMethod Column Refactor (Oct 2024)

### What Changed

**Before** (JSON field):

```sql
UPDATE "Product"
SET "externalData" = '{"inventoryType": "SIMPLE_STOCK"}'::jsonb
WHERE id = 'prod_123';
```

**After** (dedicated column):

```sql
UPDATE "Product"
SET "trackInventory" = true,
    "inventoryMethod" = 'QUANTITY'::"InventoryMethod"
WHERE id = 'prod_123';
```

### Benefits

- ✅ **Performance**: Indexed column (not JSON)
- ✅ **Type Safety**: PostgreSQL enum validation
- ✅ **Faster Queries**: No JSON parsing
- ✅ **Industry Standard**: Toast/Square/Shopify pattern

### Migration Query

```sql
-- Check if migration needed
SELECT id, name, "trackInventory", "inventoryMethod",
       "externalData"->>'inventoryType' as old_field
FROM "Product"
WHERE "externalData" ? 'inventoryType';

-- Apply migration
UPDATE "Product"
SET "inventoryMethod" =
  CASE "externalData"->>'inventoryType'
    WHEN 'SIMPLE_STOCK' THEN 'QUANTITY'::"InventoryMethod"
    WHEN 'RECIPE_BASED' THEN 'RECIPE'::"InventoryMethod"
  END,
  "trackInventory" = true
WHERE "externalData" ? 'inventoryType';

-- Clean up old JSON field
UPDATE "Product"
SET "externalData" = "externalData" - 'inventoryType' - 'rawMaterialId'
WHERE "externalData" ? 'inventoryType';
```

---

## 🚨 Troubleshooting

### Stock Not Deducting

**Check 1: Is order fully paid?**

```sql
SELECT id, total, "totalPaid", "paymentStatus"
FROM "Order"
WHERE id = 'order_123';
-- totalPaid should be >= total
```

**Check 2: Does product have tracking enabled?**

```sql
SELECT id, name, "trackInventory", "inventoryMethod"
FROM "Product"
WHERE id = 'prod_123';
-- trackInventory = true, inventoryMethod = QUANTITY or RECIPE
```

**Check 3: For Quantity tracking - Inventory exists?**

```sql
SELECT p.id, p.name, i."currentStock", i."minimumStock"
FROM "Product" p
LEFT JOIN "Inventory" i ON i."productId" = p.id
WHERE p.id = 'prod_123' AND p."inventoryMethod" = 'QUANTITY';
-- Inventory record should exist
```

**Check 4: For Recipe tracking - Recipe exists?**

```sql
SELECT p.id, p.name, r.id as recipe_id, COUNT(rl.id) as ingredients
FROM "Product" p
LEFT JOIN "Recipe" r ON r."productId" = p.id
LEFT JOIN "RecipeLine" rl ON rl."recipeId" = r.id
WHERE p.id = 'prod_123' AND p."inventoryMethod" = 'RECIPE'
GROUP BY p.id, p.name, r.id;
-- recipe_id NOT NULL, ingredients > 0
```

### Insufficient Stock Error

**For Quantity Tracking:**

```sql
SELECT i."currentStock", i."minimumStock"
FROM "Inventory" i
WHERE i."productId" = 'prod_123';
-- currentStock should be > 0
```

**For Recipe-Based:**

```sql
SELECT rm.name, rm."currentStock", rm."reorderPoint",
       SUM(sb."remainingQuantity") as available_in_batches
FROM "RecipeLine" rl
JOIN "RawMaterial" rm ON rm.id = rl."rawMaterialId"
LEFT JOIN "StockBatch" sb ON sb."rawMaterialId" = rm.id AND sb.status = 'ACTIVE'
WHERE rl."recipeId" = 'recipe_123'
GROUP BY rm.id, rm.name, rm."currentStock", rm."reorderPoint";
-- Check which ingredient has insufficient stock
```

### Wrong FIFO Order

```sql
SELECT id, "batchNumber", "receivedDate", "remainingQuantity", status
FROM "StockBatch"
WHERE "rawMaterialId" = 'rm_123'
ORDER BY "receivedDate" ASC;
-- Should show oldest first with status='ACTIVE'
```

### Venue Feature Not Enabled

```sql
SELECT v.name, f.code, vf.active
FROM "Venue" v
LEFT JOIN "VenueFeature" vf ON vf."venueId" = v.id
LEFT JOIN "Feature" f ON f.id = vf."featureId"
WHERE v.id = 'venue_123' AND f.code = 'INVENTORY_MANAGEMENT';
-- active should be true
```

---

## 📋 Unit Types & Categories

### Supported Unit Types

- `WEIGHT` → `GRAM`, `KILOGRAM`, `POUND`, `OUNCE`
- `VOLUME` → `MILLILITER`, `LITER`, `GALLON`, `FLUID_OUNCE`
- `COUNT` → `PIECE`, `UNIT`, `DOZEN`, `CASE`
- `LENGTH` → `CENTIMETER`, `METER`, `INCH`, `FOOT`

### Raw Material Categories

- Food: `MEAT`, `POULTRY`, `SEAFOOD`, `DAIRY`, `VEGETABLES`, `FRUITS`, `GRAINS`, `SPICES`, `OILS`
- Beverages: `BEVERAGES`, `ALCOHOL`
- Supplies: `CLEANING`, `PACKAGING`, `OTHER`

---

## 🔗 Related Documentation

- **Architecture & Flow**: `CLAUDE.md` lines 190-250
- **Testing & CI/CD**: `INVENTORY_TESTING.md`
- **Database Schema**: `DATABASE_SCHEMA.md`
- **Code Implementation**:
  - `src/services/dashboard/rawMaterial.service.ts` - Recipe deduction logic + `deductStockForModifiers()`
  - `src/services/dashboard/fifoBatch.service.ts` - FIFO batch allocation
  - `src/services/dashboard/modifierInventoryAnalytics.service.ts` - Modifier analytics
  - `src/services/dashboard/productInventoryIntegration.service.ts` - Orchestrates all inventory deductions
  - `src/services/tpv/payment.tpv.service.ts` - Payment triggers inventory deduction

---

**Document Purpose**: Technical reference for advanced inventory configuration, manual SQL setup, and troubleshooting. For high-level
architecture, see `CLAUDE.md`. For testing details, see `INVENTORY_TESTING.md`.
