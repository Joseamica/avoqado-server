-- P3-1A1c-c: durable eventual ActivityLog delivery for manual EFFECT retries.
-- Claim + immutable result intent are one transaction; delivery is local-only,
-- idempotent and restart-safe.

BEGIN;

CREATE TYPE "WebhookManualRetryOutcome" AS ENUM (
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'INTERRUPTED',
  'UNKNOWN'
);

CREATE TABLE "WebhookManualRetryResultOutbox" (
  id TEXT NOT NULL,
  "webhookEventId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "venueId" TEXT,
  reason VARCHAR(160) NOT NULL,
  "requestActivityLogId" TEXT NOT NULL,
  "resultActivityLogId" TEXT NOT NULL,
  "effectAttempt" INTEGER NOT NULL,
  "effectClaimToken" TEXT NOT NULL,
  "effectClaimedBy" TEXT NOT NULL,
  "effectClaimedAt" TIMESTAMP(3) NOT NULL,
  "effectClaimExpiresAt" TIMESTAMP(3) NOT NULL,
  "dispatchStartedAt" TIMESTAMP(3),
  outcome "WebhookManualRetryOutcome",
  "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  "deliveryClaimToken" TEXT,
  "deliveryClaimedBy" TEXT,
  "deliveryClaimedAt" TIMESTAMP(3),
  "deliveryClaimExpiresAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', CURRENT_TIMESTAMP),
  CONSTRAINT "WebhookManualRetryResultOutbox_pkey" PRIMARY KEY (id),
  CONSTRAINT "WebhookManualRetryResultOutbox_webhookEventId_fkey"
    FOREIGN KEY ("webhookEventId") REFERENCES "WebhookEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WebhookManualRetryResultOutbox_requestActivityLogId_fkey"
    FOREIGN KEY ("requestActivityLogId") REFERENCES "ActivityLog"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WebhookManualRetryResultOutbox_text_check" CHECK (
    btrim(id) <> ''
    AND btrim("actorId") <> ''
    AND btrim(reason) <> ''
    AND char_length(reason) <= 160
    AND btrim("requestActivityLogId") <> ''
    AND btrim("resultActivityLogId") <> ''
    AND btrim("effectClaimToken") <> ''
    AND btrim("effectClaimedBy") <> ''
  ),
  CONSTRAINT "WebhookManualRetryResultOutbox_attempt_check" CHECK (
    "effectAttempt" >= 1 AND "deliveryAttempts" >= 0
  ),
  CONSTRAINT "WebhookManualRetryResultOutbox_effect_lease_check" CHECK (
    "effectClaimExpiresAt" > "effectClaimedAt"
  ),
  CONSTRAINT "WebhookManualRetryResultOutbox_dispatch_check" CHECK (
    "dispatchStartedAt" IS NULL OR "dispatchStartedAt" >= "effectClaimedAt"
  ),
  CONSTRAINT "WebhookManualRetryResultOutbox_delivery_lease_check" CHECK (
    ("deliveryClaimToken" IS NULL AND "deliveryClaimedBy" IS NULL
      AND "deliveryClaimedAt" IS NULL AND "deliveryClaimExpiresAt" IS NULL)
    OR
    ("deliveryClaimToken" IS NOT NULL AND btrim("deliveryClaimToken") <> ''
      AND "deliveryClaimedBy" IS NOT NULL AND btrim("deliveryClaimedBy") <> ''
      AND "deliveryClaimedAt" IS NOT NULL AND "deliveryClaimExpiresAt" IS NOT NULL
      AND "deliveryClaimExpiresAt" > "deliveryClaimedAt")
  ),
  CONSTRAINT "WebhookManualRetryResultOutbox_delivery_state_check" CHECK (
    ("deliveredAt" IS NULL AND "nextAttemptAt" IS NOT NULL)
    OR
    ("deliveredAt" IS NOT NULL AND outcome IS NOT NULL AND "nextAttemptAt" IS NULL
      AND "deliveryClaimToken" IS NULL AND "deliveryClaimedBy" IS NULL
      AND "deliveryClaimedAt" IS NULL AND "deliveryClaimExpiresAt" IS NULL)
  ),
  CONSTRAINT "WebhookManualRetryResultOutbox_outcome_evidence_check" CHECK (
    outcome IS NULL OR outcome = 'INTERRUPTED' OR "dispatchStartedAt" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "WebhookManualRetryResultOutbox_requestActivityLogId_key"
  ON "WebhookManualRetryResultOutbox"("requestActivityLogId");
CREATE UNIQUE INDEX "WebhookManualRetryResultOutbox_resultActivityLogId_key"
  ON "WebhookManualRetryResultOutbox"("resultActivityLogId");
CREATE UNIQUE INDEX "WebhookManualRetryResultOutbox_effectClaimToken_key"
  ON "WebhookManualRetryResultOutbox"("effectClaimToken");
CREATE UNIQUE INDEX "WebhookManualRetryResultOutbox_webhookEventId_effectAttempt_key"
  ON "WebhookManualRetryResultOutbox"("webhookEventId", "effectAttempt");
CREATE INDEX "WebhookManualRetryResultOutbox_delivery_idx"
  ON "WebhookManualRetryResultOutbox"("deliveredAt", "nextAttemptAt", "createdAt");
CREATE INDEX "WebhookManualRetryResultOutbox_deliveryClaim_idx"
  ON "WebhookManualRetryResultOutbox"("deliveryClaimExpiresAt");
CREATE INDEX "WebhookManualRetryResultOutbox_actor_created_idx"
  ON "WebhookManualRetryResultOutbox"("actorId", "createdAt");

CREATE FUNCTION restrict_webhook_manual_retry_result_outbox_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'WebhookManualRetryResultOutbox cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW."webhookEventId" IS DISTINCT FROM OLD."webhookEventId"
    OR NEW."actorId" IS DISTINCT FROM OLD."actorId"
    OR NEW."venueId" IS DISTINCT FROM OLD."venueId"
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW."requestActivityLogId" IS DISTINCT FROM OLD."requestActivityLogId"
    OR NEW."resultActivityLogId" IS DISTINCT FROM OLD."resultActivityLogId"
    OR NEW."effectAttempt" IS DISTINCT FROM OLD."effectAttempt"
    OR NEW."effectClaimToken" IS DISTINCT FROM OLD."effectClaimToken"
    OR NEW."effectClaimedBy" IS DISTINCT FROM OLD."effectClaimedBy"
    OR NEW."effectClaimedAt" IS DISTINCT FROM OLD."effectClaimedAt"
    OR NEW."effectClaimExpiresAt" IS DISTINCT FROM OLD."effectClaimExpiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'WebhookManualRetryResultOutbox authority is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."dispatchStartedAt" IS NOT NULL
    AND NEW."dispatchStartedAt" IS DISTINCT FROM OLD."dispatchStartedAt"
  THEN
    RAISE EXCEPTION 'WebhookManualRetryResultOutbox dispatch start is write-once'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    RAISE EXCEPTION 'WebhookManualRetryResultOutbox outcome is write-once'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."deliveredAt" IS NOT NULL
    AND NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt"
  THEN
    RAISE EXCEPTION 'WebhookManualRetryResultOutbox delivery is terminal'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_manual_retry_result_outbox_delivery_only
BEFORE UPDATE OR DELETE ON "WebhookManualRetryResultOutbox"
FOR EACH ROW EXECUTE FUNCTION restrict_webhook_manual_retry_result_outbox_mutation();

COMMIT;
