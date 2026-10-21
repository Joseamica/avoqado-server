-- Additive platform onboarding tables. No existing KYC or venue rows are changed.
CREATE TABLE "DocumentRequest" (
 "id" TEXT PRIMARY KEY, "provider" TEXT NOT NULL, "entityType" TEXT NOT NULL,
 "businessName" TEXT NOT NULL, "tokenHash" TEXT NOT NULL, "tokenVersion" INTEGER NOT NULL DEFAULT 1,
 "status" TEXT NOT NULL DEFAULT 'OPEN', "expiresAt" TIMESTAMP(3) NOT NULL,
 "contactName" TEXT, "email" TEXT, "phone" TEXT, "identificationType" TEXT, "privacyAcceptedAt" TIMESTAMP(3),
 "submittedAt" TIMESTAMP(3), "submissionVersion" INTEGER NOT NULL DEFAULT 0, "notificationSnapshot" JSONB,
 "onboardingNotification" TEXT NOT NULL DEFAULT 'NONE', "danielNotification" TEXT NOT NULL DEFAULT 'NONE',
 "notificationAttempts" INTEGER NOT NULL DEFAULT 0, "notificationNextAt" TIMESTAMP(3),
 "notificationLease" TEXT, "notificationLeaseUntil" TIMESTAMP(3), "uploadLease" TEXT, "uploadLeaseUntil" TIMESTAMP(3),
 "uploadAttempts" INTEGER NOT NULL DEFAULT 0, "totalBytes" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "DocumentRequest_provider_check" CHECK ("provider" IN ('ANGELPAY','BLUMON')),
 CONSTRAINT "DocumentRequest_entityType_check" CHECK ("entityType" IN ('PERSONA_FISICA','PERSONA_MORAL')),
 CONSTRAINT "DocumentRequest_status_check" CHECK ("status" IN ('OPEN','SUBMITTED','REVOKED','PURGED')),
 CONSTRAINT "DocumentRequest_quota_check" CHECK ("uploadAttempts" BETWEEN 0 AND 40 AND "totalBytes" BETWEEN 0 AND 67108864)
);
CREATE TABLE "DocumentRequestFile" (
 "id" TEXT PRIMARY KEY, "requestId" TEXT NOT NULL, "uploadId" TEXT NOT NULL, "key" TEXT NOT NULL,
 "fileName" TEXT NOT NULL, "mimeType" TEXT NOT NULL, "sizeBytes" INTEGER NOT NULL, "contentHash" TEXT NOT NULL,
 "storagePath" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "tokenVersion" INTEGER NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "DocumentRequestFile_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DocumentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "DocumentRequestFile_status_check" CHECK ("status" IN ('PENDING','READY','DELETING','DELETED')),
 CONSTRAINT "DocumentRequestFile_size_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 8388608)
);
CREATE UNIQUE INDEX "DocumentRequestFile_requestId_uploadId_key" ON "DocumentRequestFile"("requestId","uploadId");
CREATE INDEX "DocumentRequest_status_createdAt_idx" ON "DocumentRequest"("status","createdAt");
CREATE INDEX "DocumentRequest_notificationNextAt_idx" ON "DocumentRequest"("notificationNextAt");
CREATE INDEX "DocumentRequest_expiresAt_idx" ON "DocumentRequest"("expiresAt");
CREATE INDEX "DocumentRequestFile_requestId_status_idx" ON "DocumentRequestFile"("requestId","status");
CREATE INDEX "DocumentRequestFile_status_updatedAt_idx" ON "DocumentRequestFile"("status","updatedAt");
