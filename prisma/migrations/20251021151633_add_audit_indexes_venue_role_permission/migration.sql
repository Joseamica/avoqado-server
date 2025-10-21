-- CreateIndex
CREATE INDEX "VenueRolePermission_venueId_updatedAt_idx" ON "public"."VenueRolePermission"("venueId", "updatedAt");

-- CreateIndex
CREATE INDEX "VenueRolePermission_modifiedBy_updatedAt_idx" ON "public"."VenueRolePermission"("modifiedBy", "updatedAt");
