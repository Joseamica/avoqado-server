-- CreateEnum
CREATE TYPE "public"."PaymentSource" AS ENUM ('AVOQADO_TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'POS', 'UNKNOWN');

-- AlterTable
ALTER TABLE "public"."Payment" ADD COLUMN     "source" "public"."PaymentSource" NOT NULL DEFAULT 'AVOQADO_TPV';

-- CreateIndex
CREATE INDEX "Payment_source_idx" ON "public"."Payment"("source");
