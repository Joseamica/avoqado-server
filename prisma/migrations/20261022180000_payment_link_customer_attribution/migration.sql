ALTER TABLE "PaymentLink" ADD COLUMN "customerId" TEXT,
ADD COLUMN "creationKey" VARCHAR(128), ADD COLUMN "creationHash" TEXT;
ALTER TABLE "CheckoutSession" ADD COLUMN "attributedCustomerId" TEXT;
CREATE INDEX "PaymentLink_venueId_customerId_createdAt_id_idx" ON "PaymentLink"("venueId", "customerId", "createdAt", "id");
CREATE UNIQUE INDEX "PaymentLink_venueId_createdById_creationKey_key" ON "PaymentLink"("venueId", "createdById", "creationKey");
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
