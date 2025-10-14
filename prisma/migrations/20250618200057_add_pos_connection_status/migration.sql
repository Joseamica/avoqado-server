-- CreateEnum
CREATE TYPE "PosConnectionState" AS ENUM ('ONLINE', 'OFFLINE', 'NEEDS_RECONCILIATION');

-- CreateTable
CREATE TABLE "PosConnectionStatus" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "status" "PosConnectionState" NOT NULL DEFAULT 'OFFLINE',
    "instanceId" TEXT,
    "producerVersion" TEXT,
    "lastHeartbeatAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosConnectionStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosConnectionStatus_venueId_key" ON "PosConnectionStatus"("venueId");

-- CreateIndex
CREATE INDEX "PosConnectionStatus_status_idx" ON "PosConnectionStatus"("status");

-- CreateIndex
CREATE INDEX "PosConnectionStatus_lastHeartbeatAt_idx" ON "PosConnectionStatus"("lastHeartbeatAt");

-- AddForeignKey
ALTER TABLE "PosConnectionStatus" ADD CONSTRAINT "PosConnectionStatus_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
