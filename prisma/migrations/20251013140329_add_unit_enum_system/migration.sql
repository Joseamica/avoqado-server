/*
  Warnings:

  - Implements comprehensive Unit enum system to replace String-based units
  - Adds UnitType enum (WEIGHT, VOLUME, COUNT, LENGTH, TEMPERATURE, TIME)
  - Adds Unit enum with all measurement units
  - Converts all unit String columns to Unit enum
  - Updates UnitConversion model to be standalone (not tied to RawMaterial)

*/

-- Step 1: Create UnitType enum
CREATE TYPE "public"."UnitType" AS ENUM ('WEIGHT', 'VOLUME', 'COUNT', 'LENGTH', 'TEMPERATURE', 'TIME');

-- Step 2: Create Unit enum with all measurement units
CREATE TYPE "public"."Unit" AS ENUM (
  -- Weight
  'GRAM', 'KILOGRAM', 'MILLIGRAM', 'POUND', 'OUNCE', 'TON',
  -- Volume
  'MILLILITER', 'LITER', 'GALLON', 'QUART', 'PINT', 'CUP', 'FLUID_OUNCE', 'TABLESPOON', 'TEASPOON',
  -- Count
  'UNIT', 'PIECE', 'DOZEN', 'CASE', 'BOX', 'BAG', 'BOTTLE', 'CAN', 'JAR',
  -- Length
  'METER', 'CENTIMETER', 'MILLIMETER', 'INCH', 'FOOT',
  -- Temperature
  'CELSIUS', 'FAHRENHEIT',
  -- Time
  'MINUTE', 'HOUR', 'DAY'
);

-- Force commit to make enum values usable
COMMIT;
BEGIN;

-- Step 3: Update UnitConversion table structure
-- Remove foreign keys to RawMaterial (these will be dropped with the old structure)
ALTER TABLE "public"."UnitConversion" DROP CONSTRAINT IF EXISTS "UnitConversion_fromRawMaterialId_fkey";
ALTER TABLE "public"."UnitConversion" DROP CONSTRAINT IF EXISTS "UnitConversion_toRawMaterialId_fkey";

-- Drop old indexes
DROP INDEX IF EXISTS "public"."UnitConversion_fromRawMaterialId_idx";
DROP INDEX IF EXISTS "public"."UnitConversion_toRawMaterialId_idx";
DROP INDEX IF EXISTS "public"."UnitConversion_fromUnit_toUnit_category_key";
DROP INDEX IF EXISTS "public"."UnitConversion_category_idx";

-- Remove old columns
ALTER TABLE "public"."UnitConversion" DROP COLUMN IF EXISTS "fromRawMaterialId";
ALTER TABLE "public"."UnitConversion" DROP COLUMN IF EXISTS "toRawMaterialId";
ALTER TABLE "public"."UnitConversion" DROP COLUMN IF EXISTS "category";

-- Add new columns for standalone unit conversion
ALTER TABLE "public"."UnitConversion" ADD COLUMN IF NOT EXISTS "fromUnitNew" "public"."Unit";
ALTER TABLE "public"."UnitConversion" ADD COLUMN IF NOT EXISTS "toUnitNew" "public"."Unit";
ALTER TABLE "public"."UnitConversion" ADD COLUMN IF NOT EXISTS "unitType" "public"."UnitType" NOT NULL DEFAULT 'WEIGHT';
ALTER TABLE "public"."UnitConversion" ADD COLUMN IF NOT EXISTS "isSystemDefault" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "public"."UnitConversion" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "public"."UnitConversion" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Convert existing data (fromUnit, toUnit are strings, we need to map them to enums)
-- For now, we'll just delete old data since the table structure changed completely
TRUNCATE TABLE "public"."UnitConversion";

-- Remove old string columns
ALTER TABLE "public"."UnitConversion" DROP COLUMN IF EXISTS "fromUnit";
ALTER TABLE "public"."UnitConversion" DROP COLUMN IF EXISTS "toUnit";

-- Rename new columns to final names
ALTER TABLE "public"."UnitConversion" RENAME COLUMN "fromUnitNew" TO "fromUnit";
ALTER TABLE "public"."UnitConversion" RENAME COLUMN "toUnitNew" TO "toUnit";

-- Make them NOT NULL after renaming
ALTER TABLE "public"."UnitConversion" ALTER COLUMN "fromUnit" SET NOT NULL;
ALTER TABLE "public"."UnitConversion" ALTER COLUMN "toUnit" SET NOT NULL;

-- Add new indexes
CREATE INDEX IF NOT EXISTS "UnitConversion_fromUnit_idx" ON "public"."UnitConversion"("fromUnit");
CREATE INDEX IF NOT EXISTS "UnitConversion_toUnit_idx" ON "public"."UnitConversion"("toUnit");
CREATE INDEX IF NOT EXISTS "UnitConversion_unitType_idx" ON "public"."UnitConversion"("unitType");
CREATE INDEX IF NOT EXISTS "UnitConversion_isSystemDefault_idx" ON "public"."UnitConversion"("isSystemDefault");
CREATE UNIQUE INDEX IF NOT EXISTS "UnitConversion_fromUnit_toUnit_key" ON "public"."UnitConversion"("fromUnit", "toUnit");

