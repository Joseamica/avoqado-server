-- Plano de mesas en el dashboard (spec 2026-10-08). Aditiva: columnas opcionales y tabla nueva.
CREATE TYPE "FloorShape" AS ENUM ('WIDE', 'SQUARE', 'TALL');

ALTER TABLE "Area" ADD COLUMN "floorShape" "FloorShape",
ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "FloorPlanPublication" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "saveId" TEXT NOT NULL,
    "staffId" TEXT,
    "baseFingerprint" TEXT NOT NULL,
    "resultFingerprint" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FloorPlanPublication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FloorPlanPublication_venueId_saveId_key" ON "FloorPlanPublication"("venueId", "saveId");
CREATE INDEX "FloorPlanPublication_venueId_createdAt_idx" ON "FloorPlanPublication"("venueId", "createdAt");

ALTER TABLE "FloorPlanPublication" ADD CONSTRAINT "FloorPlanPublication_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
