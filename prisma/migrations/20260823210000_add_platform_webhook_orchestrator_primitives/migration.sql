-- P3-1A1c-a: durable orchestration primitives for the Stripe PLATFORM inbox.
-- This migration does not start recovery or dispatch effects. The temporary
-- legacy projection trigger is a drain-cutover compatibility fallback.

BEGIN;

CREATE FUNCTION avoqado_webhook_max_attempts() RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT 5 $$;

CREATE TABLE "WebhookDispatchObservation" (
  "webhookEventId" TEXT NOT NULL,
  "effectAttempt" INTEGER NOT NULL,
  steps JSONB NOT NULL,
  "effectOutcome" VARCHAR(64) NOT NULL,
  "failureStep" VARCHAR(64),
  "comparisonCode" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  CONSTRAINT "WebhookDispatchObservation_pkey" PRIMARY KEY ("webhookEventId", "effectAttempt"),
  CONSTRAINT "WebhookDispatchObservation_webhookEventId_fkey"
    FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WebhookDispatchObservation_attempt_check" CHECK ("effectAttempt" >= 1),
  CONSTRAINT "WebhookDispatchObservation_steps_check" CHECK (jsonb_typeof(steps) = 'array'),
  CONSTRAINT "WebhookDispatchObservation_codes_check" CHECK (
    btrim("effectOutcome") <> '' AND btrim("comparisonCode") <> ''
    AND ("failureStep" IS NULL OR btrim("failureStep") <> '')
  )
);

CREATE INDEX "WebhookDispatchObservation_createdAt_idx"
  ON "WebhookDispatchObservation"("createdAt");

CREATE FUNCTION reject_webhook_dispatch_observation_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'WebhookDispatchObservation is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER webhook_dispatch_observation_append_only
BEFORE UPDATE OR DELETE ON "WebhookDispatchObservation"
FOR EACH ROW EXECUTE FUNCTION reject_webhook_dispatch_observation_mutation();

CREATE TABLE "WebhookOperationalAlert" (
  "webhookEventId" TEXT NOT NULL,
  phase "WebhookClaimPhase" NOT NULL,
  "terminalReason" VARCHAR(64) NOT NULL,
  attempt INTEGER NOT NULL,
  payload JSONB NOT NULL,
  "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  "claimToken" TEXT,
  "claimedBy" TEXT,
  "claimedAt" TIMESTAMP(3),
  "claimExpiresAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  CONSTRAINT "WebhookOperationalAlert_pkey" PRIMARY KEY ("webhookEventId", phase, "terminalReason"),
  CONSTRAINT "WebhookOperationalAlert_webhookEventId_fkey"
    FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WebhookOperationalAlert_reason_check" CHECK (btrim("terminalReason") <> ''),
  CONSTRAINT "WebhookOperationalAlert_attempts_check" CHECK (attempt >= 0 AND "deliveryAttempts" >= 0),
  CONSTRAINT "WebhookOperationalAlert_payload_check" CHECK (
    jsonb_typeof(payload) = 'object'
    AND payload ?& ARRAY['webhookEventId', 'phase', 'terminalReason', 'attempt']
    AND (payload - ARRAY['webhookEventId', 'phase', 'terminalReason', 'attempt']) = '{}'::jsonb
  ),
  CONSTRAINT "WebhookOperationalAlert_lease_complete_check" CHECK (
    ("claimToken" IS NULL AND "claimedBy" IS NULL AND "claimedAt" IS NULL AND "claimExpiresAt" IS NULL)
    OR
    ("claimToken" IS NOT NULL AND btrim("claimToken") <> ''
      AND "claimedBy" IS NOT NULL AND btrim("claimedBy") <> ''
      AND "claimedAt" IS NOT NULL AND "claimExpiresAt" IS NOT NULL)
  ),
  CONSTRAINT "WebhookOperationalAlert_lease_expiry_check" CHECK (
    "claimExpiresAt" IS NULL OR "claimExpiresAt" > "claimedAt"
  ),
  CONSTRAINT "WebhookOperationalAlert_delivery_check" CHECK (
    ("deliveredAt" IS NULL AND "nextAttemptAt" IS NOT NULL)
    OR
    ("deliveredAt" IS NOT NULL AND "nextAttemptAt" IS NULL
      AND "claimToken" IS NULL AND "claimedBy" IS NULL AND "claimedAt" IS NULL AND "claimExpiresAt" IS NULL)
  )
);

CREATE INDEX "WebhookOperationalAlert_delivery_idx"
  ON "WebhookOperationalAlert"("deliveredAt", "nextAttemptAt", "createdAt");
CREATE INDEX "WebhookOperationalAlert_claim_idx"
  ON "WebhookOperationalAlert"("claimExpiresAt");

