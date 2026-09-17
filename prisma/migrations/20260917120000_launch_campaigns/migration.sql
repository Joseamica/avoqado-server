-- Lanzamiento con campañas ligeras + onboarding corto (spec 2026-09-17, tarea S1).
--
-- TODO ADITIVO E IDEMPOTENTE: dos tablas nuevas, dos enums nuevos y nueve columnas nuevas en
-- `OnboardingProgress`. Ninguna fila existente cambia de significado y NO hay migración de DATOS:
-- un alta en curso queda con `launchCampaignId` NULL y `planActivationStatus` NONE, que es
-- exactamente lo que ya era antes (sin campaña, sin cobro de plan). Desplegar esto no cambia el
-- comportamiento de nadie hasta que el superadmin cree y ACTIVE su primera ficha.
--
-- 🔴 UNIDADES: los importes de estas tablas van en CENTAVOS enteros CON IVA — excepción
-- documentada a la regla «la plataforma trabaja en PESOS 1:1». Cada número ES un campo de Stripe
-- (`price.unit_amount`, `coupon.amount_off`), que por contrato del proveedor son centavos.
--
-- 🔴 Y el candado que Prisma NO sabe expresar, al final de este archivo:
--    `LaunchCampaignRedemption_org_live_unique` — índice único PARCIAL sobre `organizationId`
--    `WHERE status <> 'RELEASED'`. Un `prisma migrate diff` futuro lo reportará como deriva:
--    es DELIBERADO y no se borra. Sin él, dos intentos simultáneos de la misma organización
--    cuentan DOS veces contra el cupo.

