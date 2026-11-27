-- Hora de corte de la «salida olvidada» por sucursal («HH:mm»; null = la de fábrica, 04:00). Aditiva.
ALTER TABLE "VenueSettings" ADD COLUMN "salidaOlvidadaCorte" TEXT;
