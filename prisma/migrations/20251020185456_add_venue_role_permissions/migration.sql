-- CreateTable
CREATE TABLE "public"."VenueRolePermission" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "role" "public"."StaffRole" NOT NULL,
    "permissions" TEXT[],
    "modifiedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueRolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueRolePermission_venueId_idx" ON "public"."VenueRolePermission"("venueId");

-- CreateIndex
CREATE INDEX "VenueRolePermission_role_idx" ON "public"."VenueRolePermission"("role");

-- CreateIndex
CREATE INDEX "VenueRolePermission_modifiedBy_idx" ON "public"."VenueRolePermission"("modifiedBy");

-- CreateIndex
CREATE UNIQUE INDEX "VenueRolePermission_venueId_role_key" ON "public"."VenueRolePermission"("venueId", "role");

-- AddForeignKey
ALTER TABLE "public"."VenueRolePermission" ADD CONSTRAINT "VenueRolePermission_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VenueRolePermission" ADD CONSTRAINT "VenueRolePermission_modifiedBy_fkey" FOREIGN KEY ("modifiedBy") REFERENCES "public"."Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
