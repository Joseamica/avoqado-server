-- CreateEnum
CREATE TYPE "public"."VerificationStatus" AS ENUM ('PENDING_REVIEW', 'IN_REVIEW', 'VERIFIED', 'REJECTED');

-- AlterTable
ALTER TABLE "public"."MerchantAccount" ADD COLUMN     "accountHolder" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "clabeNumber" TEXT;

-- AlterTable
ALTER TABLE "public"."Venue" ADD COLUMN     "caratulaBancariaUrl" TEXT,
ADD COLUMN     "comprobanteDomicilioUrl" TEXT,
ADD COLUMN     "kycCompletedAt" TIMESTAMP(3),
ADD COLUMN     "kycRejectionReason" TEXT,
ADD COLUMN     "kycStatus" "public"."VerificationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
ADD COLUMN     "kycVerifiedBy" TEXT,
ADD COLUMN     "poderLegalUrl" TEXT,
ADD COLUMN     "rfcDocumentUrl" TEXT;
