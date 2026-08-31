-- Turnos rotativos de trabajo (fase 1 del checador "como Sesame", 2026-08-27).
-- Interruptor explícito por venue, apagado de fábrica; plantillas; asignaciones persona×día con copia
-- de las horas y estado DRAFT/PUBLISHED. Escrita a mano y aplicada con `migrate deploy` (la base local
-- se comparte entre sesiones: nunca `migrate dev`/reset).
ALTER TABLE "VenueSettings" ADD COLUMN "rotatingShiftsEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "WorkShiftTemplate" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#7ADD2C',
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkShiftTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkShiftTemplate_venueId_idx" ON "WorkShiftTemplate"("venueId");

CREATE TABLE "WorkShiftAssignment" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffVenueId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "templateId" TEXT,
    "templateName" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkShiftAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkShiftAssignment_staffVenueId_date_key" ON "WorkShiftAssignment"("staffVenueId", "date");
CREATE INDEX "WorkShiftAssignment_venueId_date_idx" ON "WorkShiftAssignment"("venueId", "date");
ALTER TABLE "WorkShiftAssignment" ADD CONSTRAINT "WorkShiftAssignment_staffVenueId_fkey" FOREIGN KEY ("staffVenueId") REFERENCES "StaffVenue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkShiftAssignment" ADD CONSTRAINT "WorkShiftAssignment_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkShiftTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