CREATE FUNCTION restrict_webhook_operational_alert_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'WebhookOperationalAlert cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."webhookEventId" IS DISTINCT FROM OLD."webhookEventId"
    OR NEW.phase IS DISTINCT FROM OLD.phase
    OR NEW."terminalReason" IS DISTINCT FROM OLD."terminalReason"
    OR NEW.attempt IS DISTINCT FROM OLD.attempt
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'WebhookOperationalAlert authority and payload are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_operational_alert_delivery_only
BEFORE UPDATE OR DELETE ON "WebhookOperationalAlert"
FOR EACH ROW EXECUTE FUNCTION restrict_webhook_operational_alert_mutation();

-- Strict compatibility signature: status/retryCount-only legacy writes are
-- projected into A1a EFFECT columns. Any explicit A1a machine change passes
-- through untouched so the stable CHECK remains authoritative.
CREATE FUNCTION project_legacy_webhook_effect_v1() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  explicit_a1a_change boolean;
  legacy_signature_valid boolean;
  counted_attempt boolean;
  terminal_reason text := 'EFFECT_ATTEMPTS_EXHAUSTED';
BEGIN
  explicit_a1a_change :=
    NEW."classificationState" IS DISTINCT FROM OLD."classificationState"
    OR NEW."classificationAttempts" IS DISTINCT FROM OLD."classificationAttempts"
    OR NEW."classificationNextAttemptAt" IS DISTINCT FROM OLD."classificationNextAttemptAt"
    OR NEW."classificationErrorCode" IS DISTINCT FROM OLD."classificationErrorCode"
    OR NEW."classificationErrorMessage" IS DISTINCT FROM OLD."classificationErrorMessage"
    OR NEW."classificationResolvedAt" IS DISTINCT FROM OLD."classificationResolvedAt"
    OR NEW."effectAttempts" IS DISTINCT FROM OLD."effectAttempts"
    OR NEW."effectNextAttemptAt" IS DISTINCT FROM OLD."effectNextAttemptAt"
    OR NEW."ownerKind" IS DISTINCT FROM OLD."ownerKind"
    OR NEW."routeKey" IS DISTINCT FROM OLD."routeKey"
    OR NEW."subjectKind" IS DISTINCT FROM OLD."subjectKind"
    OR NEW."subjectId" IS DISTINCT FROM OLD."subjectId"
    OR NEW."claimPhase" IS DISTINCT FROM OLD."claimPhase"
    OR NEW."claimToken" IS DISTINCT FROM OLD."claimToken"
    OR NEW."claimedBy" IS DISTINCT FROM OLD."claimedBy"
    OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
    OR NEW."claimExpiresAt" IS DISTINCT FROM OLD."claimExpiresAt";

  IF explicit_a1a_change
    OR (NEW.status IS NOT DISTINCT FROM OLD.status AND NEW."retryCount" IS NOT DISTINCT FROM OLD."retryCount")
  THEN
    RETURN NEW;
  END IF;

  counted_attempt := (
    OLD.status IN ('PENDING', 'FAILED', 'RETRYING')
    AND NEW.status = 'RETRYING'
    AND NEW."retryCount" = OLD."retryCount" + 1
  ) OR (
    OLD.status = 'PENDING'
    AND NEW.status = 'FAILED'
    AND NEW."retryCount" = OLD."retryCount" + 1
  );

  IF NEW.status = 'RETRYING' AND NEW."retryCount" > avoqado_webhook_max_attempts() THEN
    RAISE EXCEPTION 'AVQ_WEBHOOK_EFFECT_BUDGET_EXHAUSTED'
      USING ERRCODE = 'P0001';
  END IF;

  legacy_signature_valid := (
    counted_attempt
    AND NEW."retryCount" <= avoqado_webhook_max_attempts()
  ) OR (
    OLD.status = 'RETRYING'
    AND NEW.status = 'FAILED'
    AND NEW."retryCount" = OLD."retryCount"
  ) OR (
    OLD.status IN ('PENDING', 'RETRYING')
    AND NEW.status = 'SUCCESS'
    AND NEW."retryCount" = OLD."retryCount"
  );

  IF NOT legacy_signature_valid THEN
    RAISE EXCEPTION 'AVQ_WEBHOOK_LEGACY_TRANSITION_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  NEW."effectAttempts" := NEW."retryCount";

  IF NEW.status = 'SUCCESS' THEN
    NEW."effectNextAttemptAt" := NULL;
  ELSIF NEW.status = 'PENDING' AND NEW."retryCount" < avoqado_webhook_max_attempts() THEN
    NEW."effectNextAttemptAt" := COALESCE(OLD."effectNextAttemptAt", NEW."createdAt", timezone('UTC', CURRENT_TIMESTAMP));
  ELSIF NEW.status = 'RETRYING'
    AND NEW."retryCount" BETWEEN 1 AND avoqado_webhook_max_attempts()
  THEN
    NEW."effectNextAttemptAt" := COALESCE(OLD."effectNextAttemptAt", NEW."createdAt", timezone('UTC', CURRENT_TIMESTAMP));
  ELSIF NEW.status = 'FAILED' AND NEW."retryCount" < avoqado_webhook_max_attempts() THEN
    NEW."effectNextAttemptAt" := COALESCE(OLD."effectNextAttemptAt", NEW."createdAt", timezone('UTC', CURRENT_TIMESTAMP));
  ELSIF NEW.status = 'FAILED' AND NEW."retryCount" >= avoqado_webhook_max_attempts() THEN
    NEW."effectNextAttemptAt" := NULL;
    INSERT INTO "WebhookOperationalAlert" (
      "webhookEventId", phase, "terminalReason", attempt, payload
    ) VALUES (
      NEW.id,
      'EFFECT',
      terminal_reason,
      NEW."retryCount",
      jsonb_build_object(
        'webhookEventId', NEW.id,
        'phase', 'EFFECT',
        'terminalReason', terminal_reason,
        'attempt', NEW."retryCount"
      )
    )
    ON CONFLICT ("webhookEventId", phase, "terminalReason") DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_event_legacy_effect_projection_v1
