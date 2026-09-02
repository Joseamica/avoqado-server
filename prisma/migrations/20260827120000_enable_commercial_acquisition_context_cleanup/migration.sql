CREATE FUNCTION reject_commercial_acquisition_context_unsafe_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR (TG_OP = 'DELETE' AND OLD."expiresAt" > (pg_catalog.now() AT TIME ZONE 'UTC') - interval '20 minutes') THEN
    RAISE EXCEPTION 'CommercialAcquisitionContext is immutable until expiry'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER "commercial_acquisition_context_immutable" ON "CommercialAcquisitionContext";

CREATE TRIGGER commercial_acquisition_context_immutable
BEFORE UPDATE OR DELETE ON "CommercialAcquisitionContext"
FOR EACH ROW EXECUTE FUNCTION reject_commercial_acquisition_context_unsafe_mutation();
