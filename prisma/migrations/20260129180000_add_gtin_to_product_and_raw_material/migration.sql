-- AlterTable
ALTER TABLE "Product" ADD COLUMN "gtin" TEXT;

-- AlterTable
ALTER TABLE "RawMaterial" ADD COLUMN "gtin" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Product_venueId_gtin_key" ON "Product"("venueId", "gtin");

-- CreateIndex
CREATE UNIQUE INDEX "RawMaterial_venueId_gtin_key" ON "RawMaterial"("venueId", "gtin");
