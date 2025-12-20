-- CreateEnum
CREATE TYPE "DepositMethod" AS ENUM ('BANK_DEPOSIT', 'SAFE', 'OWNER_WITHDRAWAL', 'NEXT_SHIFT');

-- CreateTable
CREATE TABLE "CashCloseout" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedAmount" DECIMAL(12,2) NOT NULL,
    "actualAmount" DECIMAL(12,2) NOT NULL,
    "variance" DECIMAL(12,2) NOT NULL,
    "variancePercent" DECIMAL(5,2),
    "depositMethod" "DepositMethod" NOT NULL DEFAULT 'BANK_DEPOSIT',
    "bankReference" TEXT,
    "notes" TEXT,
    "closedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashCloseout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashCloseout_venueId_idx" ON "CashCloseout"("venueId");

-- CreateIndex
CREATE INDEX "CashCloseout_venueId_createdAt_idx" ON "CashCloseout"("venueId", "createdAt");

-- AddForeignKey
ALTER TABLE "CashCloseout" ADD CONSTRAINT "CashCloseout_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCloseout" ADD CONSTRAINT "CashCloseout_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