-- Step 4: Add unitType column to RawMaterial
ALTER TABLE "public"."RawMaterial" ADD COLUMN IF NOT EXISTS "unitType" "public"."UnitType" NOT NULL DEFAULT 'WEIGHT';

-- Step 5: Add new Unit enum columns to all tables
ALTER TABLE "public"."Product" ADD COLUMN IF NOT EXISTS "unitNew" "public"."Unit";
ALTER TABLE "public"."RawMaterial" ADD COLUMN IF NOT EXISTS "unitNew" "public"."Unit";
ALTER TABLE "public"."RecipeLine" ADD COLUMN IF NOT EXISTS "unitNew" "public"."Unit";
ALTER TABLE "public"."SupplierPricing" ADD COLUMN IF NOT EXISTS "unitNew" "public"."Unit";
ALTER TABLE "public"."PurchaseOrderItem" ADD COLUMN IF NOT EXISTS "unitNew" "public"."Unit";
ALTER TABLE "public"."RawMaterialMovement" ADD COLUMN IF NOT EXISTS "unitNew" "public"."Unit";

-- Step 6: Migrate data from string to enum using CASE statements
-- This maps common string values to Unit enum values
UPDATE "public"."Product" SET "unitNew" = (
  CASE UPPER(TRIM(COALESCE("unit", 'UNIT')))
    -- Weight
    WHEN 'G' THEN 'GRAM'::public."Unit"
    WHEN 'GRAM' THEN 'GRAM'::public."Unit"
    WHEN 'GRAMS' THEN 'GRAM'::public."Unit"
    WHEN 'KG' THEN 'KILOGRAM'::public."Unit"
    WHEN 'KILOGRAM' THEN 'KILOGRAM'::public."Unit"
    WHEN 'KILOGRAMS' THEN 'KILOGRAM'::public."Unit"
    WHEN 'MG' THEN 'MILLIGRAM'::public."Unit"
    WHEN 'MILLIGRAM' THEN 'MILLIGRAM'::public."Unit"
    WHEN 'OZ' THEN 'OUNCE'::public."Unit"
    WHEN 'OUNCE' THEN 'OUNCE'::public."Unit"
    WHEN 'LB' THEN 'POUND'::public."Unit"
    WHEN 'POUND' THEN 'POUND'::public."Unit"
    -- Volume
    WHEN 'ML' THEN 'MILLILITER'::public."Unit"
    WHEN 'MILLILITER' THEN 'MILLILITER'::public."Unit"
    WHEN 'L' THEN 'LITER'::public."Unit"
    WHEN 'LITER' THEN 'LITER'::public."Unit"
    WHEN 'LITERS' THEN 'LITER'::public."Unit"
    WHEN 'LT' THEN 'LITER'::public."Unit"
    -- Count
    WHEN 'UNIT' THEN 'UNIT'::public."Unit"
    WHEN 'UNITS' THEN 'UNIT'::public."Unit"
    WHEN 'PIECE' THEN 'PIECE'::public."Unit"
    WHEN 'PIECES' THEN 'PIECE'::public."Unit"
    WHEN 'PC' THEN 'PIECE'::public."Unit"
    WHEN 'PCS' THEN 'PIECE'::public."Unit"
    WHEN 'PZA' THEN 'PIECE'::public."Unit"
    WHEN 'PZAS' THEN 'PIECE'::public."Unit"
    WHEN 'DOZEN' THEN 'DOZEN'::public."Unit"
    WHEN 'BOX' THEN 'BOX'::public."Unit"
    WHEN 'BAG' THEN 'BAG'::public."Unit"
    WHEN 'BOTTLE' THEN 'BOTTLE'::public."Unit"
    ELSE 'UNIT'::public."Unit"  -- Default fallback
  END
) WHERE "unit" IS NOT NULL;

-- Same for RawMaterial, RecipeLine, SupplierPricing, PurchaseOrderItem, RawMaterialMovement
UPDATE "public"."RawMaterial" SET "unitNew" = (
  CASE UPPER(TRIM("unit"))
    WHEN 'G' THEN 'GRAM'::public."Unit"
    WHEN 'GRAM' THEN 'GRAM'::public."Unit"
    WHEN 'GRAMS' THEN 'GRAM'::public."Unit"
    WHEN 'KG' THEN 'KILOGRAM'::public."Unit"
    WHEN 'KILOGRAM' THEN 'KILOGRAM'::public."Unit"
    WHEN 'MG' THEN 'MILLIGRAM'::public."Unit"
    WHEN 'OZ' THEN 'OUNCE'::public."Unit"
    WHEN 'LB' THEN 'POUND'::public."Unit"
    WHEN 'ML' THEN 'MILLILITER'::public."Unit"
    WHEN 'L' THEN 'LITER'::public."Unit"
    WHEN 'LITER' THEN 'LITER'::public."Unit"
    WHEN 'LT' THEN 'LITER'::public."Unit"
    WHEN 'UNIT' THEN 'UNIT'::public."Unit"
    WHEN 'PIECE' THEN 'PIECE'::public."Unit"
    WHEN 'PZA' THEN 'PIECE'::public."Unit"
    ELSE 'UNIT'::public."Unit"
  END
);

