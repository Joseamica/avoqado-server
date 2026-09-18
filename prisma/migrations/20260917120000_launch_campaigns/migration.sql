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
--    `WHERE status <> 'RELEASED'`. Sin él, dos intentos simultáneos de la misma organización
--    cuentan DOS veces contra el cupo.
--
--    ⚠️ MEDIDO el 2026-09-17 contra Prisma 6.19.3, y NO es lo que decía el diseño: un
--    `prisma migrate diff --from-schema-datasource … --to-schema-datamodel …` sobre una base con
--    esta migración aplicada **no menciona este índice para nada**. Prisma no sabe representar un
--    índice parcial, así que su introspección lo IGNORA en vez de reportarlo como deriva.
--    Consecuencias, las dos: (a) ningún `migrate dev` futuro va a proponer borrarlo — bien;
--    (b) tampoco hay ninguna herramienta que avise si alguien lo borra a mano — y entonces el
--    cupo se puede sobrevender en silencio. Lo único que lo vigila es la prueba de integración
--    `tests/integration/launch-campaigns/schema.integration.test.ts`, que comprueba su `indexdef`
--    exacto. Si esa prueba se borra, este candado queda sin red.

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

    -- 🔴 `LaunchCampaignRedemption_amounts` NO se declara aquí: vive en la SECCIÓN 6, junto a los
    -- otros candados del snapshot, para que su cuerpo exista UNA sola vez. Ver la sección 6.
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
-- 🔴 NO LO BORRES. `prisma migrate diff` NO lo menciona (Prisma ignora los índices parciales),
-- así que su ausencia en un diff no significa que sobre: significa que Prisma no lo ve.
--
-- 🔴 CONSECUENCIA DE PRODUCTO, y hay que DECIRLA en pantalla, no dejarla como detalle técnico:
-- el índice es por ORGANIZACIÓN y cubre TODAS las campañas, y desde la sección 6.4 `APPLIED` es un
-- estado TERMINAL. Juntos significan que **una organización que ya redimió una oferta de
-- lanzamiento no puede redimir ninguna otra, nunca.** Es casi seguro la intención (una oferta de
-- captación es para clientes nuevos), pero el superadmin y el dashboard tienen que poder explicarlo
-- — «este negocio ya usó una oferta de lanzamiento» — en vez de que el alta falle con un 23505 que
-- nadie sabe leer.
-- ⚠️ Límite declarado: si una suscripción aplicada se cancela o se contracarga, la fila sigue
-- APPLIED y la organización queda fuera de futuras ofertas. Reabrirla pide una acción administrativa
-- explícita, no un cambio de estado en silencio.
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


-- ============================================================================
-- 6. Los candados que faltaban — cierre de la revisión independiente del 2026-09-17
--
--    Las dos tablas son NUEVAS y están VACÍAS en todos los entornos, así que apretarlas aquí no
--    cuesta nada; dentro de un mes sí. Todo va con `DROP … IF EXISTS` + `ADD`, no en el CREATE
--    TABLE de arriba, y la razón NO es de estilo: `CREATE TABLE IF NOT EXISTS` se SALTA entero si
--    la tabla ya existe, así que un candado escrito ahí nunca llegaría a una base creada por una
--    versión anterior de esta misma migración (sin desplegar). Con DROP+ADD converge cualquier
--    estado. Si alguna vez hubiera filas que los violan, el ADD falla ruidosamente — que es lo
--    correcto: dinero mal formado no se deja pasar en silencio.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 6.1 El SNAPSHOT del dinero (P2-2)
--     La ficha tenía NUEVE CHECK y la redención TRES — y la redención es lo que el cliente
--     CONSINTIÓ y de donde se arma el correo de confirmación. Medido el 2026-09-17: se aceptaban
--     `advertisedPriceCents = 1`, un `discountAmountCents` NEGATIVO (el cliente pagando MÁS que la
--     lista), `discountMonths` 0 / −5 / 999, `planTier = 'GRATIS'` y un cupón vacío.
-- ---------------------------------------------------------------------------

ALTER TABLE "LaunchCampaignRedemption" DROP CONSTRAINT IF EXISTS "LaunchCampaignRedemption_amounts";
ALTER TABLE "LaunchCampaignRedemption" ADD CONSTRAINT "LaunchCampaignRedemption_amounts" CHECK (
  "listPriceCents" - "discountAmountCents" = "advertisedPriceCents"
  -- El mismo mínimo de Stripe que la ficha: un snapshot por debajo describe un cobro imposible.
  AND "advertisedPriceCents" >= 1000
  -- Un «descuento» de 0 o negativo no es un descuento. Con la igualdad de arriba y sin esto,
  -- lista 1200 − (−1000) = 2200 cuadraba: el cliente pagando MÁS que el precio de lista.
  AND "discountAmountCents" > 0
);

