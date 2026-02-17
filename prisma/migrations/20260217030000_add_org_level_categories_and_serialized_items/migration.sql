-- AlterTable: Make ItemCategory.venueId nullable, add organizationId
ALTER TABLE "ItemCategory" ALTER COLUMN "venueId" DROP NOT NULL;
ALTER TABLE "ItemCategory" ADD COLUMN "organizationId" TEXT;

-- AlterTable: Make SerializedItem.venueId nullable, add organizationId and sellingVenueId
ALTER TABLE "SerializedItem" ALTER COLUMN "venueId" DROP NOT NULL;
ALTER TABLE "SerializedItem" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "SerializedItem" ADD COLUMN "sellingVenueId" TEXT;

-- CreateIndex: ItemCategory org-level
CREATE INDEX "ItemCategory_organizationId_idx" ON "ItemCategory"("organizationId");

-- CreateIndex: SerializedItem org-level
CREATE INDEX "SerializedItem_organizationId_categoryId_idx" ON "SerializedItem"("organizationId", "categoryId");
CREATE INDEX "SerializedItem_organizationId_status_idx" ON "SerializedItem"("organizationId", "status");

-- Unique constraints for org-level (NULL venueId rows won't conflict with venue-level unique)
CREATE UNIQUE INDEX "ItemCategory_organizationId_name_key" ON "ItemCategory"("organizationId", "name");
CREATE UNIQUE INDEX "SerializedItem_organizationId_serialNumber_key" ON "SerializedItem"("organizationId", "serialNumber");

-- AddForeignKey: ItemCategory -> Organization
ALTER TABLE "ItemCategory" ADD CONSTRAINT "ItemCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: SerializedItem -> Organization
ALTER TABLE "SerializedItem" ADD CONSTRAINT "SerializedItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: SerializedItem -> Venue (sellingVenue)
ALTER TABLE "SerializedItem" ADD CONSTRAINT "SerializedItem_sellingVenueId_fkey" FOREIGN KEY ("sellingVenueId") REFERENCES "Venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