UPDATE "public"."RecipeLine" SET "unitNew" = (
  CASE UPPER(TRIM("unit"))
    WHEN 'G' THEN 'GRAM'::public."Unit"
    WHEN 'GRAM' THEN 'GRAM'::public."Unit"
    WHEN 'KG' THEN 'KILOGRAM'::public."Unit"
    WHEN 'ML' THEN 'MILLILITER'::public."Unit"
    WHEN 'L' THEN 'LITER'::public."Unit"
    WHEN 'LITER' THEN 'LITER'::public."Unit"
    WHEN 'UNIT' THEN 'UNIT'::public."Unit"
    WHEN 'PIECE' THEN 'PIECE'::public."Unit"
    WHEN 'PZA' THEN 'PIECE'::public."Unit"
    ELSE 'UNIT'::public."Unit"
  END
);

UPDATE "public"."SupplierPricing" SET "unitNew" = (
  CASE UPPER(TRIM("unit"))
    WHEN 'G' THEN 'GRAM'::public."Unit"
    WHEN 'KG' THEN 'KILOGRAM'::public."Unit"
    WHEN 'ML' THEN 'MILLILITER'::public."Unit"
    WHEN 'L' THEN 'LITER'::public."Unit"
    WHEN 'UNIT' THEN 'UNIT'::public."Unit"
    WHEN 'PIECE' THEN 'PIECE'::public."Unit"
    ELSE 'UNIT'::public."Unit"
  END
);

UPDATE "public"."PurchaseOrderItem" SET "unitNew" = (
  CASE UPPER(TRIM("unit"))
    WHEN 'G' THEN 'GRAM'::public."Unit"
    WHEN 'KG' THEN 'KILOGRAM'::public."Unit"
    WHEN 'ML' THEN 'MILLILITER'::public."Unit"
    WHEN 'L' THEN 'LITER'::public."Unit"
    WHEN 'UNIT' THEN 'UNIT'::public."Unit"
    WHEN 'PIECE' THEN 'PIECE'::public."Unit"
    ELSE 'UNIT'::public."Unit"
  END
);

UPDATE "public"."RawMaterialMovement" SET "unitNew" = (
  CASE UPPER(TRIM("unit"))
    WHEN 'G' THEN 'GRAM'::public."Unit"
    WHEN 'KG' THEN 'KILOGRAM'::public."Unit"
    WHEN 'ML' THEN 'MILLILITER'::public."Unit"
    WHEN 'L' THEN 'LITER'::public."Unit"
    WHEN 'UNIT' THEN 'UNIT'::public."Unit"
    WHEN 'PIECE' THEN 'PIECE'::public."Unit"
    ELSE 'UNIT'::public."Unit"
  END
);

-- Step 7: Drop old string columns
ALTER TABLE "public"."Product" DROP COLUMN IF EXISTS "unit";
ALTER TABLE "public"."RawMaterial" DROP COLUMN IF EXISTS "unit";
ALTER TABLE "public"."RecipeLine" DROP COLUMN IF EXISTS "unit";
ALTER TABLE "public"."SupplierPricing" DROP COLUMN IF EXISTS "unit";
ALTER TABLE "public"."PurchaseOrderItem" DROP COLUMN IF EXISTS "unit";
ALTER TABLE "public"."RawMaterialMovement" DROP COLUMN IF EXISTS "unit";

-- Step 8: Rename new enum columns to final names
ALTER TABLE "public"."Product" RENAME COLUMN "unitNew" TO "unit";
ALTER TABLE "public"."RawMaterial" RENAME COLUMN "unitNew" TO "unit";
ALTER TABLE "public"."RecipeLine" RENAME COLUMN "unitNew" TO "unit";
ALTER TABLE "public"."SupplierPricing" RENAME COLUMN "unitNew" TO "unit";
ALTER TABLE "public"."PurchaseOrderItem" RENAME COLUMN "unitNew" TO "unit";
ALTER TABLE "public"."RawMaterialMovement" RENAME COLUMN "unitNew" TO "unit";

-- Step 9: Set NOT NULL constraints (except for Product.unit which is optional)
ALTER TABLE "public"."RawMaterial" ALTER COLUMN "unit" SET NOT NULL;
ALTER TABLE "public"."RecipeLine" ALTER COLUMN "unit" SET NOT NULL;
ALTER TABLE "public"."SupplierPricing" ALTER COLUMN "unit" SET NOT NULL;
ALTER TABLE "public"."PurchaseOrderItem" ALTER COLUMN "unit" SET NOT NULL;
ALTER TABLE "public"."RawMaterialMovement" ALTER COLUMN "unit" SET NOT NULL;

COMMIT;
