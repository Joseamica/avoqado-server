-- CreateEnum
CREATE TYPE "public"."FloorElementType" AS ENUM ('WALL', 'BAR_COUNTER', 'SERVICE_AREA', 'LABEL', 'DOOR');

-- CreateTable
CREATE TABLE "public"."FloorElement" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "areaId" TEXT,
    "type" "public"."FloorElementType" NOT NULL,
    "positionX" DOUBLE PRECISION NOT NULL,
    "positionY" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "endX" DOUBLE PRECISION,
    "endY" DOUBLE PRECISION,
    "label" TEXT,
    "color" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloorElement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FloorElement_venueId_idx" ON "public"."FloorElement"("venueId");

-- CreateIndex
CREATE INDEX "FloorElement_venueId_areaId_idx" ON "public"."FloorElement"("venueId", "areaId");

-- CreateIndex
CREATE INDEX "FloorElement_venueId_type_idx" ON "public"."FloorElement"("venueId", "type");

-- AddForeignKey
ALTER TABLE "public"."FloorElement" ADD CONSTRAINT "FloorElement_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FloorElement" ADD CONSTRAINT "FloorElement_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "public"."Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;
