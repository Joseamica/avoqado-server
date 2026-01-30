-- DropForeignKey
ALTER TABLE "public"."Staff" DROP CONSTRAINT "Staff_organizationId_fkey";

-- AlterTable
ALTER TABLE "public"."Staff" ALTER COLUMN "organizationId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."Staff" ADD CONSTRAINT "Staff_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
