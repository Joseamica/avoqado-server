-- CreateEnum
CREATE TYPE "public"."RawMaterialCategory" AS ENUM ('MEAT', 'POULTRY', 'SEAFOOD', 'DAIRY', 'CHEESE', 'EGGS', 'VEGETABLES', 'FRUITS', 'GRAINS', 'BREAD', 'PASTA', 'RICE', 'BEANS', 'SPICES', 'HERBS', 'OILS', 'SAUCES', 'CONDIMENTS', 'BEVERAGES', 'ALCOHOL', 'CLEANING', 'PACKAGING', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."PurchaseOrderStatus" AS ENUM ('DRAFT', 'SENT', 'CONFIRMED', 'SHIPPED', 'RECEIVED', 'PARTIAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."PricingStrategy" AS ENUM ('MANUAL', 'AUTO_MARKUP', 'AUTO_TARGET_MARGIN');

-- CreateEnum
CREATE TYPE "public"."UnitCategory" AS ENUM ('WEIGHT', 'VOLUME', 'COUNT');

-- CreateEnum
CREATE TYPE "public"."RawMaterialMovementType" AS ENUM ('PURCHASE', 'USAGE', 'ADJUSTMENT', 'SPOILAGE', 'TRANSFER', 'COUNT', 'RETURN');

-- CreateEnum
CREATE TYPE "public"."AlertType" AS ENUM ('LOW_STOCK', 'OUT_OF_STOCK', 'EXPIRING_SOON', 'OVER_STOCK');

-- CreateEnum
CREATE TYPE "public"."AlertStatus" AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "public"."RawMaterial" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sku" TEXT NOT NULL,
    "category" "public"."RawMaterialCategory" NOT NULL DEFAULT 'OTHER',
    "currentStock" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "minimumStock" DECIMAL(12,3) NOT NULL,
    "reorderPoint" DECIMAL(12,3) NOT NULL,
    "maximumStock" DECIMAL(12,3),
    "reservedStock" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "costPerUnit" DECIMAL(10,4) NOT NULL,
    "avgCostPerUnit" DECIMAL(10,4) NOT NULL,
    "perishable" BOOLEAN NOT NULL DEFAULT false,
    "shelfLifeDays" INTEGER,
    "expirationDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastCountAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RawMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Recipe" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "portionYield" INTEGER NOT NULL DEFAULT 1,
    "totalCost" DECIMAL(10,4) NOT NULL,
    "prepTime" INTEGER,
    "cookTime" INTEGER,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RecipeLine" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "costPerServing" DECIMAL(10,4),
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "substituteNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Supplier" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT DEFAULT 'MX',
    "zipCode" TEXT,
    "taxId" TEXT,
    "rating" DECIMAL(3,2) NOT NULL DEFAULT 3.0,
    "reliabilityScore" DECIMAL(3,2) NOT NULL DEFAULT 0.7,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 3,
    "minimumOrder" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierPricing" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "pricePerUnit" DECIMAL(10,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "minimumQuantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "bulkDiscount" DECIMAL(5,4),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastOrderDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PurchaseOrder" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "public"."PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "orderDate" TIMESTAMP(3) NOT NULL,
    "expectedDeliveryDate" TIMESTAMP(3),
    "receivedDate" TIMESTAMP(3),
    "subtotal" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "taxRate" DECIMAL(5,4) NOT NULL DEFAULT 0.16,
    "createdById" TEXT,
    "createdBy" TEXT,
    "receivedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "quantityOrdered" DECIMAL(12,3) NOT NULL,
    "quantityReceived" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(10,4) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PricingPolicy" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "pricingStrategy" "public"."PricingStrategy" NOT NULL DEFAULT 'MANUAL',
    "targetFoodCostPercentage" DECIMAL(5,2),
    "targetMarkupPercentage" DECIMAL(5,2),
    "calculatedCost" DECIMAL(10,4) NOT NULL,
    "suggestedPrice" DECIMAL(10,2),
    "minimumPrice" DECIMAL(10,2),
    "currentPrice" DECIMAL(10,2) NOT NULL,
    "foodCostPercentage" DECIMAL(5,2),
    "lastReviewedAt" TIMESTAMP(3),
    "lastUpdatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UnitConversion" (
    "id" TEXT NOT NULL,
    "fromRawMaterialId" TEXT NOT NULL,
    "toRawMaterialId" TEXT NOT NULL,
    "fromUnit" TEXT NOT NULL,
    "toUnit" TEXT NOT NULL,
    "conversionFactor" DECIMAL(12,6) NOT NULL,
    "category" "public"."UnitCategory" NOT NULL DEFAULT 'WEIGHT',

    CONSTRAINT "UnitConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RawMaterialMovement" (
    "id" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "type" "public"."RawMaterialMovementType" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "previousStock" DECIMAL(12,3) NOT NULL,
    "newStock" DECIMAL(12,3) NOT NULL,
    "costImpact" DECIMAL(10,4),
    "reason" TEXT,
    "reference" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawMaterialMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LowStockAlert" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "alertType" "public"."AlertType" NOT NULL,
    "threshold" DECIMAL(12,3) NOT NULL,
    "currentLevel" DECIMAL(12,3) NOT NULL,
    "status" "public"."AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LowStockAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawMaterial_venueId_idx" ON "public"."RawMaterial"("venueId");

-- CreateIndex
CREATE INDEX "RawMaterial_category_idx" ON "public"."RawMaterial"("category");

-- CreateIndex
CREATE INDEX "RawMaterial_active_idx" ON "public"."RawMaterial"("active");

-- CreateIndex
CREATE INDEX "RawMaterial_currentStock_idx" ON "public"."RawMaterial"("currentStock");

-- CreateIndex
CREATE UNIQUE INDEX "RawMaterial_venueId_sku_key" ON "public"."RawMaterial"("venueId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_productId_key" ON "public"."Recipe"("productId");

-- CreateIndex
CREATE INDEX "Recipe_productId_idx" ON "public"."Recipe"("productId");

-- CreateIndex
CREATE INDEX "RecipeLine_recipeId_idx" ON "public"."RecipeLine"("recipeId");

-- CreateIndex
CREATE INDEX "RecipeLine_rawMaterialId_idx" ON "public"."RecipeLine"("rawMaterialId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeLine_recipeId_rawMaterialId_key" ON "public"."RecipeLine"("recipeId", "rawMaterialId");

-- CreateIndex
CREATE INDEX "Supplier_venueId_idx" ON "public"."Supplier"("venueId");

-- CreateIndex
CREATE INDEX "Supplier_active_idx" ON "public"."Supplier"("active");

-- CreateIndex
CREATE INDEX "Supplier_rating_idx" ON "public"."Supplier"("rating");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_venueId_name_key" ON "public"."Supplier"("venueId", "name");

-- CreateIndex
CREATE INDEX "SupplierPricing_supplierId_idx" ON "public"."SupplierPricing"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierPricing_rawMaterialId_idx" ON "public"."SupplierPricing"("rawMaterialId");

-- CreateIndex
CREATE INDEX "SupplierPricing_effectiveFrom_idx" ON "public"."SupplierPricing"("effectiveFrom");

-- CreateIndex
CREATE INDEX "SupplierPricing_active_idx" ON "public"."SupplierPricing"("active");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPricing_supplierId_rawMaterialId_effectiveFrom_key" ON "public"."SupplierPricing"("supplierId", "rawMaterialId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_orderNumber_key" ON "public"."PurchaseOrder"("orderNumber");

-- CreateIndex
CREATE INDEX "PurchaseOrder_venueId_idx" ON "public"."PurchaseOrder"("venueId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_supplierId_idx" ON "public"."PurchaseOrder"("supplierId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_status_idx" ON "public"."PurchaseOrder"("status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_orderDate_idx" ON "public"."PurchaseOrder"("orderDate");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_purchaseOrderId_idx" ON "public"."PurchaseOrderItem"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderItem_rawMaterialId_idx" ON "public"."PurchaseOrderItem"("rawMaterialId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingPolicy_productId_key" ON "public"."PricingPolicy"("productId");

-- CreateIndex
CREATE INDEX "PricingPolicy_venueId_idx" ON "public"."PricingPolicy"("venueId");

-- CreateIndex
CREATE INDEX "PricingPolicy_pricingStrategy_idx" ON "public"."PricingPolicy"("pricingStrategy");

-- CreateIndex
CREATE INDEX "UnitConversion_fromUnit_idx" ON "public"."UnitConversion"("fromUnit");

-- CreateIndex
CREATE INDEX "UnitConversion_toUnit_idx" ON "public"."UnitConversion"("toUnit");

-- CreateIndex
CREATE INDEX "UnitConversion_category_idx" ON "public"."UnitConversion"("category");

-- CreateIndex
CREATE UNIQUE INDEX "UnitConversion_fromUnit_toUnit_category_key" ON "public"."UnitConversion"("fromUnit", "toUnit", "category");

-- CreateIndex
CREATE INDEX "RawMaterialMovement_rawMaterialId_idx" ON "public"."RawMaterialMovement"("rawMaterialId");

-- CreateIndex
CREATE INDEX "RawMaterialMovement_venueId_idx" ON "public"."RawMaterialMovement"("venueId");

-- CreateIndex
CREATE INDEX "RawMaterialMovement_type_idx" ON "public"."RawMaterialMovement"("type");

-- CreateIndex
CREATE INDEX "RawMaterialMovement_createdAt_idx" ON "public"."RawMaterialMovement"("createdAt");

-- CreateIndex
CREATE INDEX "LowStockAlert_venueId_idx" ON "public"."LowStockAlert"("venueId");

-- CreateIndex
CREATE INDEX "LowStockAlert_rawMaterialId_idx" ON "public"."LowStockAlert"("rawMaterialId");

-- CreateIndex
CREATE INDEX "LowStockAlert_status_idx" ON "public"."LowStockAlert"("status");

-- CreateIndex
CREATE INDEX "LowStockAlert_alertType_idx" ON "public"."LowStockAlert"("alertType");

-- CreateIndex
CREATE INDEX "LowStockAlert_createdAt_idx" ON "public"."LowStockAlert"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."RawMaterial" ADD CONSTRAINT "RawMaterial_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Recipe" ADD CONSTRAINT "Recipe_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecipeLine" ADD CONSTRAINT "RecipeLine_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecipeLine" ADD CONSTRAINT "RecipeLine_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "public"."RawMaterial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Supplier" ADD CONSTRAINT "Supplier_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierPricing" ADD CONSTRAINT "SupplierPricing_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SupplierPricing" ADD CONSTRAINT "SupplierPricing_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "public"."RawMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "public"."Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "public"."RawMaterial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PricingPolicy" ADD CONSTRAINT "PricingPolicy_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PricingPolicy" ADD CONSTRAINT "PricingPolicy_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UnitConversion" ADD CONSTRAINT "UnitConversion_fromRawMaterialId_fkey" FOREIGN KEY ("fromRawMaterialId") REFERENCES "public"."RawMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UnitConversion" ADD CONSTRAINT "UnitConversion_toRawMaterialId_fkey" FOREIGN KEY ("toRawMaterialId") REFERENCES "public"."RawMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RawMaterialMovement" ADD CONSTRAINT "RawMaterialMovement_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "public"."RawMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RawMaterialMovement" ADD CONSTRAINT "RawMaterialMovement_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LowStockAlert" ADD CONSTRAINT "LowStockAlert_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LowStockAlert" ADD CONSTRAINT "LowStockAlert_rawMaterialId_fkey" FOREIGN KEY ("rawMaterialId") REFERENCES "public"."RawMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

