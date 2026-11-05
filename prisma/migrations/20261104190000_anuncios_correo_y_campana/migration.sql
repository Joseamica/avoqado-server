-- AlterTable
ALTER TABLE "platform_announcements" ADD COLUMN     "showInInbox" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sendEmail" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "announcementEmailOptOutAt" TIMESTAMP(3);

-- CreateTable
-- `updatedAt` con DEFAULT: ver el comentario de platform_announcement_deliveries (servidor viejo durante el build).
CREATE TABLE "platform_announcement_emails" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "status" "PlatformAnnouncementDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "sendStartedAt" TIMESTAMP(3),
    "capDay" TEXT,
    "lastError" TEXT,
    "skippedReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_announcement_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_announcement_emails_status_nextAttemptAt_idx" ON "platform_announcement_emails"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "platform_announcement_emails_sentAt_idx" ON "platform_announcement_emails"("sentAt");

-- CreateIndex
CREATE INDEX "platform_announcement_emails_capDay_idx" ON "platform_announcement_emails"("capDay");

-- CreateIndex
CREATE UNIQUE INDEX "platform_announcement_emails_announcementId_staffId_key" ON "platform_announcement_emails"("announcementId", "staffId");

-- AddForeignKey
ALTER TABLE "platform_announcement_emails" ADD CONSTRAINT "platform_announcement_emails_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "platform_announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_announcement_emails" ADD CONSTRAINT "platform_announcement_emails_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
