-- CreateEnum
CREATE TYPE "public"."KdsOrderStatus" AS ENUM ('NEW', 'PREPARING', 'READY', 'COMPLETED');

-- CreateTable
CREATE TABLE "public"."KdsOrder" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "orderId" TEXT,
    "orderNumber" TEXT NOT NULL,
    "orderType" TEXT NOT NULL DEFAULT 'DINE_IN',
    "status" "public"."KdsOrderStatus" NOT NULL DEFAULT 'NEW',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KdsOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."KdsOrderItem" (
    "id" TEXT NOT NULL,
    "kdsOrderId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "modifiers" TEXT,
    "notes" TEXT,

    CONSTRAINT "KdsOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KdsOrder_venueId_status_idx" ON "public"."KdsOrder"("venueId", "status");

-- CreateIndex
CREATE INDEX "KdsOrderItem_kdsOrderId_idx" ON "public"."KdsOrderItem"("kdsOrderId");

-- AddForeignKey
ALTER TABLE "public"."KdsOrder" ADD CONSTRAINT "KdsOrder_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."KdsOrderItem" ADD CONSTRAINT "KdsOrderItem_kdsOrderId_fkey" FOREIGN KEY ("kdsOrderId") REFERENCES "public"."KdsOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
