-- CreateEnum
CREATE TYPE "public"."StockCountType" AS ENUM ('CYCLE', 'FULL');

-- CreateEnum
CREATE TYPE "public"."StockCountStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "public"."StockCount" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "type" "public"."StockCountType" NOT NULL,
    "status" "public"."StockCountStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StockCountItem" (
    "id" TEXT NOT NULL,
    "stockCountId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "expected" DECIMAL(10,2) NOT NULL,
    "counted" DECIMAL(10,2) NOT NULL DEFAULT 0,

    CONSTRAINT "StockCountItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockCount_venueId_idx" ON "public"."StockCount"("venueId");

-- CreateIndex
CREATE INDEX "StockCount_status_idx" ON "public"."StockCount"("status");

-- CreateIndex
CREATE INDEX "StockCount_createdAt_idx" ON "public"."StockCount"("createdAt");

-- CreateIndex
CREATE INDEX "StockCountItem_stockCountId_idx" ON "public"."StockCountItem"("stockCountId");

-- CreateIndex
CREATE INDEX "StockCountItem_productId_idx" ON "public"."StockCountItem"("productId");

-- AddForeignKey
ALTER TABLE "public"."StockCount" ADD CONSTRAINT "StockCount_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StockCount" ADD CONSTRAINT "StockCount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StockCountItem" ADD CONSTRAINT "StockCountItem_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "public"."StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StockCountItem" ADD CONSTRAINT "StockCountItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
