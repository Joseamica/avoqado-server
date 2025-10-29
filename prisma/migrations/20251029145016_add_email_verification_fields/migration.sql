-- AlterTable
ALTER TABLE "public"."Staff" ADD COLUMN     "emailVerificationCode" TEXT,
ADD COLUMN     "emailVerificationExpires" TIMESTAMP(3);
