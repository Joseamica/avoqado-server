-- Folio ÚNICO por contribuyente (integridad fiscal): bloquea consecutivos duplicados a nivel DB.
--
-- Reubicación del índice que antes vivía en 20260616165116_journal_folio_unique. Aquí corre
-- DESPUÉS de 20260616223308_add_journal_entry (que crea la tabla "JournalEntry"), por lo que
-- funciona en cualquier base: limpia, producción recuperada, o dev que ya tenía el índice
-- (IF NOT EXISTS lo vuelve idempotente). El nombre coincide con el que Prisma deriva de
-- @@unique([organizationId, rfc, folio]) en schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_organizationId_rfc_folio_key" ON "public"."JournalEntry"("organizationId", "rfc", "folio");
