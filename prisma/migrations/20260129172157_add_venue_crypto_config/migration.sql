-- CreateEnum
CREATE TYPE "public"."CryptoConfigStatus" AS ENUM ('PENDING_SETUP', 'ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "public"."VenueCryptoConfig" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "b4bitDeviceId" TEXT NOT NULL,
    "b4bitDeviceName" TEXT NOT NULL,
    "b4bitSecretKey" TEXT,
    "status" "public"."CryptoConfigStatus" NOT NULL DEFAULT 'PENDING_SETUP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueCryptoConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VenueCryptoConfig_venueId_key" ON "public"."VenueCryptoConfig"("venueId");

-- CreateIndex
CREATE INDEX "VenueCryptoConfig_venueId_idx" ON "public"."VenueCryptoConfig"("venueId");

-- AddForeignKey
ALTER TABLE "public"."VenueCryptoConfig" ADD CONSTRAINT "VenueCryptoConfig_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
