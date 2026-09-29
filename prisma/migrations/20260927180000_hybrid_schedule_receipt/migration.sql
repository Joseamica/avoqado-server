ALTER TABLE "HybridBillingOperation" ADD COLUMN "resultHash" TEXT;
CREATE FUNCTION hybrid_operation_result_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."resultHash" IS NOT NULL AND NEW."resultHash" IS DISTINCT FROM OLD."resultHash" THEN
    RAISE EXCEPTION 'Hybrid provider result is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hybrid_operation_result_immutable BEFORE UPDATE ON "HybridBillingOperation" FOR EACH ROW EXECUTE FUNCTION hybrid_operation_result_immutable();
