-- Add isDemo field to demo-seedable tables for selective cleanup on demo-to-real conversion

-- MenuCategory
ALTER TABLE "MenuCategory" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Menu
ALTER TABLE "Menu" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Product
ALTER TABLE "Product" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Inventory
ALTER TABLE "Inventory" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- RawMaterial
ALTER TABLE "RawMaterial" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Recipe
ALTER TABLE "Recipe" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- RecipeLine
ALTER TABLE "RecipeLine" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Area
ALTER TABLE "Area" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Table
ALTER TABLE "Table" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- ModifierGroup
ALTER TABLE "ModifierGroup" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- Modifier
ALTER TABLE "Modifier" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- CustomerGroup
ALTER TABLE "CustomerGroup" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- LoyaltyConfig
ALTER TABLE "LoyaltyConfig" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
