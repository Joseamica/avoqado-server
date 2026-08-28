-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('PASSWORD', 'PIN', 'BIOMETRIC');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "deviceId" TEXT,
    "authMethod" "AuthMethod" NOT NULL,
    "parentSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshGrant" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "successorEnc" TEXT,
    "successorEncExpiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "rotatedToId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RefreshGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_staffId_revokedAt_idx" ON "Session"("staffId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_deviceId_revokedAt_idx" ON "Session"("deviceId", "revokedAt");

-- CreateIndex
CREATE INDEX "Session_venueId_revokedAt_idx" ON "Session"("venueId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshGrant_tokenHash_key" ON "RefreshGrant"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshGrant_familyId_revokedAt_idx" ON "RefreshGrant"("familyId", "revokedAt");

-- CreateIndex
CREATE INDEX "RefreshGrant_successorEncExpiresAt_idx" ON "RefreshGrant"("successorEncExpiresAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshGrant" ADD CONSTRAINT "RefreshGrant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
