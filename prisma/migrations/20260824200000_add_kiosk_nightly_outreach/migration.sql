-- Fase 9 del kiosco — aviso nocturno de renovación.

-- Interruptor por negocio. APAGADO por defecto: esto manda mensajes a los clientes con el
-- nombre del negocio, y un WhatsApp no se puede desenviar.
ALTER TABLE "ReservationSettings" ADD COLUMN "nightlyOutreachEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "KioskOutreachEvent" AS ENUM ('CREDITS_RUNNING_OUT', 'PACK_EXPIRING');
CREATE TYPE "KioskOutreachStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "KioskOutreachOutbox" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "event" "KioskOutreachEvent" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "paymentLinkUrl" TEXT,
    "payload" JSONB,
    "status" "KioskOutreachStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KioskOutreachOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KioskOutreachOutbox_dedupeKey_key" ON "KioskOutreachOutbox"("dedupeKey");
CREATE INDEX "KioskOutreachOutbox_status_leasedUntil_idx" ON "KioskOutreachOutbox"("status", "leasedUntil");
CREATE INDEX "KioskOutreachOutbox_venueId_customerId_idx" ON "KioskOutreachOutbox"("venueId", "customerId");

ALTER TABLE "KioskOutreachOutbox"
  ADD CONSTRAINT "KioskOutreachOutbox_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KioskOutreachOutbox"
  ADD CONSTRAINT "KioskOutreachOutbox_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
