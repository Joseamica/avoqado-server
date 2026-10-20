-- Additive only. Existing invitations remain unbound; historical snapshots are created lazily.
ALTER TABLE "DocumentRequest" ADD COLUMN "organizationId" TEXT;
CREATE UNIQUE INDEX "DocumentRequest_id_organizationId_key" ON "DocumentRequest"("id", "organizationId");
CREATE INDEX "DocumentRequest_organizationId_idx" ON "DocumentRequest"("organizationId");
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TABLE "DocumentRequestSubmission" (
 "id" TEXT PRIMARY KEY, "requestId" TEXT NOT NULL, "submissionVersion" INTEGER NOT NULL,
 "snapshot" JSONB NOT NULL, "submittedAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "DocumentRequestSubmission_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DocumentRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "DocumentRequestSubmission_version_check" CHECK ("submissionVersion" >= 1)
);
CREATE UNIQUE INDEX "DocumentRequestSubmission_requestId_submissionVersion_key" ON "DocumentRequestSubmission"("requestId", "submissionVersion");
CREATE TABLE "DocumentRequestSubmissionFile" (
 "submissionId" TEXT NOT NULL, "documentId" TEXT NOT NULL,
 CONSTRAINT "DocumentRequestSubmissionFile_pkey" PRIMARY KEY ("submissionId", "documentId"),
 CONSTRAINT "DocumentRequestSubmissionFile_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DocumentRequestSubmission"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "DocumentRequestSubmissionFile_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "DocumentRequestFile"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "DocumentRequestSubmissionFile_documentId_idx" ON "DocumentRequestSubmissionFile"("documentId");
CREATE TABLE "DocumentRequestVenueLink" (
 "id" TEXT PRIMARY KEY, "requestId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "submissionId" TEXT NOT NULL,
 "venueId" TEXT NOT NULL, "actorId" TEXT NOT NULL, "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "onboardingHash" TEXT, "onboardingResult" JSONB,
 CONSTRAINT "DocumentRequestVenueLink_requestId_organizationId_fkey" FOREIGN KEY ("requestId", "organizationId") REFERENCES "DocumentRequest"("id", "organizationId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "DocumentRequestVenueLink_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DocumentRequestSubmission"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "DocumentRequestVenueLink_venueId_organizationId_fkey" FOREIGN KEY ("venueId", "organizationId") REFERENCES "Venue"("id", "organizationId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "DocumentRequestVenueLink_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "DocumentRequestVenueLink_onboardingHash_key" ON "DocumentRequestVenueLink"("onboardingHash");
CREATE UNIQUE INDEX "DocumentRequestVenueLink_venueId_submissionId_key" ON "DocumentRequestVenueLink"("venueId", "submissionId");
CREATE INDEX "DocumentRequestVenueLink_venueId_linkedAt_id_idx" ON "DocumentRequestVenueLink"("venueId", "linkedAt", "id");
CREATE INDEX "DocumentRequestVenueLink_requestId_linkedAt_id_idx" ON "DocumentRequestVenueLink"("requestId", "linkedAt", "id");
CREATE INDEX "DocumentRequestVenueLink_submissionId_idx" ON "DocumentRequestVenueLink"("submissionId");
CREATE INDEX "DocumentRequestVenueLink_actorId_idx" ON "DocumentRequestVenueLink"("actorId");
