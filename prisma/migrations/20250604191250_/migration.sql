-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('RESTAURANT', 'RETAIL', 'HOTEL', 'FITNESS', 'SPA', 'OTHER');

-- CreateEnum
CREATE TYPE "VenueType" AS ENUM ('RESTAURANT', 'BAR', 'CAFE', 'FAST_FOOD', 'FOOD_TRUCK', 'RETAIL_STORE', 'HOTEL_RESTAURANT', 'FITNESS_STUDIO', 'SPA', 'OTHER');

-- CreateEnum
CREATE TYPE "PosType" AS ENUM ('SOFTRESTAURANT', 'SQUARE', 'TOAST', 'CLOVER', 'ALOHA', 'MICROS', 'NCR', 'CUSTOM', 'NONE');

-- CreateEnum
CREATE TYPE "PosStatus" AS ENUM ('NOT_INTEGRATED', 'CONNECTING', 'CONNECTED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('PERCENTAGE', 'FIXED', 'TIERED');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'WAITER', 'CASHIER', 'KITCHEN', 'HOST', 'VIEWER');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('APPETIZER', 'MAIN_COURSE', 'DESSERT', 'BEVERAGE', 'ALCOHOL', 'PRODUCT', 'SERVICE', 'OTHER');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('PURCHASE', 'SALE', 'ADJUSTMENT', 'LOSS', 'TRANSFER', 'COUNT');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('DINE_IN', 'TAKEOUT', 'DELIVERY', 'PICKUP');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('TPV', 'QR', 'WEB', 'APP', 'PHONE', 'POS');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "KitchenStatus" AS ENUM ('PENDING', 'RECEIVED', 'PREPARING', 'READY', 'SERVED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'DIGITAL_WALLET', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PAYMENT', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'PROCESSING', 'SETTLED', 'FAILED');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "FeatureCategory" AS ENUM ('OPERATIONS', 'PAYMENTS', 'MARKETING', 'ANALYTICS', 'INTEGRATIONS');

-- CreateEnum
CREATE TYPE "ChargeType" AS ENUM ('TRANSACTION_FEE', 'FEATURE_FEE', 'SETUP_FEE', 'OVERAGE_FEE', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'PENDING', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewSource" AS ENUM ('AVOQADO', 'GOOGLE', 'TRIPADVISOR', 'FACEBOOK', 'YELP');

-- CreateEnum
CREATE TYPE "TerminalType" AS ENUM ('TPV_ANDROID', 'TPV_IOS', 'PRINTER_RECEIPT', 'PRINTER_KITCHEN', 'KDS');

-- CreateEnum
CREATE TYPE "TerminalStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE', 'RETIRED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('EMAIL', 'GOOGLE', 'FACEBOOK', 'APPLE');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "taxId" TEXT,
    "type" "BusinessType" NOT NULL DEFAULT 'RESTAURANT',
    "billingEmail" TEXT,
    "billingAddress" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "VenueType" NOT NULL DEFAULT 'RESTAURANT',
    "timezone" TEXT NOT NULL DEFAULT 'America/Mexico_City',
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'MX',
    "zipCode" TEXT NOT NULL,
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "website" TEXT,
    "logo" TEXT,
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "operationalSince" TIMESTAMP(3),
    "posType" "PosType",
    "posConfig" JSONB,
    "posStatus" "PosStatus" NOT NULL DEFAULT 'NOT_INTEGRATED',
    "feeType" "FeeType" NOT NULL DEFAULT 'PERCENTAGE',
    "feeValue" DECIMAL(5,4) NOT NULL DEFAULT 0.025,
    "feeScheduleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Venue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueSettings" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "autoCloseShifts" BOOLEAN NOT NULL DEFAULT false,
    "shiftDuration" INTEGER NOT NULL DEFAULT 8,
    "requirePinLogin" BOOLEAN NOT NULL DEFAULT true,
    "autoReplyReviews" BOOLEAN NOT NULL DEFAULT false,
    "notifyBadReviews" BOOLEAN NOT NULL DEFAULT true,
    "badReviewThreshold" INTEGER NOT NULL DEFAULT 3,
    "trackInventory" BOOLEAN NOT NULL DEFAULT false,
    "lowStockAlert" BOOLEAN NOT NULL DEFAULT true,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 10,
    "allowReservations" BOOLEAN NOT NULL DEFAULT false,
    "allowTakeout" BOOLEAN NOT NULL DEFAULT false,
    "allowDelivery" BOOLEAN NOT NULL DEFAULT false,
    "acceptCash" BOOLEAN NOT NULL DEFAULT true,
    "acceptCard" BOOLEAN NOT NULL DEFAULT true,
    "acceptDigitalWallet" BOOLEAN NOT NULL DEFAULT true,
    "tipSuggestions" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "pin" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "employeeCode" TEXT,
    "photoUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffVenue" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "permissions" JSONB,
    "totalSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalTips" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "averageRating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),

    CONSTRAINT "StaffVenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "ProductCategory" NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "cost" DECIMAL(10,2),
    "taxRate" DECIMAL(5,4) NOT NULL DEFAULT 0.16,
    "imageUrl" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "trackInventory" BOOLEAN NOT NULL DEFAULT false,
    "unit" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "availableFrom" TIMESTAMP(3),
    "availableUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventory" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "currentStock" DECIMAL(10,2) NOT NULL,
    "reservedStock" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "minimumStock" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "maximumStock" DECIMAL(10,2),
    "lastRestockedAt" TIMESTAMP(3),
    "lastCountedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "inventoryId" TEXT NOT NULL,
    "type" "MovementType" NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "previousStock" DECIMAL(10,2) NOT NULL,
    "newStock" DECIMAL(10,2) NOT NULL,
    "reason" TEXT,
    "reference" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Table" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "section" TEXT,
    "capacity" INTEGER NOT NULL,
    "qrCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Table_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "startingCash" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "endingCash" DECIMAL(10,2),
    "cashDifference" DECIMAL(10,2),
    "totalSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalTips" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "type" "OrderType" NOT NULL DEFAULT 'DINE_IN',
    "source" "OrderSource" NOT NULL DEFAULT 'TPV',
    "tableId" TEXT,
    "shiftId" TEXT,
    "createdById" TEXT,
    "servedById" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(10,2) NOT NULL,
    "tipAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "kitchenStatus" "KitchenStatus" NOT NULL DEFAULT 'PENDING',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "externalId" TEXT,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "sentToKitchenAt" TIMESTAMP(3),
    "preparedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
    "minSelections" INTEGER NOT NULL DEFAULT 0,
    "maxSelections" INTEGER,

    CONSTRAINT "ModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Modifier" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Modifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductModifierGroup" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemModifier" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "modifierId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "price" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "OrderItemModifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shiftId" TEXT,
    "processedById" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "tipAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "method" "PaymentMethod" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "processor" TEXT,
    "processorId" TEXT,
    "processorData" JSONB,
    "feePercentage" DECIMAL(5,4) NOT NULL,
    "feeAmount" DECIMAL(10,2) NOT NULL,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "externalId" TEXT,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueTransaction" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "feeAmount" DECIMAL(10,2) NOT NULL,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "settledAt" TIMESTAMP(3),
    "settlementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenueTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feature" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "FeatureCategory" NOT NULL,
    "monthlyPrice" DECIMAL(10,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Feature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueFeature" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "featureId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "monthlyPrice" DECIMAL(10,2) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),

    CONSTRAINT "VenueFeature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeSchedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "FeeSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeTier" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "minVolume" DECIMAL(12,2) NOT NULL,
    "maxVolume" DECIMAL(12,2),
    "percentage" DECIMAL(5,4) NOT NULL,

    CONSTRAINT "FeeTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "taxAmount" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "type" "ChargeType" NOT NULL,
    "description" TEXT NOT NULL,
    "venueId" TEXT,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "overallRating" INTEGER NOT NULL,
    "foodRating" INTEGER,
    "serviceRating" INTEGER,
    "ambienceRating" INTEGER,
    "comment" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "source" "ReviewSource" NOT NULL DEFAULT 'AVOQADO',
    "externalId" TEXT,
    "responseText" TEXT,
    "respondedAt" TIMESTAMP(3),
    "responseAutomated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Terminal" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TerminalType" NOT NULL,
    "status" "TerminalStatus" NOT NULL DEFAULT 'INACTIVE',
    "lastHeartbeat" TIMESTAMP(3),
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Terminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "staffId" TEXT,
    "venueId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "data" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "birthDate" TIMESTAMP(3),
    "gender" TEXT,
    "password" TEXT,
    "provider" "AuthProvider" NOT NULL DEFAULT 'EMAIL',
    "providerId" TEXT,
    "language" TEXT NOT NULL DEFAULT 'es',
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Venue_slug_key" ON "Venue"("slug");

-- CreateIndex
CREATE INDEX "Venue_organizationId_idx" ON "Venue"("organizationId");

-- CreateIndex
CREATE INDEX "Venue_slug_idx" ON "Venue"("slug");

-- CreateIndex
CREATE INDEX "Venue_active_idx" ON "Venue"("active");

-- CreateIndex
CREATE UNIQUE INDEX "VenueSettings_venueId_key" ON "VenueSettings"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_email_key" ON "Staff"("email");

-- CreateIndex
CREATE INDEX "Staff_email_idx" ON "Staff"("email");

-- CreateIndex
CREATE INDEX "Staff_pin_idx" ON "Staff"("pin");

-- CreateIndex
CREATE INDEX "Staff_organizationId_idx" ON "Staff"("organizationId");

-- CreateIndex
CREATE INDEX "StaffVenue_staffId_idx" ON "StaffVenue"("staffId");

-- CreateIndex
CREATE INDEX "StaffVenue_venueId_idx" ON "StaffVenue"("venueId");

-- CreateIndex
CREATE INDEX "StaffVenue_role_idx" ON "StaffVenue"("role");

-- CreateIndex
CREATE UNIQUE INDEX "StaffVenue_staffId_venueId_key" ON "StaffVenue"("staffId", "venueId");

-- CreateIndex
CREATE INDEX "Product_venueId_idx" ON "Product"("venueId");

-- CreateIndex
CREATE INDEX "Product_category_idx" ON "Product"("category");

-- CreateIndex
CREATE INDEX "Product_active_idx" ON "Product"("active");

-- CreateIndex
CREATE UNIQUE INDEX "Product_venueId_sku_key" ON "Product"("venueId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Inventory_productId_key" ON "Inventory"("productId");

-- CreateIndex
CREATE INDEX "Inventory_productId_idx" ON "Inventory"("productId");

-- CreateIndex
CREATE INDEX "InventoryMovement_inventoryId_idx" ON "InventoryMovement"("inventoryId");

-- CreateIndex
CREATE INDEX "InventoryMovement_type_idx" ON "InventoryMovement"("type");

-- CreateIndex
CREATE INDEX "InventoryMovement_createdAt_idx" ON "InventoryMovement"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Table_qrCode_key" ON "Table"("qrCode");

-- CreateIndex
CREATE INDEX "Table_venueId_idx" ON "Table"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "Table_venueId_number_key" ON "Table"("venueId", "number");

-- CreateIndex
CREATE INDEX "Shift_venueId_idx" ON "Shift"("venueId");

-- CreateIndex
CREATE INDEX "Shift_staffId_idx" ON "Shift"("staffId");

-- CreateIndex
CREATE INDEX "Shift_status_idx" ON "Shift"("status");

-- CreateIndex
CREATE INDEX "Shift_startTime_idx" ON "Shift"("startTime");

-- CreateIndex
CREATE INDEX "Order_venueId_idx" ON "Order"("venueId");

-- CreateIndex
CREATE INDEX "Order_shiftId_idx" ON "Order"("shiftId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_venueId_orderNumber_key" ON "Order"("venueId", "orderNumber");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductModifierGroup_productId_groupId_key" ON "ProductModifierGroup"("productId", "groupId");

-- CreateIndex
CREATE INDEX "Payment_venueId_idx" ON "Payment"("venueId");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Payment_shiftId_idx" ON "Payment"("shiftId");

-- CreateIndex
CREATE INDEX "Payment_method_idx" ON "Payment"("method");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VenueTransaction_paymentId_key" ON "VenueTransaction"("paymentId");

-- CreateIndex
CREATE INDEX "VenueTransaction_venueId_idx" ON "VenueTransaction"("venueId");

-- CreateIndex
CREATE INDEX "VenueTransaction_status_idx" ON "VenueTransaction"("status");

-- CreateIndex
CREATE INDEX "VenueTransaction_createdAt_idx" ON "VenueTransaction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Feature_code_key" ON "Feature"("code");

-- CreateIndex
CREATE INDEX "VenueFeature_venueId_idx" ON "VenueFeature"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueFeature_venueId_featureId_key" ON "VenueFeature"("venueId", "featureId");

-- CreateIndex
CREATE INDEX "FeeTier_scheduleId_idx" ON "FeeTier"("scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_idx" ON "Invoice"("organizationId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Review_venueId_idx" ON "Review"("venueId");

-- CreateIndex
CREATE INDEX "Review_overallRating_idx" ON "Review"("overallRating");

-- CreateIndex
CREATE INDEX "Review_createdAt_idx" ON "Review"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Terminal_serialNumber_key" ON "Terminal"("serialNumber");

-- CreateIndex
CREATE INDEX "Terminal_venueId_idx" ON "Terminal"("venueId");

-- CreateIndex
CREATE INDEX "Terminal_status_idx" ON "Terminal"("status");

-- CreateIndex
CREATE INDEX "ActivityLog_staffId_idx" ON "ActivityLog"("staffId");

-- CreateIndex
CREATE INDEX "ActivityLog_venueId_idx" ON "ActivityLog"("venueId");

-- CreateIndex
CREATE INDEX "ActivityLog_entity_entityId_idx" ON "ActivityLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX "Customer_email_idx" ON "Customer"("email");

-- CreateIndex
CREATE INDEX "Customer_phone_idx" ON "Customer"("phone");

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venue" ADD CONSTRAINT "Venue_feeScheduleId_fkey" FOREIGN KEY ("feeScheduleId") REFERENCES "FeeSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueSettings" ADD CONSTRAINT "VenueSettings_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffVenue" ADD CONSTRAINT "StaffVenue_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffVenue" ADD CONSTRAINT "StaffVenue_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "Inventory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "Table"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_servedById_fkey" FOREIGN KEY ("servedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Modifier" ADD CONSTRAINT "Modifier_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemModifier" ADD CONSTRAINT "OrderItemModifier_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemModifier" ADD CONSTRAINT "OrderItemModifier_modifierId_fkey" FOREIGN KEY ("modifierId") REFERENCES "Modifier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueTransaction" ADD CONSTRAINT "VenueTransaction_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueTransaction" ADD CONSTRAINT "VenueTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueFeature" ADD CONSTRAINT "VenueFeature_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueFeature" ADD CONSTRAINT "VenueFeature_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeTier" ADD CONSTRAINT "FeeTier_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "FeeSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
