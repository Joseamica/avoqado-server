-- D1 (spec 2026-10-10): la elección por producto al conectar o reconectar. Sólo columnas NULAS: no reescribe la tabla.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ShopifyVariantLink"
  ADD COLUMN "connectChoice" "ShopifyReviewChoice",
  ADD COLUMN "connectChoiceGeneration" INTEGER,
  ADD COLUMN "connectChoiceTokenVersion" INTEGER,
  ADD COLUMN "connectSeenAvoqadoQty" DECIMAL(12,3),
  ADD COLUMN "connectSeenShopifyQty" INTEGER,
  ADD COLUMN "connectChoiceById" TEXT;
