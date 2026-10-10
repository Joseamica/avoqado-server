-- M3: el tope de espera de candados cubre TODA la migración: el ALTER TYPE, los ALTER TABLE, las llaves foráneas y el CREATE
-- TRIGGER piden candado sobre tablas vivas ("Inventory", "Product", "Venue", "Organization"…). Si tardan, la migración falla
-- en vez de formar fila delante de las ventas.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ShopifyAppKey" AS ENUM ('PILOTO', 'PUBLICA');

-- CreateEnum
CREATE TYPE "ShopifyStoreStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "ShopifyLinkStatus" AS ENUM ('CONNECTING', 'REVIEWING', 'ACTIVE', 'PAUSED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ShopifyOutboxStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SENT', 'FAILED', 'DEAD_LETTER', 'DISCARDED');

-- CreateEnum
CREATE TYPE "ShopifyEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEFERRED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ShopifyIntentPurpose" AS ENUM ('CONNECT', 'REAUTHORIZE');

-- CreateEnum
CREATE TYPE "ShopifyIntentStatus" AS ENUM ('CREATED', 'EXCHANGING', 'EXCHANGED', 'CONSUMED', 'FAILED');

-- CreateEnum
CREATE TYPE "ShopifyReviewStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ShopifyReviewChoice" AS ENUM ('AVOQADO', 'SHOPIFY');

-- CreateEnum
CREATE TYPE "ShopifyReviewReason" AS ENUM ('DIFERENCIA', 'ATORADO', 'INCIERTO', 'REACTIVADA');

-- CreateEnum
CREATE TYPE "ShopifySuspendReason" AS ENUM ('SIN_INVENTARIO', 'NIVEL_INEXISTENTE', 'NO_RASTREADO');

-- CreateEnum
CREATE TYPE "ShopifyIssueReason" AS ENUM ('SIN_SKU', 'SKU_REPETIDO', 'SKU_CHOCA', 'CODIGO_REPETIDO', 'IDENTIDAD_EN_CONFLICTO', 'PRODUCTO_ARCHIVADO', 'METODO_RECETA', 'TIPO_SIN_INVENTARIO', 'SIN_INVENTARIO_EN_AVOQADO', 'UNIDAD_NO_PIEZA', 'SIN_PRECIO', 'NIVEL_INEXISTENTE', 'NO_RASTREADO', 'SIN_INVENTARIO', 'ERROR_IMPORTACION');

-- AlterEnum
ALTER TYPE "OriginSystem" ADD VALUE 'SHOPIFY';

-- AlterTable
ALTER TABLE "StockCountItem" ADD COLUMN     "shopifyHeldAt" TIMESTAMP(3),
ADD COLUMN     "shopifyHeldReason" TEXT;

