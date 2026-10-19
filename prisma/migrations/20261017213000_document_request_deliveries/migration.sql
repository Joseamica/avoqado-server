CREATE TABLE "DocumentRequestDelivery" (
 "id" TEXT PRIMARY KEY, "requestId" TEXT NOT NULL, "submissionVersion" INTEGER NOT NULL,
 "recipient" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "snapshot" JSONB NOT NULL,
 "attempts" INTEGER NOT NULL DEFAULT 0, "firstAttemptAt" TIMESTAMP(3),
 "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP, "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "DocumentRequestDelivery_requestId_fkey" FOREIGN KEY("requestId") REFERENCES "DocumentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "DocumentRequestDelivery_status_check" CHECK("status" IN ('PENDING','SENT','FAILED','UNKNOWN')),
 CONSTRAINT "DocumentRequestDelivery_recipient_check" CHECK("recipient" IN ('onboarding@avoqado.io','daniel@avoqado.io'))
);
CREATE UNIQUE INDEX "DocumentRequestDelivery_requestId_submissionVersion_recipient_key" ON "DocumentRequestDelivery"("requestId","submissionVersion","recipient");
CREATE INDEX "DocumentRequestDelivery_status_nextAttemptAt_idx" ON "DocumentRequestDelivery"("status","nextAttemptAt");
