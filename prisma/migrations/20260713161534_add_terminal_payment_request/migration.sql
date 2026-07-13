-- CreateEnum
CREATE TYPE "TerminalPaymentRequestStatus" AS ENUM ('PENDING', 'SENT', 'COMPLETED', 'FAILED', 'CANCELLED', 'CANCEL_REQUESTED', 'TIMED_OUT', 'UNKNOWN');

-- CreateTable
CREATE TABLE "TerminalPaymentRequest" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "status" "TerminalPaymentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "amountCents" INTEGER NOT NULL,
    "tipCents" INTEGER NOT NULL DEFAULT 0,
    "orderId" TEXT,
    "requestedById" TEXT,
    "senderDevice" TEXT,
    "paymentId" TEXT,
    "resultJson" JSONB,
    "lateResult" BOOLEAN NOT NULL DEFAULT false,
    "failureCode" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalPaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TerminalPaymentRequest_requestId_key" ON "TerminalPaymentRequest"("requestId");

-- CreateIndex
CREATE INDEX "TerminalPaymentRequest_venueId_status_idx" ON "TerminalPaymentRequest"("venueId", "status");

-- CreateIndex
CREATE INDEX "TerminalPaymentRequest_terminalId_status_idx" ON "TerminalPaymentRequest"("terminalId", "status");

-- Per-terminal active-slot mutex: at most ONE active charge per physical terminal.
-- Partial UNIQUE index (Prisma 6 can't express WHERE in schema.prisma).
-- Active statuses HOLD the slot; UNKNOWN holds it too (outcome unknowable →
-- never free it, or a concurrent retry could double-charge). Terminal states
-- (COMPLETED/FAILED/CANCELLED/TIMED_OUT) release the slot.
CREATE UNIQUE INDEX "TerminalPaymentRequest_active_slot" ON "TerminalPaymentRequest"("terminalId") WHERE "status" IN ('PENDING', 'SENT', 'CANCEL_REQUESTED', 'UNKNOWN');