-- CreateTable
CREATE TABLE "ShopifyStore" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "appKey" "ShopifyAppKey" NOT NULL,
    "accessTokenCiphertext" BYTEA NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "scopes" TEXT NOT NULL,
    "status" "ShopifyStoreStatus" NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMP(3),
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyLocationLink" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "shopifyLocationId" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "status" "ShopifyLinkStatus" NOT NULL DEFAULT 'CONNECTING',
    "pausedFrom" "ShopifyLinkStatus",
    "generation" INTEGER NOT NULL DEFAULT 1,
    "importCursor" TEXT,
    "importAttempts" INTEGER NOT NULL DEFAULT 0,
    "importError" TEXT,
    "importedAt" TIMESTAMP(3),
    "applyRequestedAt" TIMESTAMP(3),
    "applyRequestedById" TEXT,
    "webhooksAt" TIMESTAMP(3),
    "needsReconcile" BOOLEAN NOT NULL DEFAULT false,
    "reconcileCursor" TEXT,
    "lastReconciledAt" TIMESTAMP(3),
    "reconcileVersion" INTEGER NOT NULL DEFAULT 0,
    "reconcileDoneVersion" INTEGER NOT NULL DEFAULT 0,
    "catalogSweepId" INTEGER NOT NULL DEFAULT 0,
    "catalogSweepCursor" TEXT,
    "requeuePending" BOOLEAN NOT NULL DEFAULT false,
    "workToken" TEXT,
    "workLeaseUntil" TIMESTAMP(3),
    "lastWorkedAt" TIMESTAMP(3),
    "nextWorkAt" TIMESTAMP(3),
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyLocationLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyVariantLink" (
    "id" TEXT NOT NULL,
    "locationLinkId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "originalSku" TEXT,
    "importedAvailable" INTEGER,
    "importedAt" TIMESTAMP(3),
    "initializedAt" TIMESTAMP(3),
    "createdProduct" BOOLEAN NOT NULL DEFAULT false,
    "suspendedReason" "ShopifySuspendReason",
    "suspendedAt" TIMESTAMP(3),
    "mirrorAvailable" INTEGER NOT NULL DEFAULT 0,
    "mirrorCommitted" INTEGER NOT NULL DEFAULT 0,
    "mirrorAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),
    "lastSeenSweepId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyVariantLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyStockOutbox" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "locationLinkId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "delta" DECIMAL(12,3) NOT NULL,
    "status" "ShopifyOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "sentInventoryItemId" TEXT,
    "sentLocationId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstAttemptAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ShopifyStockOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyInboundEvent" (
    "id" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "appKey" "ShopifyAppKey" NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ShopifyEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "triggeredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ShopifyInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyConnectIntent" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "authUserId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "appKey" "ShopifyAppKey" NOT NULL,
    "purpose" "ShopifyIntentPurpose" NOT NULL DEFAULT 'CONNECT',
    "status" "ShopifyIntentStatus" NOT NULL DEFAULT 'CREATED',
    "tokenCiphertext" BYTEA,
    "scopes" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyConnectIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyReviewItem" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "reason" "ShopifyReviewReason" NOT NULL,
    "avoqadoQty" DECIMAL(12,3) NOT NULL,
    "shopifyQty" INTEGER NOT NULL,
    "atorados" INTEGER NOT NULL DEFAULT 0,
    "offset" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "suggestion" "ShopifyReviewChoice" NOT NULL,
    "status" "ShopifyReviewStatus" NOT NULL DEFAULT 'OPEN',
    "choice" "ShopifyReviewChoice",
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionOutboxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyImportIssue" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "reason" "ShopifyIssueReason" NOT NULL,
    "detail" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyImportIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyStore_shopDomain_key" ON "ShopifyStore"("shopDomain");

-- CreateIndex
CREATE INDEX "ShopifyStore_organizationId_idx" ON "ShopifyStore"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyLocationLink_venueId_key" ON "ShopifyLocationLink"("venueId");

-- CreateIndex
CREATE INDEX "ShopifyLocationLink_status_idx" ON "ShopifyLocationLink"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyLocationLink_storeId_shopifyLocationId_key" ON "ShopifyLocationLink"("storeId", "shopifyLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyVariantLink_productId_key" ON "ShopifyVariantLink"("productId");

-- CreateIndex
CREATE INDEX "ShopifyVariantLink_locationLinkId_shopifyProductId_idx" ON "ShopifyVariantLink"("locationLinkId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "ShopifyVariantLink_locationLinkId_initializedAt_idx" ON "ShopifyVariantLink"("locationLinkId", "initializedAt");

-- CreateIndex
CREATE INDEX "ShopifyVariantLink_venueId_idx" ON "ShopifyVariantLink"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyVariantLink_locationLinkId_inventoryItemId_key" ON "ShopifyVariantLink"("locationLinkId", "inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyVariantLink_locationLinkId_shopifyVariantId_key" ON "ShopifyVariantLink"("locationLinkId", "shopifyVariantId");

-- CreateIndex
CREATE INDEX "ShopifyStockOutbox_status_scheduledAt_idx" ON "ShopifyStockOutbox"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "ShopifyStockOutbox_productId_status_idx" ON "ShopifyStockOutbox"("productId", "status");

-- CreateIndex
CREATE INDEX "ShopifyStockOutbox_venueId_status_idx" ON "ShopifyStockOutbox"("venueId", "status");

-- CreateIndex
CREATE INDEX "ShopifyStockOutbox_locationLinkId_generation_status_idx" ON "ShopifyStockOutbox"("locationLinkId", "generation", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyInboundEvent_dedupKey_key" ON "ShopifyInboundEvent"("dedupKey");

-- CreateIndex
CREATE INDEX "ShopifyInboundEvent_status_nextAttemptAt_idx" ON "ShopifyInboundEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ShopifyInboundEvent_shopDomain_status_idx" ON "ShopifyInboundEvent"("shopDomain", "status");

-- CreateIndex
CREATE INDEX "ShopifyConnectIntent_venueId_createdAt_idx" ON "ShopifyConnectIntent"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyConnectIntent_expiresAt_idx" ON "ShopifyConnectIntent"("expiresAt");

-- CreateIndex
CREATE INDEX "ShopifyReviewItem_venueId_status_createdAt_idx" ON "ShopifyReviewItem"("venueId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyReviewItem_productId_status_idx" ON "ShopifyReviewItem"("productId", "status");

-- CreateIndex
CREATE INDEX "ShopifyImportIssue_venueId_createdAt_idx" ON "ShopifyImportIssue"("venueId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyImportIssue_venueId_shopifyVariantId_key" ON "ShopifyImportIssue"("venueId", "shopifyVariantId");

-- AddForeignKey
ALTER TABLE "ShopifyStore" ADD CONSTRAINT "ShopifyStore_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyLocationLink" ADD CONSTRAINT "ShopifyLocationLink_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "ShopifyStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyLocationLink" ADD CONSTRAINT "ShopifyLocationLink_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyVariantLink" ADD CONSTRAINT "ShopifyVariantLink_locationLinkId_fkey" FOREIGN KEY ("locationLinkId") REFERENCES "ShopifyLocationLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyVariantLink" ADD CONSTRAINT "ShopifyVariantLink_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyReviewItem" ADD CONSTRAINT "ShopifyReviewItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══ Guardia de stock para Shopify (spec §4 ③, ajustes 12 bis.2 y 12 bis.6) ════════════════════════════════════
-- Cada cambio de "Inventory"."currentStock" de una sucursal ligada a Shopify deja su delta en "ShopifyStockOutbox", en la
-- MISMA transacción. Ve todos los caminos que escriben stock (Prisma y SQL crudo) y los que se agreguen.
-- 🔴 Es la primera vez que este repo le pasa contexto a un trigger: quien aplica un cambio que VINO de Shopify hace
--    SELECT set_config('avoqado.stock_origen', 'shopify', true) en su transacción, y aquí no se encola (sin eco).
-- 🔴 Si este INSERT fallara, fallaría la venta que lo disparó: por eso no hace nada más que leer dos índices e insertar.
-- Una sucursal sin Shopify paga una búsqueda por el índice único de "venueId".
-- Reversión (no se ejecuta aquí):
--   DROP TRIGGER IF EXISTS "Inventory_guardia_shopify" ON "Inventory";
--   DROP FUNCTION IF EXISTS "shopifyGuardiaInventario"();
-- (El tope de espera de candados del CREATE TRIGGER es el `SET LOCAL lock_timeout` del principio del archivo.)

-- Fase efectiva: si la sucursal está PAUSED, manda la fase de antes (pausedFrom).
--  · CONNECTING / REVIEWING ⇒ se encola CUALQUIER producto de la sucursal (aún sin pareja): ajuste 12 bis.2.
--  · ACTIVE ⇒ sólo productos con pareja iniciada y no suspendida.
--  · DISCONNECTED o sin enlace ⇒ nada.
-- No encola: marca de origen 'shopify'; delta 0; DELETE de la fila (lo maneja switchInventoryMethod, ajuste 12 bis.5).
CREATE OR REPLACE FUNCTION "shopifyGuardiaInventario"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_delta  numeric(12,3);
  v_link   text;
  v_fase   text;
  v_gen    int;
  v_ok     boolean;
BEGIN
  IF current_setting('avoqado.stock_origen', true) = 'shopify' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_delta := NEW."currentStock";
  ELSE
    v_delta := NEW."currentStock" - OLD."currentStock";
  END IF;
  IF v_delta = 0 THEN
    RETURN NEW;
  END IF;

  SELECT l.id,
         CASE WHEN l.status = 'PAUSED' THEN COALESCE(l."pausedFrom"::text, 'ACTIVE') ELSE l.status::text END,
         l.generation
    INTO v_link, v_fase, v_gen
    FROM "ShopifyLocationLink" l
   WHERE l."venueId" = NEW."venueId";
  IF v_link IS NULL OR v_fase = 'DISCONNECTED' THEN
    RETURN NEW;
  END IF;

  IF v_fase = 'ACTIVE' THEN
    SELECT TRUE INTO v_ok
      FROM "ShopifyVariantLink" v
     WHERE v."productId" = NEW."productId" AND v."locationLinkId" = v_link
       AND v."initializedAt" IS NOT NULL AND v."suspendedReason" IS NULL;
    IF v_ok IS NOT TRUE THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO "ShopifyStockOutbox"
    (id, "venueId", "locationLinkId", generation, "productId", delta, status, ambiguous, attempts, "scheduledAt", "createdAt")
  VALUES ('c' || substr(md5(gen_random_uuid()::text), 1, 24), NEW."venueId", v_link, v_gen, NEW."productId", v_delta,
          'PENDING', false, 0, (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC'));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Inventory_guardia_shopify" ON "Inventory";
CREATE TRIGGER "Inventory_guardia_shopify"
AFTER INSERT OR UPDATE OF "currentStock" ON "Inventory"
FOR EACH ROW EXECUTE FUNCTION "shopifyGuardiaInventario"();