BEFORE UPDATE ON "WebhookEvent"
FOR EACH ROW EXECUTE FUNCTION project_legacy_webhook_effect_v1();

-- Normalize without inferring authority from payload or metadata.
UPDATE "WebhookEvent"
SET "effectAttempts" = "retryCount";

UPDATE "WebhookEvent"
SET "effectNextAttemptAt" = NULL
WHERE status = 'SUCCESS';

UPDATE "WebhookEvent"
SET "effectNextAttemptAt" = COALESCE("effectNextAttemptAt", "createdAt", timezone('UTC', CURRENT_TIMESTAMP))
WHERE status IN ('PENDING', 'RETRYING', 'FAILED')
  AND "effectAttempts" < avoqado_webhook_max_attempts();

UPDATE "WebhookEvent"
SET status = 'FAILED', "effectNextAttemptAt" = NULL
WHERE status IN ('PENDING', 'FAILED')
  AND "effectAttempts" >= avoqado_webhook_max_attempts();

UPDATE "WebhookEvent"
SET "effectNextAttemptAt" = COALESCE("effectNextAttemptAt", "createdAt", timezone('UTC', CURRENT_TIMESTAMP))
WHERE status = 'RETRYING'
  AND "effectAttempts" = avoqado_webhook_max_attempts();

WITH over_budget AS MATERIALIZED (
  SELECT id, "effectAttempts"
  FROM "WebhookEvent"
  WHERE status = 'RETRYING'
    AND "effectAttempts" > avoqado_webhook_max_attempts()
  FOR UPDATE
), normalized AS (
  UPDATE "WebhookEvent" event
  SET status = 'FAILED',
      "effectNextAttemptAt" = NULL,
      "updatedAt" = timezone('UTC', CURRENT_TIMESTAMP)
  FROM over_budget
  WHERE event.id = over_budget.id
  RETURNING event.id, event."effectAttempts"
)
INSERT INTO "WebhookOperationalAlert" (
  "webhookEventId", phase, "terminalReason", attempt, payload
)
SELECT
  id,
  'EFFECT',
  'LEGACY_EFFECT_ATTEMPTS_OVER_BUDGET',
  "effectAttempts",
  jsonb_build_object(
    'webhookEventId', id,
    'phase', 'EFFECT',
    'terminalReason', 'LEGACY_EFFECT_ATTEMPTS_OVER_BUDGET',
    'attempt', "effectAttempts"
  )
FROM normalized
ON CONFLICT ("webhookEventId", phase, "terminalReason") DO NOTHING;

ALTER TABLE "WebhookEvent"
  ADD CONSTRAINT "WebhookEvent_effect_projection_v1_check" CHECK (
    "effectAttempts" = "retryCount"
    AND (
      (status = 'SUCCESS' AND "effectNextAttemptAt" IS NULL)
      OR (status = 'PENDING' AND "effectAttempts" < avoqado_webhook_max_attempts() AND "effectNextAttemptAt" IS NOT NULL)
      OR (status = 'RETRYING' AND "effectAttempts" BETWEEN 1 AND avoqado_webhook_max_attempts() AND "effectNextAttemptAt" IS NOT NULL)
      OR (status = 'FAILED' AND "effectAttempts" < avoqado_webhook_max_attempts() AND "effectNextAttemptAt" IS NOT NULL)
      OR (status = 'FAILED' AND "effectAttempts" >= avoqado_webhook_max_attempts() AND "effectNextAttemptAt" IS NULL)
    )
  );

COMMIT;
