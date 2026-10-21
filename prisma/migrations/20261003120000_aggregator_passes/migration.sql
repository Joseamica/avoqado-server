-- CreateEnum
CREATE TYPE "AggregatorProvider" AS ENUM ('TOTALPASS', 'WELLHUB');

-- CreateEnum
CREATE TYPE "AggregatorConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AggregatorConfirmMode" AS ENUM ('AUTO', 'ON_VENUE_CHECKIN');

-- CreateEnum
CREATE TYPE "AggregatorInboundKind" AS ENUM ('BOOKING', 'CHECKIN');

-- CreateEnum
CREATE TYPE "AggregatorEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "AggregatorBookingDecision" AS ENUM ('ACCEPTED', 'DENIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AggregatorVisitStatus" AS ENUM ('PENDING', 'CONFIRMED', 'ALREADY_CONFIRMED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AggregatorOutboxOperation" AS ENUM ('SYNC_SESSION', 'RESPOND_BOOKING', 'VALIDATE_VISIT', 'CANCEL_BOOKING');

-- CreateEnum
CREATE TYPE "AggregatorOutboxStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'FAILED', 'DEAD_LETTER', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AggregatorCapacityScope" AS ENUM ('DEFAULT', 'WEEKLY', 'SESSION');

-- CreateTable
CREATE TABLE "AggregatorConnection" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "provider" "AggregatorProvider" NOT NULL,
    "externalPlaceId" TEXT,
    "externalPlaceName" TEXT,
    "credentialCiphertext" BYTEA,
    "webhookToken" TEXT NOT NULL,
    "status" "AggregatorConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "confirmMode" "AggregatorConfirmMode" NOT NULL DEFAULT 'AUTO',
    "config" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AggregatorConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorProductLink" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "externalPlanId" TEXT NOT NULL,
    "externalPlanCode" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AggregatorProductLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorSessionLink" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "classSessionId" TEXT NOT NULL,
    "externalOccurrenceId" TEXT,
    "publishedStartsAt" TIMESTAMP(3),
    "publishedSpots" INTEGER,
    "publishedHash" TEXT,
    "live" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AggregatorSessionLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorCapacityRule" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "scope" "AggregatorCapacityScope" NOT NULL,
    "weekday" INTEGER,
    "startMinute" INTEGER,
    "classSessionId" TEXT,
    "maxSpots" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AggregatorCapacityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorBooking" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "provider" "AggregatorProvider" NOT NULL,
    "reservationId" TEXT,
    "classSessionId" TEXT,
    "externalBookingId" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "externalPlanCode" TEXT,
    "decision" "AggregatorBookingDecision" NOT NULL,
    "denyReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AggregatorBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorVisit" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "provider" "AggregatorProvider" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "externalCheckinId" TEXT NOT NULL,
    "validationRef" TEXT NOT NULL,
    "reservationId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "status" "AggregatorVisitStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AggregatorVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerExternalIdentity" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" "AggregatorProvider" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorInboundEvent" (
    "id" TEXT NOT NULL,
    "provider" "AggregatorProvider" NOT NULL,
    "connectionId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "kind" "AggregatorInboundKind" NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AggregatorEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AggregatorInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorOutbox" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "operation" "AggregatorOutboxOperation" NOT NULL,
    "classSessionId" TEXT,
    "aggregatorBookingId" TEXT,
    "aggregatorVisitId" TEXT,
    "coalesceKey" TEXT NOT NULL,
    "status" "AggregatorOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AggregatorOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorConnection_webhookToken_key" ON "AggregatorConnection"("webhookToken");

-- CreateIndex
CREATE INDEX "AggregatorConnection_status_idx" ON "AggregatorConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorConnection_venueId_provider_key" ON "AggregatorConnection"("venueId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorConnection_provider_externalPlaceId_key" ON "AggregatorConnection"("provider", "externalPlaceId");

-- CreateIndex
CREATE INDEX "AggregatorProductLink_venueId_idx" ON "AggregatorProductLink"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorProductLink_connectionId_productId_key" ON "AggregatorProductLink"("connectionId", "productId");

-- CreateIndex
CREATE INDEX "AggregatorSessionLink_connectionId_externalOccurrenceId_idx" ON "AggregatorSessionLink"("connectionId", "externalOccurrenceId");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorSessionLink_connectionId_classSessionId_key" ON "AggregatorSessionLink"("connectionId", "classSessionId");

-- CreateIndex
CREATE INDEX "AggregatorCapacityRule_venueId_scope_idx" ON "AggregatorCapacityRule"("venueId", "scope");

-- CreateIndex
CREATE INDEX "AggregatorCapacityRule_classSessionId_idx" ON "AggregatorCapacityRule"("classSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorBooking_reservationId_key" ON "AggregatorBooking"("reservationId");

-- CreateIndex
CREATE INDEX "AggregatorBooking_venueId_createdAt_idx" ON "AggregatorBooking"("venueId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorBooking_provider_externalBookingId_key" ON "AggregatorBooking"("provider", "externalBookingId");

-- CreateIndex
CREATE INDEX "AggregatorBooking_connectionId_classSessionId_idx" ON "AggregatorBooking"("connectionId", "classSessionId");

-- CreateIndex
CREATE INDEX "AggregatorBooking_connectionId_externalUserId_idx" ON "AggregatorBooking"("connectionId", "externalUserId");

-- CreateIndex
CREATE INDEX "AggregatorVisit_venueId_status_deadlineAt_idx" ON "AggregatorVisit"("venueId", "status", "deadlineAt");

-- CreateIndex
CREATE INDEX "AggregatorVisit_reservationId_idx" ON "AggregatorVisit"("reservationId");

-- CreateIndex
CREATE INDEX "AggregatorVisit_status_deadlineAt_idx" ON "AggregatorVisit"("status", "deadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorVisit_provider_externalCheckinId_key" ON "AggregatorVisit"("provider", "externalCheckinId");

-- CreateIndex
CREATE INDEX "CustomerExternalIdentity_customerId_idx" ON "CustomerExternalIdentity"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerExternalIdentity_venueId_provider_externalUserId_key" ON "CustomerExternalIdentity"("venueId", "provider", "externalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorInboundEvent_dedupKey_key" ON "AggregatorInboundEvent"("dedupKey");

-- CreateIndex
CREATE INDEX "AggregatorInboundEvent_status_nextAttemptAt_idx" ON "AggregatorInboundEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AggregatorInboundEvent_venueId_receivedAt_idx" ON "AggregatorInboundEvent"("venueId", "receivedAt");

-- CreateIndex
CREATE INDEX "AggregatorOutbox_status_scheduledAt_idx" ON "AggregatorOutbox"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "AggregatorOutbox_coalesceKey_status_idx" ON "AggregatorOutbox"("coalesceKey", "status");

-- AddForeignKey
ALTER TABLE "AggregatorConnection" ADD CONSTRAINT "AggregatorConnection_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorProductLink" ADD CONSTRAINT "AggregatorProductLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AggregatorConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorProductLink" ADD CONSTRAINT "AggregatorProductLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorSessionLink" ADD CONSTRAINT "AggregatorSessionLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AggregatorConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorSessionLink" ADD CONSTRAINT "AggregatorSessionLink_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorCapacityRule" ADD CONSTRAINT "AggregatorCapacityRule_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorBooking" ADD CONSTRAINT "AggregatorBooking_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AggregatorConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorBooking" ADD CONSTRAINT "AggregatorBooking_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorVisit" ADD CONSTRAINT "AggregatorVisit_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AggregatorConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorVisit" ADD CONSTRAINT "AggregatorVisit_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerExternalIdentity" ADD CONSTRAINT "CustomerExternalIdentity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorInboundEvent" ADD CONSTRAINT "AggregatorInboundEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AggregatorConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AggregatorOutbox" ADD CONSTRAINT "AggregatorOutbox_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AggregatorConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