-- ============================================================================
-- 1. Enums
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "OnboardingPlanActivationStatus" AS ENUM ('NONE', 'IN_PROGRESS', 'ACTIVE', 'DECLINED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "LaunchCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "LaunchCampaignVertical" AS ENUM ('ALL', 'FOOD_SERVICE', 'RETAIL', 'SERVICES', 'HOSPITALITY', 'ENTERTAINMENT');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "LaunchCampaignChannel" AS ENUM ('GOOGLE_ADS', 'META', 'OPENAI_ADS', 'MULTI', 'OTHER');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "LaunchCampaignInterval" AS ENUM ('MONTHLY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "LaunchCampaignRedemptionStatus" AS ENUM ('RESERVED', 'APPLIED', 'RELEASED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- 2. La ficha de campaña
--    Los CHECK nacen VALIDADOS (sin `NOT VALID`): la tabla es nueva y no tiene historia que
--    pudiera tumbar el deploy.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "LaunchCampaign" (
    "id"                     TEXT NOT NULL,
    "code"                   TEXT NOT NULL,
    "name"                   TEXT NOT NULL,
    "landingSlug"            TEXT NOT NULL,
    "vertical"               "LaunchCampaignVertical" NOT NULL DEFAULT 'ALL',
    "channel"                "LaunchCampaignChannel",
    "planTier"               "PlanTier" NOT NULL,
    "billingInterval"        "LaunchCampaignInterval" NOT NULL DEFAULT 'MONTHLY',
    "advertisedPriceCents"   INTEGER NOT NULL,
    "discountMonths"         INTEGER NOT NULL,
    "currency"               TEXT NOT NULL DEFAULT 'MXN',
    "offerVersion"           INTEGER NOT NULL DEFAULT 1,
    "listPriceCentsSnapshot" INTEGER,
    "discountAmountCents"    INTEGER,
    "stripePriceId"          TEXT,
    "stripeCouponId"         TEXT,
    "validFrom"              TIMESTAMP(3) NOT NULL,
    "validUntil"             TIMESTAMP(3) NOT NULL,
    "redemptionCap"          INTEGER NOT NULL,
    "redemptionCount"        INTEGER NOT NULL DEFAULT 0,
    "headline"               TEXT,
    "subheadline"            TEXT,
    "bullets"                TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status"                 "LaunchCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "statusReason"           TEXT,
    "activatedAt"            TIMESTAMP(3),
    "createdById"            TEXT,
    "updatedById"            TEXT,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaunchCampaign_pkey" PRIMARY KEY ("id"),

    -- Una campaña de lanzamiento vende un plan de PAGA. GRATIS no tiene qué cobrar y ENTERPRISE
    -- se negocia a mano.
    CONSTRAINT "LaunchCampaign_plan_tier_paid" CHECK ("planTier" IN ('PRO', 'PREMIUM')),
    -- Stripe no cobra menos de $10.00 MXN: un precio por debajo produce una ficha que ACTIVA bien
    -- y falla al cobrarle al primer cliente.
    CONSTRAINT "LaunchCampaign_price_min" CHECK ("advertisedPriceCents" >= 1000),
    CONSTRAINT "LaunchCampaign_months_range" CHECK ("discountMonths" BETWEEN 1 AND 24),
    CONSTRAINT "LaunchCampaign_currency_mxn" CHECK ("currency" = 'MXN'),
    CONSTRAINT "LaunchCampaign_window" CHECK ("validFrom" < "validUntil"),
    CONSTRAINT "LaunchCampaign_cap_positive" CHECK ("redemptionCap" > 0),
    -- 🔴 El RESPALDO del cupo, no su candado. El candado es el UPDATE condicional
    -- (`WHERE redemptionCount < redemptionCap`); este CHECK existe para que una sobreventa sea
    -- imposible incluso si alguien algún día escribe el conteo con un leer-y-escribir.
    CONSTRAINT "LaunchCampaign_count_in_cap" CHECK ("redemptionCount" >= 0 AND "redemptionCount" <= "redemptionCap"),
    -- Los tres importes congelados al activar no pueden contradecirse entre sí.
    CONSTRAINT "LaunchCampaign_discount_consistent" CHECK (
      "discountAmountCents" IS NULL OR (
        "discountAmountCents" > 0
        AND "listPriceCentsSnapshot" IS NOT NULL
        AND "listPriceCentsSnapshot" - "discountAmountCents" = "advertisedPriceCents"
      )
    ),
    -- Una ficha ACTIVE sin cupón anunciaría un precio que Stripe no va a descontar.
    CONSTRAINT "LaunchCampaign_active_has_coupon" CHECK (
      "status" <> 'ACTIVE' OR ("stripeCouponId" IS NOT NULL AND "discountAmountCents" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "LaunchCampaign_code_key" ON "LaunchCampaign"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "LaunchCampaign_landingSlug_key" ON "LaunchCampaign"("landingSlug");
CREATE UNIQUE INDEX IF NOT EXISTS "LaunchCampaign_stripeCouponId_key" ON "LaunchCampaign"("stripeCouponId");
CREATE INDEX IF NOT EXISTS "LaunchCampaign_status_validFrom_validUntil_idx"
  ON "LaunchCampaign"("status", "validFrom", "validUntil");

-- ============================================================================
-- 3. El lugar del cupo (una fila por INTENTO)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "LaunchCampaignRedemption" (
    "id"                   TEXT NOT NULL,
    "campaignId"           TEXT NOT NULL,
    "organizationId"       TEXT NOT NULL,
    "venueId"              TEXT,
    "staffId"              TEXT,
    "status"               "LaunchCampaignRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "offerVersion"         INTEGER NOT NULL,
    "planTier"             "PlanTier" NOT NULL,
    "advertisedPriceCents" INTEGER NOT NULL,
    "discountAmountCents"  INTEGER NOT NULL,
    "discountMonths"       INTEGER NOT NULL,
    "listPriceCents"       INTEGER NOT NULL,
    "stripeCouponId"       TEXT NOT NULL,
    "stripeSubscriptionId" TEXT,
    "cardFingerprint"      TEXT,
    "reservedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt"            TIMESTAMP(3),
    "releasedAt"           TIMESTAMP(3),
    "lastError"            TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaunchCampaignRedemption_pkey" PRIMARY KEY ("id"),

    -- El snapshot es lo que el cliente consintió, y el correo de confirmación se arma DESDE ÉL:
    -- si los tres importes no cuadran, se cobraría un precio y se anunciaría otro.
    CONSTRAINT "LaunchCampaignRedemption_amounts" CHECK (
      "listPriceCents" - "discountAmountCents" = "advertisedPriceCents" AND "advertisedPriceCents" > 0
    ),
    -- APPLIED significa «Stripe ya cobró»: sin suscripción no hay nada que lo pruebe.
    CONSTRAINT "LaunchCampaignRedemption_applied" CHECK (
      "status" <> 'APPLIED' OR ("stripeSubscriptionId" IS NOT NULL AND "appliedAt" IS NOT NULL)
    ),
    CONSTRAINT "LaunchCampaignRedemption_released" CHECK (
      "status" <> 'RELEASED' OR "releasedAt" IS NOT NULL
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "LaunchCampaignRedemption_stripeSubscriptionId_key"
  ON "LaunchCampaignRedemption"("stripeSubscriptionId");
CREATE INDEX IF NOT EXISTS "LaunchCampaignRedemption_campaignId_status_reservedAt_idx"
  ON "LaunchCampaignRedemption"("campaignId", "status", "reservedAt");
CREATE INDEX IF NOT EXISTS "LaunchCampaignRedemption_organizationId_status_idx"
  ON "LaunchCampaignRedemption"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "LaunchCampaignRedemption_cardFingerprint_idx"
  ON "LaunchCampaignRedemption"("cardFingerprint");

-- 🔴 EL CANDADO. Prisma no expresa índices únicos parciales, así que vive SOLO aquí — mismo
-- patrón que `20260519002719_add_venue_chat_session_shortcode_index`.
-- A lo más UN lugar vivo (RESERVED o APPLIED) por organización; las RELEASED se conservan como
-- HISTORIA (qué campaña trajo a este cliente y por qué su tarjeta fue rechazada), y por eso el
-- índice es parcial y no un `@unique` a secas: un `@unique` obligaría a MUTAR la fila anterior en
-- el segundo intento y borraría esa evidencia.
-- NO LO BORRES si un `migrate diff` lo reporta como deriva: es deliberado.
CREATE UNIQUE INDEX IF NOT EXISTS "LaunchCampaignRedemption_org_live_unique"
  ON "LaunchCampaignRedemption"("organizationId")
  WHERE "status" <> 'RELEASED';

-- ============================================================================
-- 4. Reclamo y cobro del plan en el alta (columnas aditivas)
-- ============================================================================

ALTER TABLE "OnboardingProgress" ADD COLUMN IF NOT EXISTS "launchCampaignId" TEXT;
ALTER TABLE "OnboardingProgress" ADD COLUMN IF NOT EXISTS "launchCampaignClaimedAt" TIMESTAMP(3);
ALTER TABLE "OnboardingProgress" ADD COLUMN IF NOT EXISTS "acquisitionSource" TEXT;
ALTER TABLE "OnboardingProgress" ADD COLUMN IF NOT EXISTS "acquisitionUtm" JSONB;
ALTER TABLE "OnboardingProgress" ADD COLUMN IF NOT EXISTS "planActivationStatus" "OnboardingPlanActivationStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "OnboardingProgress" ADD COLUMN IF NOT EXISTS "planActivationAttempt" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OnboardingProgress" ADD COLUMN IF NOT EXISTS "planActivationLeaseUntil" TIMESTAMP(3);
ALTER TABLE "OnboardingProgress" ADD COLUMN IF NOT EXISTS "planActivatedAt" TIMESTAMP(3);
ALTER TABLE "OnboardingProgress" ADD COLUMN IF NOT EXISTS "planStripeSubscriptionId" TEXT;

CREATE INDEX IF NOT EXISTS "OnboardingProgress_launchCampaignId_idx"
  ON "OnboardingProgress"("launchCampaignId");

-- ============================================================================
-- 5. Llaves foráneas
--    RESTRICT en campaña y organización: una ficha con redenciones NO se borra, y una redención
--    es evidencia de un cobro — borrarla en cascada perdería el rastro del dinero.
--    SET NULL en venue y en el reclamo del alta: el local puede desaparecer sin que la historia
--    del cobro deje de existir.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OnboardingProgress_launchCampaignId_fkey') THEN
    ALTER TABLE "OnboardingProgress"
      ADD CONSTRAINT "OnboardingProgress_launchCampaignId_fkey"
      FOREIGN KEY ("launchCampaignId") REFERENCES "LaunchCampaign"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LaunchCampaignRedemption_campaignId_fkey') THEN
    ALTER TABLE "LaunchCampaignRedemption"
      ADD CONSTRAINT "LaunchCampaignRedemption_campaignId_fkey"
      FOREIGN KEY ("campaignId") REFERENCES "LaunchCampaign"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LaunchCampaignRedemption_organizationId_fkey') THEN
    ALTER TABLE "LaunchCampaignRedemption"
      ADD CONSTRAINT "LaunchCampaignRedemption_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LaunchCampaignRedemption_venueId_fkey') THEN
    ALTER TABLE "LaunchCampaignRedemption"
      ADD CONSTRAINT "LaunchCampaignRedemption_venueId_fkey"
      FOREIGN KEY ("venueId") REFERENCES "Venue"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
