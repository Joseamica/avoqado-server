-- A zero-priced Free plan or explicit free campaign period is satisfied by
-- the accepted commercial offer, never by fabricating a cash receipt.
ALTER TYPE "CommercialEventOutboxEventType"
  ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_NON_CASH_ACTIVATED';

CREATE OR REPLACE FUNCTION commercial_billing_guard_non_cash_activation_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  period_row RECORD;
BEGIN
  IF NEW."eventType" <> 'SUBSCRIPTION_NON_CASH_ACTIVATED' THEN
    RETURN NEW;
  END IF;

  SELECT period."id", period."status"::text AS period_status,
         period."statusRevision", period."amountDueMinor",
         contract."organizationId", contract."venueId",
         acceptance."status"::text AS acceptance_status,
         ar."status"::text AS receivable_status,
         ar."amountDueMinor" AS receivable_amount,
         EXISTS (
           SELECT 1 FROM "CommercialBillingAllocation" allocation
            WHERE allocation."receivableId" = ar."id"
         ) AS has_allocation,
         EXISTS (
           SELECT 1 FROM "CommercialBillingPaymentAttempt" attempt
            WHERE attempt."receivableId" = ar."id"
         ) AS has_payment_attempt
    INTO period_row
  FROM "CommercialSubscriptionPeriod" period
  JOIN "CommercialSubscriptionContract" contract ON contract."id" = period."contractId"
  JOIN "CommercialQuoteAcceptance" acceptance ON acceptance."id" = contract."quoteAcceptanceId"
  JOIN "CommercialAccountReceivable" ar ON ar."subscriptionPeriodId" = period."id"
  WHERE period."id" = NEW."sourceId"
  FOR SHARE OF period, contract, acceptance, ar;

  IF NEW."sourceType" <> 'SUBSCRIPTION_PERIOD'
     OR period_row."id" IS NULL
     OR period_row.period_status <> 'PAID'
     OR period_row."statusRevision" <> NEW."sourceRevision"
     OR period_row."amountDueMinor" <> 0
     OR period_row.receivable_status <> 'PAID'
     OR period_row.receivable_amount <> 0
     OR period_row.acceptance_status <> 'ACCEPTED'
     OR period_row."organizationId" <> NEW."organizationId"
     OR period_row."venueId" <> NEW."venueId"
     OR period_row.has_allocation
     OR period_row.has_payment_attempt
     OR NEW."payload"->>'schemaVersion' <> '1'
     OR NEW."payload"->>'contractId' IS NULL
     OR NEW."payload"->>'activationBasis' <> 'ZERO_AMOUNT_ACCEPTED_OFFER'
     OR NEW."payload"->>'amountDueMinor' <> '0'
     OR NEW."payload"->>'periodId' <> NEW."sourceId"
     OR COALESCE(
       CASE
         WHEN jsonb_typeof(NEW."payload"->'sourceRevision') = 'number'
              AND NEW."payload"->>'sourceRevision' ~ '^[1-9][0-9]*$'
           THEN (NEW."payload"->>'sourceRevision')::integer
         ELSE NULL
       END,
       -1
     ) <> NEW."sourceRevision" THEN
    RAISE EXCEPTION 'commercial non-cash activation source mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialEventOutbox_non_cash_source_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CommercialEventOutbox_non_cash_source_guard_trigger"
BEFORE INSERT ON "CommercialEventOutbox"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_guard_non_cash_activation_event();

CREATE OR REPLACE FUNCTION commercial_billing_guard_entitlement_projection_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_row "CommercialEventOutbox"%ROWTYPE;
BEGIN
  SELECT * INTO event_row
  FROM "CommercialEventOutbox"
  WHERE "eventId" = NEW."eventId"
  FOR SHARE;

  IF event_row."eventId" IS NULL
     OR event_row."eventType" NOT IN (
       'SUBSCRIPTION_PAYMENT_RECONCILED',
       'SUBSCRIPTION_NON_CASH_ACTIVATED',
       'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED'
     )
     OR event_row."sourceType" <> 'SUBSCRIPTION_PERIOD'
     OR event_row."sourceId" <> NEW."subscriptionPeriodId"
     OR event_row."sourceRevision" <> NEW."sourceRevision"
     OR event_row."organizationId" <> NEW."organizationId"
     OR event_row."venueId" <> NEW."venueId" THEN
    RAISE EXCEPTION 'commercial entitlement projection source mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialEntitlementProjection_source_check';
  END IF;

  IF (NEW."action" = 'GRANT' AND event_row."eventType" NOT IN (
        'SUBSCRIPTION_PAYMENT_RECONCILED', 'SUBSCRIPTION_NON_CASH_ACTIVATED'
      ))
     OR (NEW."action" = 'REVOKE' AND event_row."eventType" <> 'SUBSCRIPTION_PAYMENT_COVERAGE_REVERSED') THEN
    RAISE EXCEPTION 'commercial entitlement projection action mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialEntitlementProjection_action_check';
  END IF;
  RETURN NEW;
END;
$$;
