-- Cuadrante laboral: a qué hora ENTRA A TRABAJAR cada persona, para poder decir
-- "llegó tarde" en vez de sólo "llegó a las 9:14".
--
-- 🔴 No confundir con `StaffSchedule` (disponibilidad para CITAS) ni con `Shift` (corte de
-- CAJA). Son tres cosas distintas; mezclarlas en una tabla es el error que estos nombres
-- existen para evitar.

CREATE TABLE "StaffWorkSchedule" (
    "id" TEXT NOT NULL,
    "staffVenueId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "weekly" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffWorkSchedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffWorkSchedule_staffVenueId_key" ON "StaffWorkSchedule"("staffVenueId");
CREATE INDEX "StaffWorkSchedule_venueId_idx" ON "StaffWorkSchedule"("venueId");

CREATE TABLE "StaffWorkScheduleException" (
    "id" TEXT NOT NULL,
    "staffVenueId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffWorkScheduleException_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StaffWorkScheduleException_staffVenueId_startDate_endDate_idx" ON "StaffWorkScheduleException"("staffVenueId", "startDate", "endDate");
CREATE INDEX "StaffWorkScheduleException_venueId_startDate_idx" ON "StaffWorkScheduleException"("venueId", "startDate");

ALTER TABLE "StaffWorkSchedule" ADD CONSTRAINT "StaffWorkSchedule_staffVenueId_fkey" FOREIGN KEY ("staffVenueId") REFERENCES "StaffVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffWorkScheduleException" ADD CONSTRAINT "StaffWorkScheduleException_staffVenueId_fkey" FOREIGN KEY ("staffVenueId") REFERENCES "StaffVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tolerancia de retardo, por negocio. 10 min: castigar el minuto exacto vuelve ruido el
-- semáforo y nadie lo mira otra vez.
ALTER TABLE "VenueSettings" ADD COLUMN "attendanceGraceMinutes" INTEGER NOT NULL DEFAULT 10;
