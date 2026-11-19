-- WhatsApp support: the retention sweep pages the inbound events by route and age.
-- This is the @@index of WhatsappInboundEvent in schema.prisma, but CONCURRENTLY: the table has existed since May and gets
-- a write for every inbound WhatsApp message, and a plain CREATE INDEX would block those writes while it builds.
-- One statement per file: Prisma sends the file as one batch and PostgreSQL rejects CONCURRENTLY inside the implicit
-- transaction of a multi-statement batch. If it is interrupted (e.g. the 5 s lock_timeout of migrate:deploy:bounded), the
-- index is left INVALID and IF NOT EXISTS would skip it on the retry: check pg_index.indisvalid, DROP INDEX CONCURRENTLY
-- "WhatsappInboundEvent_routedAs_receivedAt_id_idx" if it is false, mark the migration rolled back
-- (prisma migrate resolve --rolled-back) and deploy again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WhatsappInboundEvent_routedAs_receivedAt_id_idx" ON "WhatsappInboundEvent"("routedAs", "receivedAt", "id");
