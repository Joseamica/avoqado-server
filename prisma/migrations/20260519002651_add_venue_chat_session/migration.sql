-- CreateEnum
CREATE TYPE "public"."VenueChatSessionStatus" AS ENUM ('OPEN', 'CLOSED_BY_INACTIVITY', 'CLOSED_BY_VENUE_DEACTIVATION', 'CLOSED_BY_CUSTOMER');

-- CreateTable
CREATE TABLE "public"."VenueChatSession" (
    "id" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "flowOrigin" TEXT NOT NULL DEFAULT 'appointments',
    "clientSessionNonce" TEXT,
    "requestFingerprintHash" TEXT NOT NULL,
    "status" "public"."VenueChatSessionStatus" NOT NULL DEFAULT 'OPEN',
    "accessTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCustomerSeenAt" TIMESTAMP(3),
    "lastEmailNotifiedAt" TIMESTAMP(3),

    CONSTRAINT "VenueChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VenueChatSession_clientSessionNonce_key" ON "public"."VenueChatSession"("clientSessionNonce");

-- CreateIndex
CREATE INDEX "VenueChatSession_venueId_lastActivityAt_idx" ON "public"."VenueChatSession"("venueId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "VenueChatSession_status_lastActivityAt_idx" ON "public"."VenueChatSession"("status", "lastActivityAt");

-- AddForeignKey
ALTER TABLE "public"."VenueChatSession" ADD CONSTRAINT "VenueChatSession_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
