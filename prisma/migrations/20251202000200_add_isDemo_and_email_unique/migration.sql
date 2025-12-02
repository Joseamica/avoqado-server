-- Add isDemo field to demo-seedable tables for selective cleanup on demo-to-real conversion

-- MenuCategory
ALTER TABLE "MenuCategory" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Menu
ALTER TABLE "Menu" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Product
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Inventory
ALTER TABLE "Inventory" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- RawMaterial
ALTER TABLE "RawMaterial" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Recipe
ALTER TABLE "Recipe" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- RecipeLine
ALTER TABLE "RecipeLine" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Area
ALTER TABLE "Area" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Table
ALTER TABLE "Table" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- ModifierGroup
ALTER TABLE "ModifierGroup" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Modifier
ALTER TABLE "Modifier" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- CustomerGroup
ALTER TABLE "CustomerGroup" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- LoyaltyConfig
ALTER TABLE "LoyaltyConfig" ADD COLUMN IF NOT EXISTS "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Make Staff email globally unique (industry standard: Stripe, Shopify, Toast)
-- First drop the compound unique if it exists
DROP INDEX IF EXISTS "Staff_email_organizationId_key";

-- Then create the simple unique index on email
CREATE UNIQUE INDEX IF NOT EXISTS "Staff_email_key" ON "Staff"("email");
