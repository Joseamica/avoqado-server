-- CreateEnum
CREATE TYPE "PlatformAnnouncementStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "platform_announcements" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageUrl" TEXT,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "contentBlocks" JSONB,
    "actionLabel" TEXT,
    "actionUrl" TEXT,
    "audienceRoles" "StaffRole"[] DEFAULT ARRAY['OWNER', 'ADMIN']::"StaffRole"[],
    "targetPlanTiers" "PlanTier"[] DEFAULT ARRAY[]::"PlanTier"[],
    "targetCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetVenueIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "showAsBanner" BOOLEAN NOT NULL DEFAULT false,
    "status" "PlatformAnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_announcement_clicks" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ctaAt" TIMESTAMP(3),

    CONSTRAINT "platform_announcement_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_announcements_status_publishedAt_idx" ON "platform_announcements"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "platform_announcements_status_scheduledFor_idx" ON "platform_announcements"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "platform_announcements_status_showAsBanner_idx" ON "platform_announcements"("status", "showAsBanner");

-- CreateIndex
CREATE INDEX "platform_announcement_clicks_announcementId_idx" ON "platform_announcement_clicks"("announcementId");

-- CreateIndex
CREATE INDEX "platform_announcement_clicks_staffId_idx" ON "platform_announcement_clicks"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_announcement_clicks_announcementId_staffId_key" ON "platform_announcement_clicks"("announcementId", "staffId");

-- AddForeignKey
ALTER TABLE "platform_announcement_clicks" ADD CONSTRAINT "platform_announcement_clicks_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "platform_announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_announcement_clicks" ADD CONSTRAINT "platform_announcement_clicks_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

