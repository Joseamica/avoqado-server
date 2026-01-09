-- CreateEnum
CREATE TYPE "SerializedItemStatus" AS ENUM ('AVAILABLE', 'SOLD', 'RETURNED', 'DAMAGED');

-- CreateTable
CREATE TABLE "Module" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "configSchema" JSONB,
    "defaultConfig" JSONB NOT NULL,
    "presets" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenueModule" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "enabledBy" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemCategory" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "requiresPreRegistration" BOOLEAN NOT NULL DEFAULT true,
    "suggestedPrice" DECIMAL(10,2),
    "barcodePattern" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SerializedItem" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "status" "SerializedItemStatus" NOT NULL DEFAULT 'AVAILABLE',
    "soldAt" TIMESTAMP(3),
    "orderItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "SerializedItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Module_code_key" ON "Module"("code");

-- CreateIndex
CREATE INDEX "VenueModule_venueId_idx" ON "VenueModule"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "VenueModule_venueId_moduleId_key" ON "VenueModule"("venueId", "moduleId");

-- CreateIndex
CREATE INDEX "ItemCategory_venueId_idx" ON "ItemCategory"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemCategory_venueId_name_key" ON "ItemCategory"("venueId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SerializedItem_orderItemId_key" ON "SerializedItem"("orderItemId");

-- CreateIndex
CREATE INDEX "SerializedItem_venueId_categoryId_idx" ON "SerializedItem"("venueId", "categoryId");

-- CreateIndex
CREATE INDEX "SerializedItem_venueId_status_idx" ON "SerializedItem"("venueId", "status");

-- CreateIndex
CREATE INDEX "SerializedItem_serialNumber_idx" ON "SerializedItem"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SerializedItem_venueId_serialNumber_key" ON "SerializedItem"("venueId", "serialNumber");

-- AddForeignKey
ALTER TABLE "VenueModule" ADD CONSTRAINT "VenueModule_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenueModule" ADD CONSTRAINT "VenueModule_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemCategory" ADD CONSTRAINT "ItemCategory_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerializedItem" ADD CONSTRAINT "SerializedItem_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerializedItem" ADD CONSTRAINT "SerializedItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ItemCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerializedItem" ADD CONSTRAINT "SerializedItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
