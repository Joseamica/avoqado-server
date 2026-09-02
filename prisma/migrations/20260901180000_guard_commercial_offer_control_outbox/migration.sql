-- P3-B: prove that a global offer-control outbox row is an exact projection
-- of one immutable Offer v3 control event. Payload never carries the reason.

CREATE OR REPLACE FUNCTION commercial_billing_guard_offer_control_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  control_event RECORD;
  expected_state TEXT;
BEGIN
  IF NEW."sourceType" <> 'OFFER_CONTROL_EVENT' THEN
    RETURN NEW;
  END IF;

  SELECT "id", "offerVersionId", "offerSchemaVersion", "revision", "action"::TEXT AS "action"
    INTO control_event
  FROM "CommercialOfferControlEvent"
  WHERE "id" = NEW."sourceId"
  FOR SHARE;

  expected_state := CASE
    WHEN control_event."action" = 'RESUME' THEN 'OPEN'
    ELSE control_event."action"
  END;

  IF control_event."id" IS NULL
     OR control_event."offerSchemaVersion" <> 3
     OR control_event."revision" <> NEW."sourceRevision"
     OR NEW."eventType" <> 'COMMERCIAL_OFFER_CONTROL_CHANGED'
     OR NEW."organizationId" IS NOT NULL
     OR NEW."venueId" IS NOT NULL
     OR NEW."payload"->>'schemaVersion' <> '1'
     OR NEW."payload"->>'offerVersionId' <> control_event."offerVersionId"
     OR NEW."payload"->>'offerSchemaVersion' <> '3'
     OR NEW."payload"->>'controlEventId' <> control_event."id"
     OR NEW."payload"->>'controlAction' <> control_event."action"
     OR NEW."payload"->>'state' <> expected_state
     OR NEW."payload" ? 'reason' THEN
    RAISE EXCEPTION 'commercial offer-control outbox source mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'CommercialEventOutbox_offer_control_source_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CommercialEventOutbox_offer_control_source_guard_trigger"
BEFORE INSERT ON "CommercialEventOutbox"
FOR EACH ROW EXECUTE FUNCTION commercial_billing_guard_offer_control_outbox_insert();
