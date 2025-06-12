-- AlterTable
ALTER TABLE "Table" ADD COLUMN     "areaId" TEXT;

-- CreateTable
CREATE TABLE "RestaurantArea" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "externalId" TEXT,
    "originSystem" "OriginSystem" NOT NULL DEFAULT 'AVOQADO',
    "posRawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantArea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantArea_externalId_key" ON "RestaurantArea"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantArea_venueId_externalId_key" ON "RestaurantArea"("venueId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantArea_venueId_name_key" ON "RestaurantArea"("venueId", "name");

-- AddForeignKey
ALTER TABLE "RestaurantArea" ADD CONSTRAINT "RestaurantArea_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Table" ADD CONSTRAINT "Table_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "RestaurantArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;
