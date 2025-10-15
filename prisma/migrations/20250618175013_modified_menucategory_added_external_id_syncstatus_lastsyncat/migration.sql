-- AlterTable
ALTER TABLE "MenuCategory" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "syncStatus" "SyncStatus" NOT NULL DEFAULT 'NOT_REQUIRED';

-- CreateIndex
CREATE INDEX "MenuCategory_syncStatus_idx" ON "MenuCategory"("syncStatus");
