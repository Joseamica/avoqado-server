-- Asistencia verificada (Mindform, 16-nov-2026): cómo se demostró cada llegada y la llave del QR firmado por el kiosco.
-- Todo aditivo y opcional: las apps viejas no leen estas columnas.

CREATE TYPE "ReservationCheckInMethod" AS ENUM ('QR', 'PHONE', 'STAFF', 'KIOSK_LIST', 'PASS');

ALTER TABLE "Reservation" ADD COLUMN "checkInMethod" "ReservationCheckInMethod";
ALTER TABLE "Reservation" ADD COLUMN "checkedInByStaffId" TEXT;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_checkedInByStaffId_fkey"
  FOREIGN KEY ("checkedInByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "KioskQrKey" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "deviceKey" VARCHAR(128) NOT NULL,
    "issuedByStaffId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KioskQrKey_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KioskQrKey_venueId_deviceKey_idx" ON "KioskQrKey"("venueId", "deviceKey");
ALTER TABLE "KioskQrKey" ADD CONSTRAINT "KioskQrKey_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Recibo idempotente de cada llegada de la cola sin red del kiosco (opId).
CREATE TABLE "KioskCheckInOp" (
    "opId" VARCHAR(64) NOT NULL,
    "venueId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KioskCheckInOp_pkey" PRIMARY KEY ("opId")
);
CREATE INDEX "KioskCheckInOp_venueId_createdAt_idx" ON "KioskCheckInOp"("venueId", "createdAt");
ALTER TABLE "KioskCheckInOp" ADD CONSTRAINT "KioskCheckInOp_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
