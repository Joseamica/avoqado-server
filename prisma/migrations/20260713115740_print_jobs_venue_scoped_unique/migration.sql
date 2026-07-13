-- Tenant-scope the PrintJob dedupe key so a sync can never match/mutate another venue's job
-- (review fix: cross-venue eventId collision on the update path). Table is new/empty → safe.
DROP INDEX "PrintJob_eventId_reason_seq_key";
CREATE UNIQUE INDEX "PrintJob_venueId_eventId_reason_seq_key" ON "PrintJob"("venueId", "eventId", "reason", "seq");
