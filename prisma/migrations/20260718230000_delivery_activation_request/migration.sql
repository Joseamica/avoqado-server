-- CreateEnum
CREATE TYPE "DeliveryActivationStatus" AS ENUM ('PENDING', 'CONTACTED', 'CONNECTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "DeliveryActivationRequest" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "requestedById" TEXT,
    "status" "DeliveryActivationStatus" NOT NULL DEFAULT 'PENDING',
    "requestedChannels" TEXT[],
    "note" TEXT,
    "contactedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryActivationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryActivationRequest_venueId_idx" ON "DeliveryActivationRequest"("venueId");

-- CreateIndex
CREATE INDEX "DeliveryActivationRequest_status_idx" ON "DeliveryActivationRequest"("status");

-- AddForeignKey
ALTER TABLE "DeliveryActivationRequest" ADD CONSTRAINT "DeliveryActivationRequest_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryActivationRequest" ADD CONSTRAINT "DeliveryActivationRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
