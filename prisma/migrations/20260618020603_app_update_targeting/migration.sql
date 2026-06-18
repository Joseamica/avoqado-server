-- CreateEnum
CREATE TYPE "AppUpdateTargetType" AS ENUM ('ALL', 'VENUES', 'TERMINALS');

-- AlterTable
ALTER TABLE "AppUpdate" ADD COLUMN     "targetType" "AppUpdateTargetType" NOT NULL DEFAULT 'ALL',
ADD COLUMN     "targetVenueIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "targetTerminalIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
