-- The B stores an answer with data as purpose DATA (20261116130000_support_data adds the value). The purpose check of
-- 20261116033000_support_whatsapp only admits HELP and LINK_CODE, so without this a DATA row cannot be saved at all.
-- A DATA message answers an inbound question like HELP, but never keeps its answer in clear: the text lives only in
-- answerCipher while it waits to be sent. Its own migration because Postgres does not let a statement use 'DATA' in the
-- same transaction that added it. SupportMessage is new (phase 1, not in production yet): the re-check scans a small table.
ALTER TABLE "SupportMessage" DROP CONSTRAINT "SupportMessage_purpose_check";

ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_purpose_check" CHECK (
  (purpose = 'HELP' AND "challengeId" IS NULL AND ("inboundEventId" IS NOT NULL OR status = 'EXPIRED')) OR
  (purpose = 'LINK_CODE' AND body = '' AND answer IS NULL AND ("challengeId" IS NOT NULL OR status = 'EXPIRED')
    AND (status NOT IN ('QUEUED', 'CLAIMED', 'ANSWER_READY') OR "answerCipher" IS NOT NULL)) OR
  (purpose = 'DATA' AND "challengeId" IS NULL AND answer IS NULL AND ("inboundEventId" IS NOT NULL OR status = 'EXPIRED')
    AND (status NOT IN ('QUEUED', 'CLAIMED', 'ANSWER_READY') OR "answerCipher" IS NOT NULL))
);
