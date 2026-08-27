-- CreateEnum
CREATE TYPE "PlatformAnnouncementDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "platform_announcement_deliveries" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "notificationId" TEXT,
ADD COLUMN     "status" "PlatformAnnouncementDeliveryStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "deliveredAt" DROP NOT NULL,
ALTER COLUMN "deliveredAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "platform_announcement_deliveries_status_nextAttemptAt_idx" ON "platform_announcement_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "platform_announcement_deliveries_status_leaseUntil_idx" ON "platform_announcement_deliveries"("status", "leaseUntil");

