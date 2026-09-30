CREATE TABLE "HybridContractSelection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "contractId" TEXT NOT NULL REFERENCES "HybridContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "featureCodes" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HybridContractSelection_nonempty" CHECK (cardinality("featureCodes") > 0)
);
CREATE UNIQUE INDEX "HybridContractSelection_contractId_effectiveAt_key" ON "HybridContractSelection"("contractId", "effectiveAt");
CREATE FUNCTION hybrid_selection_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Hybrid paid selection is immutable';
END $$;
CREATE TRIGGER hybrid_selection_immutable BEFORE UPDATE OR DELETE ON "HybridContractSelection" FOR EACH ROW EXECUTE FUNCTION hybrid_selection_immutable();
