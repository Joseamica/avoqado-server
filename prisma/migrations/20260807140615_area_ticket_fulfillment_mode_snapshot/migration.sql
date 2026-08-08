-- Freeze the fulfillment decision per ticket. The area setting remains editable,
-- but changing it must only affect tickets issued afterwards.
--
-- Prisma does not wrap migrations in a transaction automatically. Keep the ALTER,
-- legacy backfill, compatibility trigger and NOT NULL constraint in one explicit
-- transaction so the ACCESS EXCLUSIVE lock acquired by ALTER TABLE is held until
-- the trigger is ready. Older application pods can then keep inserting safely
-- during a rolling deployment.

BEGIN;

ALTER TABLE "AreaTicket"
ADD COLUMN "fulfillmentModeSnapshot" "FulfillmentMode";

UPDATE "AreaTicket" AS ticket
SET "fulfillmentModeSnapshot" = CASE
  -- Before snapshots existed every paid ticket followed the manual-delivery
  -- workflow, independently of the area's configured mode. Preserve that
  -- observable behavior: inferring IMMEDIATE from today's area setting could
  -- hide retained products or mark an unverified handoff as delivered.
  WHEN ticket."status" = 'PAID' THEN 'HOLD_UNTIL_PAID'::"FulfillmentMode"
  ELSE area."fulfillmentMode"
END
FROM "FulfillmentArea" AS area
WHERE area."id" = ticket."fulfillmentAreaId"
  AND ticket."fulfillmentModeSnapshot" IS NULL;

CREATE FUNCTION "setAreaTicketFulfillmentModeSnapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."fulfillmentModeSnapshot" IS NULL THEN
    SELECT area."fulfillmentMode"
    INTO NEW."fulfillmentModeSnapshot"
    FROM "FulfillmentArea" AS area
    WHERE area."id" = NEW."fulfillmentAreaId";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "AreaTicket_fulfillmentModeSnapshot_insert"
BEFORE INSERT ON "AreaTicket"
FOR EACH ROW
EXECUTE FUNCTION "setAreaTicketFulfillmentModeSnapshot"();

ALTER TABLE "AreaTicket"
ALTER COLUMN "fulfillmentModeSnapshot" SET NOT NULL;

COMMIT;
