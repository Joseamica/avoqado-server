-- Offline-first Corte D: registro + dedup de intents del replay de los POS.
CREATE TABLE "PosSyncIntent" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "deviceId" VARCHAR(64) NOT NULL,
    "staffId" TEXT,
    "seq" INTEGER,
    "type" VARCHAR(40) NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "localRef" VARCHAR(64),
    "status" VARCHAR(12) NOT NULL,
    "errorCode" VARCHAR(40),
    "resultJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosSyncIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PosSyncIntent_venueId_idempotencyKey_key" ON "PosSyncIntent"("venueId", "idempotencyKey");
CREATE INDEX "PosSyncIntent_venueId_localRef_idx" ON "PosSyncIntent"("venueId", "localRef");
CREATE INDEX "PosSyncIntent_venueId_deviceId_createdAt_idx" ON "PosSyncIntent"("venueId", "deviceId", "createdAt");
