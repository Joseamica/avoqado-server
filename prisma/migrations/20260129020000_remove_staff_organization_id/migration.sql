-- DropForeignKey
ALTER TABLE "Staff" DROP CONSTRAINT IF EXISTS "Staff_organizationId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "Staff_organizationId_idx";

-- AlterTable
ALTER TABLE "Staff" DROP COLUMN IF EXISTS "organizationId";