ALTER TABLE "LaunchCampaignRedemption" DROP CONSTRAINT IF EXISTS "LaunchCampaignRedemption_months_range";
ALTER TABLE "LaunchCampaignRedemption" ADD CONSTRAINT "LaunchCampaignRedemption_months_range"
  CHECK ("discountMonths" BETWEEN 1 AND 24);

ALTER TABLE "LaunchCampaignRedemption" DROP CONSTRAINT IF EXISTS "LaunchCampaignRedemption_plan_tier_paid";
ALTER TABLE "LaunchCampaignRedemption" ADD CONSTRAINT "LaunchCampaignRedemption_plan_tier_paid"
  CHECK ("planTier" IN ('PRO', 'PREMIUM'));

ALTER TABLE "LaunchCampaignRedemption" DROP CONSTRAINT IF EXISTS "LaunchCampaignRedemption_coupon_present";
ALTER TABLE "LaunchCampaignRedemption" ADD CONSTRAINT "LaunchCampaignRedemption_coupon_present"
  -- `btrim`: una cadena de espacios es tan inservible como la vacía, y es lo que produce un
  -- formulario al que alguien le dio a la barra espaciadora.
  CHECK (length(btrim("stripeCouponId")) > 0);

-- ---------------------------------------------------------------------------
-- 6.2 La forma de lo que llega a la URL pública y al payload cacheado (P3-2, P3-6)
--     `landingSlug` aceptaba '', '../../etc/passwd' y 'POS 22 MAYUS'. La ruta pública valida el
--     slug con su propio regex, así que una ficha creada así queda INALCANZABLE en /oferta/<slug>
--     — y nadie se entera hasta que el anuncio está vivo y los clics dan 404.
-- ---------------------------------------------------------------------------

