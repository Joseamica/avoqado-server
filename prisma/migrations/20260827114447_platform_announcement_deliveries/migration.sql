-- CreateTable
CREATE TABLE "platform_announcement_deliveries" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_announcement_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_announcement_deliveries_staffId_announcementId_idx" ON "platform_announcement_deliveries"("staffId", "announcementId");

-- CreateIndex
CREATE INDEX "platform_announcement_deliveries_announcementId_idx" ON "platform_announcement_deliveries"("announcementId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_announcement_deliveries_announcementId_staffId_ven_key" ON "platform_announcement_deliveries"("announcementId", "staffId", "venueId");

-- AddForeignKey
ALTER TABLE "platform_announcement_deliveries" ADD CONSTRAINT "platform_announcement_deliveries_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "platform_announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_announcement_deliveries" ADD CONSTRAINT "platform_announcement_deliveries_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

