-- «Salida olvidada» (hz:f0a89d19:D3): interruptor por negocio, prendido de fábrica, y la marca en la checada que cerró la regla.
-- ADD COLUMN con DEFAULT constante: en Postgres 11+ es sólo catálogo, no reescribe la tabla ni mueve filas.
-- `lock_timeout`: el ALTER pide su candado exclusivo un instante; si una transacción larga lo tiene, la migración falla a los
-- 5 s en vez de formar en fila detrás de ella a las checadas de las terminales y los POS (mismo patrón que 20261108200000).
--
-- Reversión (no se ejecuta):
--   ALTER TABLE "time_entries" DROP COLUMN "salidaOlvidada";
--   ALTER TABLE "VenueSettings" DROP COLUMN "salidaOlvidadaEnabled";
SET LOCAL lock_timeout = '5s';
ALTER TABLE "VenueSettings" ADD COLUMN "salidaOlvidadaEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "time_entries" ADD COLUMN "salidaOlvidada" BOOLEAN NOT NULL DEFAULT false;
