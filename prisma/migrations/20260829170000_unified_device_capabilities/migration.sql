ALTER TABLE "Terminal"
  ADD COLUMN "customerDisplayPresent" BOOLEAN,
  ADD COLUMN "customerDisplayInvertible" BOOLEAN,
  ADD COLUMN "displayModeProtocolVersion" INTEGER,
  ADD COLUMN "capabilitiesObservedAt" TIMESTAMP(3),
  ADD COLUMN "customerDisplayRequest" JSONB,
  ADD COLUMN "customerDisplayRequestVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "customerDisplayRequestExpiresAt" TIMESTAMP(3);

CREATE INDEX "Terminal_customerDisplayRequestExpiresAt_idx"
  ON "Terminal"("customerDisplayRequestExpiresAt");
