-- 5a (spec 2026-10-11, «la app es del comercio»): las llaves de la app del comercio, en la tienda y en el intent. Sólo AGREGA un
-- valor de enum y columnas NULAS (no reescribe las tablas). `ADD VALUE` corre dentro de la transacción de la migración
-- (Postgres >= 12) porque nada aquí usa el valor nuevo.
SET LOCAL lock_timeout = '5s';

ALTER TYPE "ShopifyAppKey" ADD VALUE 'COMERCIO';

ALTER TABLE "ShopifyStore"
  ADD COLUMN "clientId" TEXT,
  ADD COLUMN "clientSecretCiphertext" BYTEA,
  ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3);

ALTER TABLE "ShopifyConnectIntent"
  ADD COLUMN "clientId" TEXT,
  ADD COLUMN "clientSecretCiphertext" BYTEA,
  ADD COLUMN "tokenExpiresAt" TIMESTAMP(3);
