-- Liga por prenda con talla: familia en la liga y fichas de apartado.
CREATE TYPE "PaymentLinkStockHoldStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED');

ALTER TABLE "PaymentLink" ADD COLUMN "productGroupId" TEXT;

CREATE TABLE "PaymentLinkStockHold" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "paymentLinkId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "browserToken" VARCHAR(64) NOT NULL,
    "stripePaymentIntentId" TEXT,
    "amountCents" INTEGER,
    "stripeAccountId" TEXT,
    "intentParams" JSONB,
    "checkoutSnapshot" JSONB,
    "status" "PaymentLinkStockHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentLinkStockHold_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentLink_productGroupId_idx" ON "PaymentLink"("productGroupId");
CREATE INDEX "PaymentLinkStockHold_productId_status_expiresAt_idx" ON "PaymentLinkStockHold"("productId", "status", "expiresAt");
CREATE INDEX "PaymentLinkStockHold_browserToken_idx" ON "PaymentLinkStockHold"("browserToken");
CREATE INDEX "PaymentLinkStockHold_stripePaymentIntentId_idx" ON "PaymentLinkStockHold"("stripePaymentIntentId");
CREATE INDEX "PaymentLinkStockHold_status_expiresAt_idx" ON "PaymentLinkStockHold"("status", "expiresAt");

ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_productGroupId_fkey" FOREIGN KEY ("productGroupId") REFERENCES "ProductGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentLinkStockHold" ADD CONSTRAINT "PaymentLinkStockHold_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentLinkStockHold" ADD CONSTRAINT "PaymentLinkStockHold_paymentLinkId_fkey" FOREIGN KEY ("paymentLinkId") REFERENCES "PaymentLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentLinkStockHold" ADD CONSTRAINT "PaymentLinkStockHold_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
