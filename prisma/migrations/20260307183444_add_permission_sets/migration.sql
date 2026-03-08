-- AlterTable
ALTER TABLE "public"."StaffVenue" ADD COLUMN     "permissionSetId" TEXT;

-- CreateTable
CREATE TABLE "public"."PermissionSet" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "color" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PermissionSet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PermissionSet_venueId_idx" ON "public"."PermissionSet"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionSet_venueId_name_key" ON "public"."PermissionSet"("venueId", "name");

-- CreateIndex
CREATE INDEX "StaffVenue_permissionSetId_idx" ON "public"."StaffVenue"("permissionSetId");

-- AddForeignKey
ALTER TABLE "public"."StaffVenue" ADD CONSTRAINT "StaffVenue_permissionSetId_fkey" FOREIGN KEY ("permissionSetId") REFERENCES "public"."PermissionSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PermissionSet" ADD CONSTRAINT "PermissionSet_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PermissionSet" ADD CONSTRAINT "PermissionSet_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
