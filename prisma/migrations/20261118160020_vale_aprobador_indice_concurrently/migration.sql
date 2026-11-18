-- D4 (Codex r2 #3): sin índice, borrar para siempre una membresía (StaffVenue) recorre toda "AreaTicketLine" para dejar en NULL a quien
-- aprobó. CONCURRENTLY porque los vales se escriben en cada emisión; las filas viejas tienen NULL.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AreaTicketLine_discountAuthorizedById_idx" ON "AreaTicketLine"("discountAuthorizedById");
