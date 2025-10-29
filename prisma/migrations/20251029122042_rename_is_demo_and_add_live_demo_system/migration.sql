-- AlterTable: Rename isDemo to isOnboardingDemo
ALTER TABLE "Venue" RENAME COLUMN "isDemo" TO "isOnboardingDemo";

-- AlterTable: Add Live Demo fields to Venue
ALTER TABLE "Venue" ADD COLUMN "isLiveDemo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Venue" ADD COLUMN "liveDemoSessionId" TEXT;
ALTER TABLE "Venue" ADD COLUMN "lastActivityAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

-- CreateTable: LiveDemoSession
CREATE TABLE "LiveDemoSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveDemoSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveDemoSession_sessionId_key" ON "LiveDemoSession"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveDemoSession_venueId_key" ON "LiveDemoSession"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveDemoSession_staffId_key" ON "LiveDemoSession"("staffId");

-- CreateIndex
CREATE INDEX "LiveDemoSession_sessionId_idx" ON "LiveDemoSession"("sessionId");

-- CreateIndex
CREATE INDEX "LiveDemoSession_expiresAt_idx" ON "LiveDemoSession"("expiresAt");

-- CreateIndex
CREATE INDEX "LiveDemoSession_lastActivityAt_idx" ON "LiveDemoSession"("lastActivityAt");

-- CreateIndex: Add unique constraint for liveDemoSessionId
CREATE UNIQUE INDEX "Venue_liveDemoSessionId_key" ON "Venue"("liveDemoSessionId");

-- AddForeignKey
ALTER TABLE "LiveDemoSession" ADD CONSTRAINT "LiveDemoSession_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveDemoSession" ADD CONSTRAINT "LiveDemoSession_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
