-- Fase 5 del kiosco — reto de check-in + límite de intentos DURABLE.

CREATE TYPE "KioskCheckInChallengeStatus" AS ENUM ('PENDING', 'CONSUMED', 'EXPIRED', 'CANCELLED');

CREATE TABLE "KioskCheckInChallenge" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "terminalId" TEXT,
    "stationKey" VARCHAR(8) NOT NULL,
    "kioskSessionId" VARCHAR(64) NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "status" "KioskCheckInChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "customerId" TEXT,
    "reservationId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KioskCheckInChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KioskCheckInChallenge_nonceHash_key" ON "KioskCheckInChallenge"("nonceHash");
CREATE INDEX "KioskCheckInChallenge_venueId_status_expiresAt_idx" ON "KioskCheckInChallenge"("venueId", "status", "expiresAt");
CREATE INDEX "KioskCheckInChallenge_terminalId_stationKey_status_idx" ON "KioskCheckInChallenge"("terminalId", "stationKey", "status");

-- 🔴 Un solo reto VIVO por cara del aparato. Es el invariante del spec ("máx. un challenge
-- activo por terminal/estación") y se cumple en la BASE, no en el servicio: dos peticiones
-- simultáneas del kiosco no pueden dejar dos QR válidos en pantalla.
CREATE UNIQUE INDEX "KioskCheckInChallenge_active_station_key"
  ON "KioskCheckInChallenge"("terminalId", "stationKey")
  WHERE "status" = 'PENDING';

ALTER TABLE "KioskCheckInChallenge"
  ADD CONSTRAINT "KioskCheckInChallenge_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "KioskCheckInAttempt" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "scope" VARCHAR(128) NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KioskCheckInAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KioskCheckInAttempt_venueId_scope_windowStart_key" ON "KioskCheckInAttempt"("venueId", "scope", "windowStart");
CREATE INDEX "KioskCheckInAttempt_windowStart_idx" ON "KioskCheckInAttempt"("windowStart");

ALTER TABLE "KioskCheckInAttempt"
  ADD CONSTRAINT "KioskCheckInAttempt_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
