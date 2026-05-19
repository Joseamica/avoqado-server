-- CreateEnum
CREATE TYPE "public"."VenueChatMode" AS ENUM ('RELAY', 'WA_ME_FALLBACK', 'DISABLED');

-- AlterTable
ALTER TABLE "public"."Venue" ADD COLUMN     "whatsappContactMode" "public"."VenueChatMode" NOT NULL DEFAULT 'WA_ME_FALLBACK',
ADD COLUMN     "whatsappOptInAt" TIMESTAMP(3),
ADD COLUMN     "whatsappOptInPhone" TEXT;
