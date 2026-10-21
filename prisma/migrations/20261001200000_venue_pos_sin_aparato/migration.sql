-- IVA por producto (spec planes 6-7, §5.5): actividad del POS sin identidad de aparato, por negocio.
-- CreateTable
CREATE TABLE "VenuePosSinAparato" (
    "venueId" TEXT NOT NULL,
    "ultimaVez" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenuePosSinAparato_pkey" PRIMARY KEY ("venueId")
);

-- AddForeignKey
ALTER TABLE "VenuePosSinAparato" ADD CONSTRAINT "VenuePosSinAparato_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
