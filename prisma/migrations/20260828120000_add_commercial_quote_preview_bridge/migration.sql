CREATE TABLE "CommercialQuotePreviewBridge" (
  "id" TEXT NOT NULL,
  "previewQuoteId" VARCHAR(128) NOT NULL,
  "previewChecksum" CHAR(64) NOT NULL,
  "acquisitionContextId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "venueId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "selectionFingerprint" CHAR(64) NOT NULL,
  "venueQuoteId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommercialQuotePreviewBridge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialQuotePreviewBridge_previewQuoteId_key" UNIQUE ("previewQuoteId"),
  CONSTRAINT "CommercialQuotePreviewBridge_venueQuoteId_key" UNIQUE ("venueQuoteId"),
  CONSTRAINT "CommercialQuotePreviewBridge_previewQuoteId_check"
    CHECK (char_length("previewQuoteId") BETWEEN 1 AND 128),
  CONSTRAINT "CommercialQuotePreviewBridge_hashes_check"
    CHECK (
      "previewChecksum" ~ '^[0-9a-f]{64}$'
      AND "selectionFingerprint" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "CommercialQuotePreviewBridge_acquisitionContextId_fkey"
    FOREIGN KEY ("acquisitionContextId") REFERENCES "CommercialAcquisitionContext"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialQuotePreviewBridge_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialQuotePreviewBridge_venueId_fkey"
    FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialQuotePreviewBridge_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CommercialQuotePreviewBridge_venueQuoteId_fkey"
    FOREIGN KEY ("venueQuoteId") REFERENCES "CommercialQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "CommercialQuotePreviewBridge_organizationId_venueId_created_idx"
  ON "CommercialQuotePreviewBridge"("organizationId", "venueId", "createdAt");
CREATE INDEX "CommercialQuotePreviewBridge_actorId_createdAt_idx"
  ON "CommercialQuotePreviewBridge"("actorId", "createdAt");
CREATE INDEX "CommercialQuotePreviewBridge_acquisitionContextId_createdAt_idx"
  ON "CommercialQuotePreviewBridge"("acquisitionContextId", "createdAt");
