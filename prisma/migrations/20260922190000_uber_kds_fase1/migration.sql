-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "customerPhonePin" TEXT,
ADD COLUMN     "deliveryChannelLinkId" TEXT,
ADD COLUMN     "deliveryOpInFlight" TEXT,
ADD COLUMN     "deliveryOpInFlightAt" TIMESTAMP(3),
ADD COLUMN     "deliveryOpToken" TEXT,
ADD COLUMN     "deliveryReconcileBlocked" TEXT,
ADD COLUMN     "providerAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "providerAcceptedEvidence" TEXT,
ADD COLUMN     "readyReportedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "externalLineId" TEXT,
ADD COLUMN     "removedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DeliveryChannelLink" ADD COLUMN     "activatingIntentId" TEXT,
ADD COLUMN     "activationOwner" TEXT,
ADD COLUMN     "ownerAuthorizedAt" TIMESTAMP(3),
ADD COLUMN     "ownerAuthorizedByIntentId" TEXT,
ADD COLUMN     "ownerAuthorizedClientId" TEXT,
ADD COLUMN     "ownerAuthorizedEnvironment" TEXT,
ADD COLUMN     "ownerAuthorizedStoreId" TEXT,
ADD COLUMN     "revocationVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "KdsOrder" ADD COLUMN     "customerContact" TEXT,
ADD COLUMN     "customerName" TEXT;

-- AlterTable
ALTER TABLE "KdsOrderItem" ADD COLUMN     "externalLineId" TEXT,
ADD COLUMN     "orderItemId" TEXT,
ADD COLUMN     "removedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeliveryLineAction" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "provider" "DeliveryProvider" NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "settlement" TEXT NOT NULL DEFAULT 'PENDING',
    "origin" TEXT NOT NULL,
    "requestedByStaffId" TEXT,
    "retriedByStaffId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerStatus" INTEGER,
    "providerBody" TEXT,
    "refundPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DeliveryLineAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryConnectIntent" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "provider" "DeliveryProvider" NOT NULL,
    "environment" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "orderAcceptanceMode" "OrderAcceptanceMode" NOT NULL DEFAULT 'AUTO',
    "state" TEXT NOT NULL DEFAULT 'CREATED',
    "activationAttempt" INTEGER NOT NULL DEFAULT 0,
    "activationOwner" TEXT,
    "activationLeaseUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "storesJson" JSONB,
    "selectionJson" JSONB,
    "resultsJson" JSONB,
    "merchantTokenEnvelope" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryConnectIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryLineAction_venueId_status_idx" ON "DeliveryLineAction"("venueId", "status");

-- CreateIndex
CREATE INDEX "DeliveryLineAction_status_settlement_idx" ON "DeliveryLineAction"("status", "settlement");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryLineAction_orderId_lineId_action_key" ON "DeliveryLineAction"("orderId", "lineId", "action");

-- CreateIndex
CREATE INDEX "DeliveryConnectIntent_state_expiresAt_idx" ON "DeliveryConnectIntent"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "DeliveryConnectIntent_venueId_idx" ON "DeliveryConnectIntent"("venueId");

