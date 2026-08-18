-- AlterTable
ALTER TABLE "VenueRolePermission" ADD COLUMN     "deniedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];
