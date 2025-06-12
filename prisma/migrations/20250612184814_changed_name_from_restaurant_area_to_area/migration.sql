/*
  Warnings:

  - You are about to drop the `RestaurantArea` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "RestaurantArea" DROP CONSTRAINT "RestaurantArea_venueId_fkey";

-- DropForeignKey
ALTER TABLE "Table" DROP CONSTRAINT "Table_areaId_fkey";

-- DropTable
DROP TABLE "RestaurantArea";

-- CreateTable
CREATE TABLE "Area" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "externalId" TEXT,
    "originSystem" "OriginSystem" NOT NULL DEFAULT 'AVOQADO',
    "posRawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Area_externalId_key" ON "Area"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Area_venueId_externalId_key" ON "Area"("venueId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Area_venueId_name_key" ON "Area"("venueId", "name");

-- AddForeignKey
ALTER TABLE "Area" ADD CONSTRAINT "Area_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE SET NULL ON UPDATE CASCADE;
