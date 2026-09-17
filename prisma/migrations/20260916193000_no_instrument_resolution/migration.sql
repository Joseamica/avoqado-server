-- Additive: supervisor testimony survives replacement of request.resultJson by a late approval.
ALTER TABLE "TerminalPaymentAttemptLink" ADD COLUMN "operatorResolution" JSONB;

-- The declaration is write-once. Only its one-time local closure acknowledgement may be added.
CREATE FUNCTION preserve_no_instrument_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."operatorResolution" IS NOT NULL AND (
    NEW."operatorResolution" IS NULL
    OR (NEW."operatorResolution" - 'acknowledgedAt') IS DISTINCT FROM (OLD."operatorResolution" - 'acknowledgedAt')
    OR (OLD."operatorResolution"->>'acknowledgedAt' IS NOT NULL
        AND NEW."operatorResolution"->'acknowledgedAt' IS DISTINCT FROM OLD."operatorResolution"->'acknowledgedAt')
  ) THEN
    RAISE EXCEPTION 'Operator declaration is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_no_instrument_resolution
BEFORE UPDATE OF "operatorResolution" ON "TerminalPaymentAttemptLink"
FOR EACH ROW EXECUTE FUNCTION preserve_no_instrument_resolution();
