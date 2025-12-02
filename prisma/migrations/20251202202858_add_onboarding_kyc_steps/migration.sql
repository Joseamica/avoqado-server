/*
  Warnings:

  - The values [RETAIL] on the enum `BusinessType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `step7_paymentInfo` on the `OnboardingProgress` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "public"."BusinessType_new" AS ENUM ('RESTAURANT', 'BAR', 'CAFE', 'BAKERY', 'FOOD_TRUCK', 'FAST_FOOD', 'CATERING', 'CLOUD_KITCHEN', 'RETAIL_STORE', 'JEWELRY', 'CLOTHING', 'ELECTRONICS', 'PHARMACY', 'CONVENIENCE_STORE', 'SUPERMARKET', 'LIQUOR_STORE', 'FURNITURE', 'HARDWARE', 'BOOKSTORE', 'PET_STORE', 'SALON', 'SPA', 'FITNESS', 'CLINIC', 'VETERINARY', 'AUTO_SERVICE', 'LAUNDRY', 'REPAIR_SHOP', 'HOTEL', 'HOSTEL', 'RESORT', 'CINEMA', 'ARCADE', 'EVENT_VENUE', 'NIGHTCLUB', 'BOWLING', 'OTHER');
ALTER TABLE "public"."Organization" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "public"."Organization" ALTER COLUMN "type" TYPE "public"."BusinessType_new" USING ("type"::text::"public"."BusinessType_new");
ALTER TYPE "public"."BusinessType" RENAME TO "BusinessType_old";
ALTER TYPE "public"."BusinessType_new" RENAME TO "BusinessType";
DROP TYPE "public"."BusinessType_old";
ALTER TABLE "public"."Organization" ALTER COLUMN "type" SET DEFAULT 'RESTAURANT';
COMMIT;

-- AlterTable
ALTER TABLE "public"."OnboardingProgress" DROP COLUMN "step7_paymentInfo",
ADD COLUMN     "step7_kycDocuments" JSONB,
ADD COLUMN     "step8_paymentInfo" JSONB;
