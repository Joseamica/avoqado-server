-- AlterTable
ALTER TABLE "VenueSettings" ADD COLUMN     "managerPinOverrideEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PermissionOverride" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "authorizedById" TEXT NOT NULL,
    "requestedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedRoute" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PermissionOverride_token_key" ON "PermissionOverride"("token");

-- CreateIndex
CREATE INDEX "PermissionOverride_venueId_createdAt_idx" ON "PermissionOverride"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "PermissionOverride_expiresAt_idx" ON "PermissionOverride"("expiresAt");
