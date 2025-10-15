-- CreateEnum
CREATE TYPE "public"."PaymentType" AS ENUM ('REGULAR', 'FAST', 'REFUND', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "public"."Payment" ADD COLUMN     "type" "public"."PaymentType" DEFAULT 'REGULAR';
