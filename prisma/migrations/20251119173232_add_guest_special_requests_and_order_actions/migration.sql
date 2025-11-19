-- CreateEnum
CREATE TYPE "public"."ActionType" AS ENUM ('COMP', 'VOID', 'DISCOUNT', 'SPLIT', 'MERGE', 'TRANSFER');

-- AlterTable
ALTER TABLE "public"."Order" ADD COLUMN     "specialRequests" TEXT;

-- CreateTable
CREATE TABLE "public"."OrderAction" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "actionType" "public"."ActionType" NOT NULL,
    "performedById" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderAction_orderId_idx" ON "public"."OrderAction"("orderId");

-- CreateIndex
CREATE INDEX "OrderAction_actionType_idx" ON "public"."OrderAction"("actionType");

-- CreateIndex
CREATE INDEX "OrderAction_createdAt_idx" ON "public"."OrderAction"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."OrderAction" ADD CONSTRAINT "OrderAction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrderAction" ADD CONSTRAINT "OrderAction_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "public"."Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
