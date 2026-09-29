CREATE TABLE "HybridCampaign" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "draftDefinition" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" "LaunchCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "capacity" INTEGER NOT NULL,
  "reservedCount" INTEGER NOT NULL DEFAULT 0,
  "redeemedCount" INTEGER NOT NULL DEFAULT 0,
  "audience" TEXT NOT NULL,
  "eligibleOrganizationIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "listed" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HybridCampaign_window_check" CHECK ("endsAt" > "startsAt"),
  CONSTRAINT "HybridCampaign_capacity_check" CHECK ("capacity" BETWEEN 1 AND 100000 AND "reservedCount" >= 0 AND "redeemedCount" >= 0 AND "reservedCount" + "redeemedCount" <= "capacity"),
  CONSTRAINT "HybridCampaign_audience_check" CHECK ("audience" IN ('ALL', 'NEW_ORGANIZATIONS', 'ORGANIZATIONS') AND ("audience" <> 'ORGANIZATIONS' OR cardinality("eligibleOrganizationIds") > 0)),
  CONSTRAINT "HybridCampaign_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "HybridCampaign_code_key" ON "HybridCampaign"("code");
CREATE UNIQUE INDEX "HybridCampaign_slug_key" ON "HybridCampaign"("slug");
CREATE INDEX "HybridCampaign_status_listed_startsAt_endsAt_idx" ON "HybridCampaign"("status", "listed", "startsAt", "endsAt");

CREATE TABLE "HybridOfferPublication" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "campaignId" TEXT NOT NULL REFERENCES "HybridCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "name" TEXT NOT NULL,
  "definition" JSONB NOT NULL,
  "definitionHash" TEXT NOT NULL CHECK ("definitionHash" ~ '^[a-f0-9]{64}$'),
  "includedFeatureCodes" TEXT[] NOT NULL,
  "stripeProductId" TEXT,
  "stripePriceId" TEXT,
  "stripeRenewalPriceId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "HybridOfferPublication_campaignId_version_key" ON "HybridOfferPublication"("campaignId", "version");
CREATE UNIQUE INDEX "HybridOfferPublication_stripeProductId_key" ON "HybridOfferPublication"("stripeProductId");
CREATE UNIQUE INDEX "HybridOfferPublication_stripePriceId_key" ON "HybridOfferPublication"("stripePriceId");
CREATE UNIQUE INDEX "HybridOfferPublication_stripeRenewalPriceId_key" ON "HybridOfferPublication"("stripeRenewalPriceId");

-- Terms cannot change underneath a quote, even through a different writer or manual SQL.
CREATE FUNCTION "protectHybridOfferPublication"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Published hybrid offers cannot be deleted';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['stripeProductId', 'stripePriceId', 'stripeRenewalPriceId']) IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['stripeProductId', 'stripePriceId', 'stripeRenewalPriceId']) THEN
    RAISE EXCEPTION 'Published hybrid offer terms are immutable';
  END IF;
  IF (OLD."stripeProductId" IS NOT NULL AND OLD."stripeProductId" IS DISTINCT FROM NEW."stripeProductId") OR
     (OLD."stripePriceId" IS NOT NULL AND OLD."stripePriceId" IS DISTINCT FROM NEW."stripePriceId") OR
     (OLD."stripeRenewalPriceId" IS NOT NULL AND OLD."stripeRenewalPriceId" IS DISTINCT FROM NEW."stripeRenewalPriceId") THEN
    RAISE EXCEPTION 'Published hybrid provider references are immutable once linked';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "HybridOfferPublication_immutable" BEFORE UPDATE OR DELETE ON "HybridOfferPublication"
  FOR EACH ROW EXECUTE FUNCTION "protectHybridOfferPublication"();
