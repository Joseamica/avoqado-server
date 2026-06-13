-- CreateEnum
CREATE TYPE "public"."AppPlatform" AS ENUM ('ANDROID_TPV', 'WINDOWS_DESKTOP');

-- AlterTable
ALTER TABLE "public"."AppUpdate" ADD COLUMN     "platform" "public"."AppPlatform" NOT NULL DEFAULT 'ANDROID_TPV';
