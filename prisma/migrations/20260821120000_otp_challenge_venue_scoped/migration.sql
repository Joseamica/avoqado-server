-- Fase 0.B (kiosco de reservas): el reto OTP queda atado al venue.
-- Nullable a propósito: las filas anteriores quedan NULL y `verify` las rechaza;
-- con TTL de 10 min mueren solas. No hay backfill posible (un reto legacy no sabe
-- de qué venue vino) ni rama de compatibilidad.
ALTER TABLE "OtpChallenge" ADD COLUMN "venueId" TEXT;

CREATE INDEX "OtpChallenge_venueId_destination_channel_idx"
  ON "OtpChallenge"("venueId", "destination", "channel");
