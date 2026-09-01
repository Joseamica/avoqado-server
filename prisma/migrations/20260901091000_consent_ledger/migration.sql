-- CreateEnum
CREATE TYPE "ConsentAction" AS ENUM ('GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentChannel" AS ENUM ('FORM_STAFF', 'SELF_SERVE', 'ONE_CLICK_UNSUBSCRIBE');

-- CreateTable PrivacyNoticeVersion
CREATE TABLE "PrivacyNoticeVersion" (
  "id" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "language" TEXT NOT NULL DEFAULT 'es',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrivacyNoticeVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivacyNoticeVersion_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PrivacyNoticeVersion_venueId_createdAt_idx" ON "PrivacyNoticeVersion"("venueId", "createdAt");

-- CreateTable ConsentEvent
CREATE TABLE "ConsentEvent" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "action" "ConsentAction" NOT NULL,
  "channel" "ConsentChannel" NOT NULL,
  "actorStaffId" TEXT,
  "noticeVersionId" TEXT,
  "ip" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConsentEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConsentEvent_noticeVersionId_fkey" FOREIGN KEY ("noticeVersionId") REFERENCES "PrivacyNoticeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConsentEvent_customerId_seq_key" ON "ConsentEvent"("customerId", "seq");
CREATE INDEX "ConsentEvent_venueId_createdAt_idx" ON "ConsentEvent"("venueId", "createdAt");

-- CreateTable CustomerCaptureToken
CREATE TABLE "CustomerCaptureToken" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerCaptureToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerCaptureToken_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustomerCaptureToken_tokenHash_key" ON "CustomerCaptureToken"("tokenHash");
CREATE INDEX "CustomerCaptureToken_customerId_idx" ON "CustomerCaptureToken"("customerId");
