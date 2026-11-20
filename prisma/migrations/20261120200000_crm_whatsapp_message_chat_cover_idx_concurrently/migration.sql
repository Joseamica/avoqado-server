-- CRM · WhatsApp de ventas, leer chats (Avoqado/docs/audit/2026-11-20-crm-whatsapp-leer/promesa.md, «Capacidad»).
-- The chat list groups every message by phone, filtered by `receivedAt` (the «foto» of a walk). With this covering index the
-- grouping is an index-only scan: measured on a copy with 1,000,000 messages / 20,000 chats, 94–178 ms instead of 1–7 s.
-- 🔴 MAINTAINED BY HAND: Prisma's @@index has no INCLUDE, so this index lives only here (see the comment in schema.prisma).
-- CONCURRENTLY, one statement per file: the webhook writes this table on every sales message, and a plain CREATE INDEX would
-- block those writes. If it is interrupted the index is left INVALID and IF NOT EXISTS would skip it on the retry: check
-- pg_index.indisvalid, DROP INDEX CONCURRENTLY "CrmWhatsappMessage_chat_cover_idx" if it is false, mark the migration rolled
-- back (prisma migrate resolve --rolled-back) and deploy again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CrmWhatsappMessage_chat_cover_idx" ON "CrmWhatsappMessage"("contactPhone", "sentAt") INCLUDE ("receivedAt");
