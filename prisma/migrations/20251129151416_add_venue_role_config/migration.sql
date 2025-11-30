-- CreateTable
CREATE TABLE "public"."VenueRoleConfig" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "role" "public"."StaffRole" NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueRoleConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenueRoleConfig_venueId_idx" ON "public"."VenueRoleConfig"("venueId");

-- CreateIndex
CREATE INDEX "VenueRoleConfig_role_idx" ON "public"."VenueRoleConfig"("role");

-- CreateIndex
CREATE UNIQUE INDEX "VenueRoleConfig_venueId_role_key" ON "public"."VenueRoleConfig"("venueId", "role");

-- AddForeignKey
ALTER TABLE "public"."VenueRoleConfig" ADD CONSTRAINT "VenueRoleConfig_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
