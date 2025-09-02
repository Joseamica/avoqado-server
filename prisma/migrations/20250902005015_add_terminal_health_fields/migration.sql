-- AlterTable
ALTER TABLE "public"."Terminal" ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "systemInfo" JSONB,
ADD COLUMN     "version" TEXT;
