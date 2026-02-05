-- CreateEnum
CREATE TYPE "UpdateMode" AS ENUM ('NONE', 'BANNER', 'FORCE');

-- AlterTable: Add updateMode column with default NONE
ALTER TABLE "AppUpdate" ADD COLUMN "updateMode" "UpdateMode" NOT NULL DEFAULT 'NONE';

-- DataMigration: Preserve isRequired values
-- isRequired = true  → updateMode = 'FORCE' (blocking update)
-- isRequired = false → updateMode = 'NONE' (already default)
UPDATE "AppUpdate" SET "updateMode" = 'FORCE' WHERE "isRequired" = true;

-- AlterTable: Drop the old isRequired column (data is now preserved in updateMode)
ALTER TABLE "AppUpdate" DROP COLUMN "isRequired";
