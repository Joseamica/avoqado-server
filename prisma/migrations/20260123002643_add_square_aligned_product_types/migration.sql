-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "public"."ProductType" ADD VALUE 'REGULAR';
ALTER TYPE "public"."ProductType" ADD VALUE 'FOOD_AND_BEV';
ALTER TYPE "public"."ProductType" ADD VALUE 'APPOINTMENTS_SERVICE';
ALTER TYPE "public"."ProductType" ADD VALUE 'EVENT';
ALTER TYPE "public"."ProductType" ADD VALUE 'DIGITAL';
ALTER TYPE "public"."ProductType" ADD VALUE 'DONATION';

-- AlterTable
ALTER TABLE "public"."Product" ADD COLUMN     "abbreviation" TEXT,
ADD COLUMN     "allowCustomAmount" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "donationCause" TEXT,
ADD COLUMN     "downloadLimit" INTEGER,
ADD COLUMN     "downloadUrl" TEXT,
ADD COLUMN     "duration" INTEGER,
ADD COLUMN     "eventCapacity" INTEGER,
ADD COLUMN     "eventDate" TIMESTAMP(3),
ADD COLUMN     "eventEndTime" TEXT,
ADD COLUMN     "eventLocation" TEXT,
ADD COLUMN     "eventTime" TEXT,
ADD COLUMN     "fileSize" TEXT,
ADD COLUMN     "isAlcoholic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kitchenName" TEXT,
ADD COLUMN     "suggestedAmounts" DECIMAL(65,30)[] DEFAULT ARRAY[]::DECIMAL(65,30)[];
