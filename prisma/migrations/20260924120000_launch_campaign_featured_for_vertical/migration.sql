-- La VITRINA del giro (relevo 2026-09-24): qué campaña enseña la página de un giro que no lleva
-- el slug en su URL (hoy /restaurants ⇒ FOOD_SERVICE). Sustituye a la variable de entorno
-- RESTAURANTS_OFFER_SLUG de la landing: cambiar la oferta de esa página deja de exigir un commit.
--
-- ADITIVA e idempotente. La tabla tiene decenas de filas: el índice no necesita CONCURRENTLY, y
-- ADD COLUMN con un DEFAULT constante es sólo metadatos desde Postgres 11.

ALTER TABLE "LaunchCampaign" ADD COLUMN IF NOT EXISTS "featuredForVertical" BOOLEAN NOT NULL DEFAULT false;

-- 🔴 EL CANDADO de la exclusividad. El servicio desmarca a la anterior bajo un advisory lock por
-- giro dentro de UNA transacción, pero esto es lo que la hace IMPOSIBLE de romper — por una
-- carrera, por SQL a mano o por un camino nuevo que se olvide del candado. Prisma no expresa
-- índices parciales y NO los reporta en un `migrate diff`: sólo la prueba de integración lo vigila.
CREATE UNIQUE INDEX IF NOT EXISTS "LaunchCampaign_featured_vertical_unique"
  ON "LaunchCampaign" ("vertical") WHERE "featuredForVertical" = true;

-- Una ficha TERMINADA es historia: no puede quedarse con la vitrina de su giro.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LaunchCampaign_featured_not_ended') THEN
    ALTER TABLE "LaunchCampaign"
      ADD CONSTRAINT "LaunchCampaign_featured_not_ended"
      CHECK (NOT ("featuredForVertical" AND "status" = 'ENDED'));
  END IF;
END $$;
