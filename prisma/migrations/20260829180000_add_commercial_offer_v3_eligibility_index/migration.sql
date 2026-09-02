CREATE INDEX "CommercialCampaignVersion_offer_v3_eligibility_idx"
ON "CommercialCampaignVersion" ((snapshot->>'claimEndsAt'), id)
WHERE "schemaVersion" = 3 AND snapshot->>'status' = 'ACTIVE';
