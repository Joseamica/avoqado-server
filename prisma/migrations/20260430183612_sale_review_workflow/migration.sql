-- CreateEnum
CREATE TYPE "public"."SaleVerificationRejectionReason" AS ENUM ('REVIEW_PORTABILIDAD', 'REVIEW_DUPLICATE_VINCULACION', 'OTHER');

-- AlterTable
ALTER TABLE "public"."SaleVerification" ADD COLUMN     "rejectionReasons" "public"."SaleVerificationRejectionReason"[] DEFAULT ARRAY[]::"public"."SaleVerificationRejectionReason"[],
ADD COLUMN     "reviewNotes" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- CreateIndex
CREATE INDEX "SaleVerification_reviewedById_idx" ON "public"."SaleVerification"("reviewedById");

-- AddForeignKey
ALTER TABLE "public"."SaleVerification" ADD CONSTRAINT "SaleVerification_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "public"."Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
