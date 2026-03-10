-- CreateEnum
CREATE TYPE "public"."CreditPurchaseStatus" AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "public"."CreditTransactionType" AS ENUM ('PURCHASE', 'REDEEM', 'EXPIRE', 'REFUND', 'ADJUST');

-- CreateTable
CREATE TABLE "public"."CreditPack" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "validityDays" INTEGER,
    "maxPerCustomer" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "stripeProductId" TEXT,
    "stripePriceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CreditPackItem" (
    "id" TEXT NOT NULL,
    "creditPackId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "CreditPackItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CreditPackPurchase" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "creditPackId" TEXT NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "status" "public"."CreditPurchaseStatus" NOT NULL DEFAULT 'ACTIVE',
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "amountPaid" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPackPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CreditItemBalance" (
    "id" TEXT NOT NULL,
    "creditPackPurchaseId" TEXT NOT NULL,
    "creditPackItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "originalQuantity" INTEGER NOT NULL,
    "remainingQuantity" INTEGER NOT NULL,

    CONSTRAINT "CreditItemBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CreditTransaction" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "creditPackPurchaseId" TEXT NOT NULL,
    "creditItemBalanceId" TEXT NOT NULL,
    "type" "public"."CreditTransactionType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reservationId" TEXT,
    "orderId" TEXT,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditPack_venueId_active_idx" ON "public"."CreditPack"("venueId", "active");

-- CreateIndex
CREATE INDEX "CreditPackItem_creditPackId_idx" ON "public"."CreditPackItem"("creditPackId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPackItem_creditPackId_productId_key" ON "public"."CreditPackItem"("creditPackId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditPackPurchase_stripeCheckoutSessionId_key" ON "public"."CreditPackPurchase"("stripeCheckoutSessionId");

-- CreateIndex
CREATE INDEX "CreditPackPurchase_venueId_customerId_status_idx" ON "public"."CreditPackPurchase"("venueId", "customerId", "status");

-- CreateIndex
CREATE INDEX "CreditPackPurchase_customerId_idx" ON "public"."CreditPackPurchase"("customerId");

-- CreateIndex
CREATE INDEX "CreditPackPurchase_expiresAt_idx" ON "public"."CreditPackPurchase"("expiresAt");

-- CreateIndex
CREATE INDEX "CreditItemBalance_creditPackPurchaseId_idx" ON "public"."CreditItemBalance"("creditPackPurchaseId");

-- CreateIndex
CREATE INDEX "CreditItemBalance_productId_idx" ON "public"."CreditItemBalance"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditItemBalance_creditPackPurchaseId_creditPackItemId_key" ON "public"."CreditItemBalance"("creditPackPurchaseId", "creditPackItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTransaction_reservationId_key" ON "public"."CreditTransaction"("reservationId");

-- CreateIndex
CREATE INDEX "CreditTransaction_creditItemBalanceId_createdAt_idx" ON "public"."CreditTransaction"("creditItemBalanceId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditTransaction_customerId_createdAt_idx" ON "public"."CreditTransaction"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditTransaction_reservationId_idx" ON "public"."CreditTransaction"("reservationId");

-- CreateIndex
CREATE INDEX "CreditTransaction_orderId_idx" ON "public"."CreditTransaction"("orderId");

-- AddForeignKey
ALTER TABLE "public"."CreditPack" ADD CONSTRAINT "CreditPack_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditPackItem" ADD CONSTRAINT "CreditPackItem_creditPackId_fkey" FOREIGN KEY ("creditPackId") REFERENCES "public"."CreditPack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditPackItem" ADD CONSTRAINT "CreditPackItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditPackPurchase" ADD CONSTRAINT "CreditPackPurchase_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditPackPurchase" ADD CONSTRAINT "CreditPackPurchase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditPackPurchase" ADD CONSTRAINT "CreditPackPurchase_creditPackId_fkey" FOREIGN KEY ("creditPackId") REFERENCES "public"."CreditPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditItemBalance" ADD CONSTRAINT "CreditItemBalance_creditPackPurchaseId_fkey" FOREIGN KEY ("creditPackPurchaseId") REFERENCES "public"."CreditPackPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditItemBalance" ADD CONSTRAINT "CreditItemBalance_creditPackItemId_fkey" FOREIGN KEY ("creditPackItemId") REFERENCES "public"."CreditPackItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditItemBalance" ADD CONSTRAINT "CreditItemBalance_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditTransaction" ADD CONSTRAINT "CreditTransaction_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditTransaction" ADD CONSTRAINT "CreditTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditTransaction" ADD CONSTRAINT "CreditTransaction_creditPackPurchaseId_fkey" FOREIGN KEY ("creditPackPurchaseId") REFERENCES "public"."CreditPackPurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditTransaction" ADD CONSTRAINT "CreditTransaction_creditItemBalanceId_fkey" FOREIGN KEY ("creditItemBalanceId") REFERENCES "public"."CreditItemBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditTransaction" ADD CONSTRAINT "CreditTransaction_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditTransaction" ADD CONSTRAINT "CreditTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditTransaction" ADD CONSTRAINT "CreditTransaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."StaffVenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
