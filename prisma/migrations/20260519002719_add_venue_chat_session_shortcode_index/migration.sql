-- Partial unique index: at most one OPEN session per (venueId, shortCode).
-- Allows shortCode reuse once a previous session has closed. Prisma schema
-- cannot express partial unique indexes, so this lives in raw SQL.
CREATE UNIQUE INDEX "venue_chat_session_shortcode_open_unique"
  ON "VenueChatSession" ("venueId", "shortCode")
  WHERE status = 'OPEN';
