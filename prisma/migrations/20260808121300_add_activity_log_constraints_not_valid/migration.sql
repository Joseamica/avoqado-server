-- Existing unclassified audit rows remain legal. Classified HUMAN/SERVICE
-- writes opt into durable, mutually-exclusive actor identities.
-- organizationId is likewise durable provenance: any populated attribution
-- blocks an Organization hard-delete instead of laundering history to null.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "ActivityLog"
  ADD CONSTRAINT "ActivityLog_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "ActivityLog_actorStaffId_fkey"
    FOREIGN KEY ("actorStaffId") REFERENCES "Staff"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "ActivityLog_actor_identity_check" CHECK ((
    ("actorType" IS NULL AND "actorStaffId" IS NULL AND "servicePrincipalId" IS NULL)
    OR (
      "actorType" = 'HUMAN'
      AND "organizationId" IS NOT NULL
      AND "staffId" IS NOT NULL
      AND "actorStaffId" IS NOT NULL
      AND "actorStaffId" = "staffId"
      AND "servicePrincipalId" IS NULL
    )
    OR (
      "actorType" = 'SERVICE'
      AND "organizationId" IS NOT NULL
      AND "staffId" IS NULL
      AND "actorStaffId" IS NULL
      AND ("servicePrincipalId" ~ '[^[:space:]]') IS TRUE
    )
  ) IS TRUE) NOT VALID;
COMMIT;
