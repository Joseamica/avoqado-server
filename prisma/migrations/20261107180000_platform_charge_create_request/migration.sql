ALTER TABLE "PlatformCharge"
  ADD COLUMN "clientRequestId" TEXT,
  ADD COLUMN "createRequestHash" TEXT;

CREATE UNIQUE INDEX "PlatformCharge_clientRequestId_key" ON "PlatformCharge"("clientRequestId");
