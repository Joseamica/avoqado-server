-- Interruptor del aviso EN VIVO de retardo. APAGADO de fábrica a propósito: manda correos, y un
-- negocio no puede empezar a recibirlos por una actualización que no pidió.
--
-- A mano (no `migrate dev`) porque la base local es COMPARTIDA entre sesiones.
ALTER TABLE "VenueSettings" ADD COLUMN IF NOT EXISTS "attendanceLateAlertEnabled" BOOLEAN NOT NULL DEFAULT false;
