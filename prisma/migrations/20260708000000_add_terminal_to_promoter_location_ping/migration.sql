-- Device attribution for promoter location pings (feature: Ubicación de TPVs).
-- Nullable + SET NULL so historical pings and unresolved serials are unaffected.
ALTER TABLE "promoter_location_pings" ADD COLUMN "terminalId" TEXT;

CREATE INDEX "promoter_location_pings_terminalId_capturedAt_idx" ON "promoter_location_pings"("terminalId", "capturedAt");

ALTER TABLE "promoter_location_pings" ADD CONSTRAINT "promoter_location_pings_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
