-- Interruptor del control de asistencia. Default TRUE: los negocios existentes venían checando
-- sin interruptor y no se les apaga el reloj por una migración. Independiente de enableShifts.
ALTER TABLE "VenueSettings" ADD COLUMN "attendanceEnabled" BOOLEAN NOT NULL DEFAULT true;
