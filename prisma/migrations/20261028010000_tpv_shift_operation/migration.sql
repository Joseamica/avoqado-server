CREATE TYPE "TpvShiftOperationKind" AS ENUM ('OPEN', 'CLOSE');
CREATE TYPE "TpvShiftOperationState" AS ENUM ('PENDING', 'APPLIED', 'CONFLICT');

CREATE TABLE "TpvShiftOperation" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "kind" "TpvShiftOperationKind" NOT NULL,
    "terminalSerial" TEXT NOT NULL,
    "actorStaffId" TEXT NOT NULL,
    "requestJson" JSONB NOT NULL,
    "requestHash" TEXT NOT NULL,
    "shiftId" TEXT,
    "cashDrawerSessionId" TEXT,
    "state" "TpvShiftOperationState" NOT NULL DEFAULT 'PENDING',
    "resultJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TpvShiftOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TpvShiftOperation_venueId_shiftId_kind_idx" ON "TpvShiftOperation"("venueId", "shiftId", "kind");
