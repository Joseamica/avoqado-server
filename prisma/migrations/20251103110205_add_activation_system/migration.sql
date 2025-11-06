-- AlterTable
ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "activationCode" TEXT;
ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "activationCodeExpiry" TIMESTAMP(3);
ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "activatedAt" TIMESTAMP(3);
ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "activatedBy" TEXT;
ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "activationAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "lastActivationAttempt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Terminal_activationCode_key" ON "Terminal"("activationCode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Terminal_activationCode_idx" ON "Terminal"("activationCode");
