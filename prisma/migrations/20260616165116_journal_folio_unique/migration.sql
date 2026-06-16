-- Folio ÚNICO por contribuyente (integridad fiscal): bloquea consecutivos duplicados a nivel DB.
CREATE UNIQUE INDEX "JournalEntry_organizationId_rfc_folio_key" ON "JournalEntry"("organizationId", "rfc", "folio");
