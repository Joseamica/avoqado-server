-- CreateEnum
CREATE TYPE "PosAppPlatform" AS ENUM ('ANDROID', 'IOS');

-- CreateEnum
CREATE TYPE "PosAppNoticeStyle" AS ENUM ('BANNER', 'MODAL');

-- CreateEnum
CREATE TYPE "PosAppNoticeKind" AS ENUM ('RECOMMENDED', 'REQUIRED');

-- AlterTable
ALTER TABLE "platform_announcements" ADD COLUMN     "posAppBelowVersionCode" INTEGER,
ADD COLUMN     "posAppBelowVersionName" TEXT,
ADD COLUMN     "posAppNoticeKind" "PosAppNoticeKind",
ADD COLUMN     "posAppPlatform" "PosAppPlatform";

-- CreateTable
CREATE TABLE "PosAppVersionPolicy" (
    "id" TEXT NOT NULL,
    "platform" "PosAppPlatform" NOT NULL,
    "requiredMinVersionCode" INTEGER,
    "requiredMinVersionName" TEXT,
    "recommendedMinVersionCode" INTEGER,
    "recommendedMinVersionName" TEXT,
    "message" TEXT,
    "recommendedNoticeStyle" "PosAppNoticeStyle",
    "recommendedAnnouncementId" TEXT,
    "requiredAnnouncementId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosAppVersionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosAppVersionPolicy_platform_key" ON "PosAppVersionPolicy"("platform");

-- CreateIndex
CREATE INDEX "platform_announcements_posAppPlatform_status_idx" ON "platform_announcements"("posAppPlatform", "status");

