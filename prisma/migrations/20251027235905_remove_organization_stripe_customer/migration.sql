/*
  Warnings:

  - You are about to drop the column `stripeCustomerId` on the `Organization` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "public"."Organization_stripeCustomerId_key";

-- AlterTable
ALTER TABLE "public"."Organization" DROP COLUMN "stripeCustomerId";
