-- CreateEnum
CREATE TYPE "WalletPlatform" AS ENUM ('APPLE', 'GOOGLE');

-- CreateTable
CREATE TABLE "WalletPass" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "platform" "WalletPlatform" NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "authToken" TEXT NOT NULL,
    "qrToken" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletPass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletPass_serialNumber_key" ON "WalletPass"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WalletPass_qrToken_key" ON "WalletPass"("qrToken");

-- CreateIndex
CREATE INDEX "WalletPass_venueId_updatedAt_idx" ON "WalletPass"("venueId", "updatedAt");

-- CreateIndex
CREATE INDEX "WalletPass_customerId_idx" ON "WalletPass"("customerId");

-- AddForeignKey
ALTER TABLE "WalletPass" ADD CONSTRAINT "WalletPass_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletPass" ADD CONSTRAINT "WalletPass_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