ALTER TABLE "LaunchCampaign" DROP CONSTRAINT IF EXISTS "LaunchCampaign_landing_slug_shape";
ALTER TABLE "LaunchCampaign" ADD CONSTRAINT "LaunchCampaign_landing_slug_shape"
  CHECK ("landingSlug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "LaunchCampaign" DROP CONSTRAINT IF EXISTS "LaunchCampaign_code_present";
ALTER TABLE "LaunchCampaign" ADD CONSTRAINT "LaunchCampaign_code_present" CHECK (length(btrim("code")) > 0);

ALTER TABLE "LaunchCampaign" DROP CONSTRAINT IF EXISTS "LaunchCampaign_name_present";
ALTER TABLE "LaunchCampaign" ADD CONSTRAINT "LaunchCampaign_name_present" CHECK (length(btrim("name")) > 0);

ALTER TABLE "LaunchCampaign" DROP CONSTRAINT IF EXISTS "LaunchCampaign_copy_length";
ALTER TABLE "LaunchCampaign" ADD CONSTRAINT "LaunchCampaign_copy_length" CHECK (
  ("headline" IS NULL OR length("headline") <= 200)
  AND ("subheadline" IS NULL OR length("subheadline") <= 200)
);

ALTER TABLE "LaunchCampaign" DROP CONSTRAINT IF EXISTS "LaunchCampaign_bullets_bounded";
ALTER TABLE "LaunchCampaign" ADD CONSTRAINT "LaunchCampaign_bullets_bounded" CHECK (
  coalesce(array_length("bullets", 1), 0) <= 8
  -- 🔴 El tope que de verdad acota el payload es el LARGO TOTAL, no el número de viñetas: ocho
  -- viñetas sin límite de longitud siguen siendo ilimitadas. Un CHECK no puede medir el elemento
  -- más largo (una subconsulta no está permitida), así que se acota la suma. `array_to_string` es
  -- IMMUTABLE, que es lo que lo hace admisible aquí.
  AND length(array_to_string("bullets", '')) <= 1600
);

-- ---------------------------------------------------------------------------
-- 6.3 🔴 Una ficha con cupón en Stripe NO cambia de precio (P2-4)
--
--     Medido: sobre una ficha ACTIVE **con una redención viva**, un UPDATE cambiaba el precio
--     anunciado, el descuento, el `code`, el `landingSlug`, el `offerVersion` y hasta el propio
--     cupón. El cupón de Stripe ya nació con su `amount_off`: después de esa edición Stripe cobra
--     `lista − descuentoViejo` mientras /oferta/<slug> anuncia el número nuevo.
--
--     🔴 Por qué un trigger y no un CHECK: un CHECK no ve el valor ANTERIOR de la fila, así que no
--     puede expresar inmutabilidad. La otra salida era «S5 será el único escritor» — pero S5 no
--     existe todavía y el contrato se congela HOY para que otros tres repos empiecen.
--
--     🔴 Y el candado se cierra cuando EXISTE EL CUPÓN, no cuando el estado es ACTIVE: una ficha
--     PAUSED conserva su cupón vivo en Stripe. Un borrador sin cupón se edita entero — si no, el
--     superadmin no podría corregir una errata antes de publicar. La activación misma pasa porque
--     es el UPDATE que ESTRENA el cupón (OLD."stripeCouponId" sigue en NULL), no uno que lo cambia.
--
--     Consecuencia operativa, declarada: un cupón mal creado en Stripe NO se repara editando la
--     ficha — se termina la campaña (ENDED) y se crea otra. Es la única forma de que lo anunciado
--     y lo cobrado no puedan divergir.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "launch_campaign_freeze_terms"() RETURNS trigger AS $$
BEGIN
  IF OLD."stripeCouponId" IS NULL THEN
    RETURN NEW; -- todavía es un borrador: nada se ha prometido en Stripe
  END IF;

  IF NEW."advertisedPriceCents"   IS DISTINCT FROM OLD."advertisedPriceCents"
     OR NEW."discountAmountCents"    IS DISTINCT FROM OLD."discountAmountCents"
     OR NEW."listPriceCentsSnapshot" IS DISTINCT FROM OLD."listPriceCentsSnapshot"
     OR NEW."discountMonths"         IS DISTINCT FROM OLD."discountMonths"
     OR NEW."planTier"               IS DISTINCT FROM OLD."planTier"
     OR NEW."billingInterval"        IS DISTINCT FROM OLD."billingInterval"
     OR NEW."currency"               IS DISTINCT FROM OLD."currency"
     OR NEW."stripeCouponId"         IS DISTINCT FROM OLD."stripeCouponId"
     OR NEW."stripePriceId"          IS DISTINCT FROM OLD."stripePriceId"
     OR NEW."code"                   IS DISTINCT FROM OLD."code"
     OR NEW."landingSlug"            IS DISTINCT FROM OLD."landingSlug"
     OR NEW."offerVersion"           IS DISTINCT FROM OLD."offerVersion"
  THEN
    RAISE EXCEPTION
      'LaunchCampaign_terms_frozen: la campana % ya tiene cupon en Stripe (%); sus terminos comerciales no se pueden cambiar. Para vender otro precio, termina esta campana y crea una nueva.',
      OLD."id", OLD."stripeCouponId"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "launch_campaign_freeze_terms_trg" ON "LaunchCampaign";
CREATE TRIGGER "launch_campaign_freeze_terms_trg"
  BEFORE UPDATE ON "LaunchCampaign"
  FOR EACH ROW EXECUTE FUNCTION "launch_campaign_freeze_terms"();

-- ---------------------------------------------------------------------------
-- 6.4 🔴 Liberar dos veces la misma redención sobrevendería el cupo (P3-4)
--
--     El cupo se descuenta del CONTADOR, no de las filas: liberar hace `redemptionCount - 1`. Si
--     el mismo intento se libera DOS veces, el contador baja dos y entra un cliente de más;
--     `redemptionCount >= 0` sólo lo caza al llegar a cero. Medido: la segunda liberación sobre
--     una fila ya RELEASED era ACEPTADA, y también `APPLIED → RELEASED` — soltar el cupo de
--     alguien a quien Stripe YA le cobró.
--
--     🔴 Esto NO sustituye al CAS que el servicio de reserva (S8) tiene que escribir
--     (`UPDATE … WHERE id = $1 AND status = 'RESERVED'`, y decrementar SÓLO si afectó 1 fila, en la
--     misma transacción). Lo vuelve OBLIGATORIO: con este trigger la forma insegura revienta en
--     vez de pasar en silencio, y la forma segura ni siquiera llega aquí (afecta 0 filas).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "launch_redemption_state_machine"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'RELEASED' THEN
    -- RELEASED es TERMINAL. Se permite un UPDATE que no toque ni el estado ni la fecha (anotar un
    -- `lastError`, por ejemplo); lo que no se permite es volver a liberar ni resucitar la fila.
    IF NEW."status" <> 'RELEASED' OR NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" THEN
      RAISE EXCEPTION
        'LaunchCampaignRedemption_released_is_terminal: la redencion % ya estaba liberada; volver a liberarla descontaria el cupo dos veces.',
        OLD."id" USING ERRCODE = '23514';
    END IF;
  ELSIF OLD."status" = 'APPLIED' AND NEW."status" <> 'APPLIED' THEN
    RAISE EXCEPTION
      'LaunchCampaignRedemption_applied_is_terminal: la redencion % ya fue cobrada por Stripe (%); su cupo no se suelta.',
      OLD."id", OLD."stripeSubscriptionId" USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "launch_redemption_state_machine_trg" ON "LaunchCampaignRedemption";
CREATE TRIGGER "launch_redemption_state_machine_trg"
  BEFORE UPDATE ON "LaunchCampaignRedemption"
  FOR EACH ROW EXECUTE FUNCTION "launch_redemption_state_machine"();
