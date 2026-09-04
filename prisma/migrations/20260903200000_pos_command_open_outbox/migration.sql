-- Durable POS command identity without rewriting legacy rows. PostgreSQL unique
-- indexes allow multiple NULLs, so historical commands keep their current shape.
ALTER TABLE "PosCommand"
ADD COLUMN "action" TEXT,
ADD COLUMN "dedupeKey" TEXT,
ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "PosCommand_dedupeKey_key" ON "PosCommand"("dedupeKey");
CREATE INDEX "PosCommand_stale_open_idx"
ON "PosCommand"("status", "entityType", "action", "lastAttemptAt", "id");
CREATE INDEX "PosCommand_due_open_idx"
ON "PosCommand"("status", "entityType", "action", "createdAt", "id", "nextAttemptAt");
