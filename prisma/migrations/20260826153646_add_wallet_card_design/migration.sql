-- CreateEnum
CREATE TYPE "WalletStampShape" AS ENUM ('CIRCLE', 'STAR', 'HEART', 'SQUARE');

-- CreateTable
CREATE TABLE "WalletCardDesign" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "logoUrl" TEXT,
    "iconUrl" TEXT,
    "backgroundColor" TEXT NOT NULL DEFAULT '#1C1C1E',
    "textColor" TEXT NOT NULL DEFAULT '#FFFFFF',
    "labelColor" TEXT NOT NULL DEFAULT '#98989D',
    "stripColor" TEXT NOT NULL DEFAULT '#2C2C2E',
    "stampFilledColor" TEXT NOT NULL DEFAULT '#7ADD2C',
    "stampEmptyColor" TEXT,
    "stampShape" "WalletStampShape" NOT NULL DEFAULT 'CIRCLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletCardDesign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletCardDesign_venueId_key" ON "WalletCardDesign"("venueId");

-- AddForeignKey
ALTER TABLE "WalletCardDesign" ADD CONSTRAINT "WalletCardDesign_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
