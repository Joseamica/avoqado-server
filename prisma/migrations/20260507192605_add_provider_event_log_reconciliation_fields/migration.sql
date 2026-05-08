-- AlterTable
ALTER TABLE "public"."ProviderEventLog" ADD COLUMN     "errorReason" TEXT,
ADD COLUMN     "paymentId" TEXT,
ADD COLUMN     "terminalId" TEXT;

-- CreateIndex
CREATE INDEX "ProviderEventLog_terminalId_idx" ON "public"."ProviderEventLog"("terminalId");

-- CreateIndex
CREATE INDEX "ProviderEventLog_paymentId_idx" ON "public"."ProviderEventLog"("paymentId");

-- CreateIndex
CREATE INDEX "ProviderEventLog_status_createdAt_idx" ON "public"."ProviderEventLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderEventLog_type_createdAt_idx" ON "public"."ProviderEventLog"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderEventLog_provider_eventId_key" ON "public"."ProviderEventLog"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "public"."ProviderEventLog" ADD CONSTRAINT "ProviderEventLog_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "public"."Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProviderEventLog" ADD CONSTRAINT "ProviderEventLog_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
