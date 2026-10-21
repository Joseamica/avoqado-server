-- Bounded fleet pages and per-terminal command history. No data changes.
CREATE INDEX "Terminal_type_createdAt_id_idx" ON "Terminal" ("type", "createdAt", "id");
CREATE INDEX "TpvCommandQueue_terminalId_venueId_createdAt_id_idx" ON "TpvCommandQueue" ("terminalId", "venueId", "createdAt", "id");
