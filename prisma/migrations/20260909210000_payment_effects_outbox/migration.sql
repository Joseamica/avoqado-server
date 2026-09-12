CREATE TABLE "PaymentEffect" (
    "id" TEXT NOT NULL, "venueId" TEXT NOT NULL, "paymentId" TEXT NOT NULL, "orderId" TEXT,
    "kind" TEXT NOT NULL, "dedupeKey" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "leaseUntil" TIMESTAMP(3), "claimToken" TEXT,
    "completedAt" TIMESTAMP(3), "lastError" VARCHAR(500), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentEffect_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentEffect_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaymentEffect_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PaymentEffect_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PaymentEffect_venueId_dedupeKey_key" ON "PaymentEffect"("venueId", "dedupeKey");
CREATE INDEX "PaymentEffect_status_nextAttemptAt_id_idx" ON "PaymentEffect"("status", "nextAttemptAt", "id");
CREATE INDEX "PaymentEffect_status_leaseUntil_id_idx" ON "PaymentEffect"("status", "leaseUntil", "id");
CREATE INDEX "PaymentEffect_venueId_status_createdAt_id_idx" ON "PaymentEffect"("venueId", "status", "createdAt", "id");
