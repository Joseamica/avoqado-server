-- AlterTable
ALTER TABLE "Venue" ADD COLUMN "stripeCustomerId" TEXT,
ADD COLUMN "stripePaymentMethodId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Venue_stripeCustomerId_key" ON "Venue"("stripeCustomerId");
