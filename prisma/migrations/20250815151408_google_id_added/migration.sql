/*
  Warnings:

  - A unique constraint covering the columns `[googleId]` on the table `Staff` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."Staff" ADD COLUMN     "googleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Staff_googleId_key" ON "public"."Staff"("googleId");
