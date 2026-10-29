-- D4 «Sí llegó»: la corrección de un «No asistió» (una por reserva) y los dos avisos nuevos. Aditiva.
-- Postgres >= 12 admite ADD VALUE dentro de la transacción de la migración; los valores no se usan aquí.

ALTER TYPE "NotificationType" ADD VALUE 'RESERVATION_NO_SHOW_SUMMARY';
ALTER TYPE "NotificationType" ADD VALUE 'RESERVATION_NEEDS_REVIEW';

-- CreateTable
CREATE TABLE "ReservationNoShowCorrection" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actorStaffId" TEXT,
    "plan" JSONB NOT NULL,
    "pending" TEXT[],
    "noticeSentAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedByStaffId" TEXT,
    "resolvedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationNoShowCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReservationNoShowCorrection_reservationId_key" ON "ReservationNoShowCorrection"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationNoShowCorrection_venueId_noticeSentAt_idx" ON "ReservationNoShowCorrection"("venueId", "noticeSentAt");

-- CreateIndex
CREATE INDEX "ReservationNoShowCorrection_venueId_resolvedAt_idx" ON "ReservationNoShowCorrection"("venueId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "ReservationNoShowCorrection" ADD CONSTRAINT "ReservationNoShowCorrection_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

