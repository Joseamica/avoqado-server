-- Google Calendar Sync — Phase 1 schema
-- Adds 5 new tables (Connection, Channel, ExternalBusyBlock, WebhookInbox, OAuthSession)
-- plus a CHECK constraint enforcing scope/venueId/staffId integrity and partial
-- unique indexes that allow only one VENUE-master per venue and only one
-- STAFF_PERSONAL connection per staff (Postgres unique indexes treat NULLs as
-- distinct, so the partial-index form is required for "exactly one or none").

-- CreateEnum
CREATE TYPE "GoogleCalendarConnectionScope" AS ENUM ('VENUE', 'STAFF_PERSONAL');

-- CreateEnum
CREATE TYPE "GoogleCalendarConnectionStatus" AS ENUM ('CONNECTED', 'TOKEN_REVOKED', 'CALENDAR_LOST', 'WATCH_FAILED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "GoogleCalendarChannelStatus" AS ENUM ('ACTIVE', 'RENEWING', 'EXPIRED', 'STOPPED');

-- CreateTable
CREATE TABLE "GoogleCalendarConnection" (
    "id" TEXT NOT NULL,
    "scope" "GoogleCalendarConnectionScope" NOT NULL,
    "venueId" TEXT,
    "staffId" TEXT,
    "googleAccountEmail" TEXT NOT NULL,
    "googleAccountSub" TEXT NOT NULL,
    "selectedCalendarId" TEXT NOT NULL,
    "selectedCalendarSummary" TEXT NOT NULL,
    "selectedCalendarTimeZone" TEXT NOT NULL,
    "refreshTokenCiphertext" BYTEA NOT NULL,
    "accessTokenCiphertext" BYTEA,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "syncToken" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastHorizonEnd" TIMESTAMP(3),
    "status" "GoogleCalendarConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "statusReason" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "createdByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleCalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleCalendarChannel" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "GoogleCalendarChannelStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "GoogleCalendarChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalBusyBlock" (
    "id" TEXT NOT NULL,
    "googleConnectionId" TEXT NOT NULL,
    "venueId" TEXT,
    "staffId" TEXT,
    "externalSource" TEXT NOT NULL DEFAULT 'GOOGLE',
    "externalCalendarId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalBusyBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleCalendarWebhookInbox" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceState" TEXT NOT NULL,
    "messageNumber" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "GoogleCalendarWebhookInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleOAuthSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "authUserId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "venueId" TEXT,
    "staffId" TEXT,
    "encryptedRefreshToken" BYTEA NOT NULL,
    "encryptedAccessToken" BYTEA NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "googleAccountEmail" TEXT NOT NULL,
    "googleAccountSub" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "GoogleOAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleCalendarConnection_venueId_idx" ON "GoogleCalendarConnection"("venueId");

-- CreateIndex
CREATE INDEX "GoogleCalendarConnection_staffId_idx" ON "GoogleCalendarConnection"("staffId");

-- CreateIndex
CREATE INDEX "GoogleCalendarConnection_status_idx" ON "GoogleCalendarConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleCalendarChannel_channelId_key" ON "GoogleCalendarChannel"("channelId");

-- CreateIndex
CREATE INDEX "GoogleCalendarChannel_connectionId_status_idx" ON "GoogleCalendarChannel"("connectionId", "status");

-- CreateIndex
CREATE INDEX "GoogleCalendarChannel_expiresAt_status_idx" ON "GoogleCalendarChannel"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "GoogleCalendarChannel_resourceId_idx" ON "GoogleCalendarChannel"("resourceId");

-- CreateIndex
CREATE INDEX "ExternalBusyBlock_venueId_startsAt_endsAt_idx" ON "ExternalBusyBlock"("venueId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "ExternalBusyBlock_staffId_startsAt_endsAt_idx" ON "ExternalBusyBlock"("staffId", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalBusyBlock_googleConnectionId_externalEventId_key" ON "ExternalBusyBlock"("googleConnectionId", "externalEventId");

-- CreateIndex
CREATE INDEX "GoogleCalendarWebhookInbox_processedAt_receivedAt_idx" ON "GoogleCalendarWebhookInbox"("processedAt", "receivedAt");

-- CreateIndex
CREATE INDEX "GoogleCalendarWebhookInbox_connectionId_processedAt_idx" ON "GoogleCalendarWebhookInbox"("connectionId", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleOAuthSession_tokenHash_key" ON "GoogleOAuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "GoogleOAuthSession_expiresAt_idx" ON "GoogleOAuthSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "GoogleCalendarConnection" ADD CONSTRAINT "GoogleCalendarConnection_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleCalendarConnection" ADD CONSTRAINT "GoogleCalendarConnection_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleCalendarConnection" ADD CONSTRAINT "GoogleCalendarConnection_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleCalendarChannel" ADD CONSTRAINT "GoogleCalendarChannel_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GoogleCalendarConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalBusyBlock" ADD CONSTRAINT "ExternalBusyBlock_googleConnectionId_fkey" FOREIGN KEY ("googleConnectionId") REFERENCES "GoogleCalendarConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enforce "exactly one of venueId/staffId, matching scope"
ALTER TABLE "GoogleCalendarConnection"
  ADD CONSTRAINT "gcal_conn_scope_xor" CHECK (
    (scope = 'VENUE'          AND "venueId" IS NOT NULL AND "staffId" IS NULL) OR
    (scope = 'STAFF_PERSONAL' AND "staffId" IS NOT NULL AND "venueId" IS NULL)
  );

-- One venue-master per venue, one personal connection per staff.
-- Postgres unique indexes treat NULLs as distinct, so plain `@@unique([venueId])`
-- on a nullable column would not prevent two STAFF_PERSONAL rows (both with
-- venueId = NULL) — we need partial indexes scoped to each scope value.
CREATE UNIQUE INDEX "gcal_conn_venue_unique"
  ON "GoogleCalendarConnection"("venueId") WHERE "scope" = 'VENUE';
CREATE UNIQUE INDEX "gcal_conn_staff_unique"
  ON "GoogleCalendarConnection"("staffId") WHERE "scope" = 'STAFF_PERSONAL';
