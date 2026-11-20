-- «Salida olvidada» (hz:f0a89d19:D3): interruptor por negocio, prendido de fábrica, y la marca en la checada que cerró la regla.
-- ADD COLUMN con DEFAULT constante: en Postgres 11+ no reescribe la tabla.
ALTER TABLE "VenueSettings" ADD COLUMN "salidaOlvidadaEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TimeEntry" ADD COLUMN "salidaOlvidada" BOOLEAN NOT NULL DEFAULT false;
