-- CreateTable
CREATE TABLE "public"."VenueWhatsappActivation" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenLast4" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedByPhone" TEXT,
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "VenueWhatsappActivation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VenueWhatsappActivation_tokenHash_key" ON "public"."VenueWhatsappActivation"("tokenHash");

-- CreateIndex
CREATE INDEX "VenueWhatsappActivation_venueId_expiresAt_idx" ON "public"."VenueWhatsappActivation"("venueId", "expiresAt");

-- AddForeignKey
ALTER TABLE "public"."VenueWhatsappActivation" ADD CONSTRAINT "VenueWhatsappActivation_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
