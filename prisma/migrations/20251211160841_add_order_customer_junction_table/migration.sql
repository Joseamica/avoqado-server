-- CreateTable
CREATE TABLE "OrderCustomer" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderCustomer_orderId_idx" ON "OrderCustomer"("orderId");

-- CreateIndex
CREATE INDEX "OrderCustomer_customerId_idx" ON "OrderCustomer"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCustomer_orderId_customerId_key" ON "OrderCustomer"("orderId", "customerId");

-- AddForeignKey
ALTER TABLE "OrderCustomer" ADD CONSTRAINT "OrderCustomer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCustomer" ADD CONSTRAINT "OrderCustomer_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
