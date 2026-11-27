-- Hora de corte de la «salida olvidada» por sucursal («HH:mm»; null = la de fábrica, 04:00). Aditiva.
ALTER TABLE "VenueSettings" ADD COLUMN "salidaOlvidadaCorte" TEXT;
-- El límite con el que la regla cerró una «salida olvidada»: queda fijo aunque la sucursal cambie su hora de corte.
ALTER TABLE "TimeEntry" ADD COLUMN "limiteOlvidada" TIMESTAMP(3);
