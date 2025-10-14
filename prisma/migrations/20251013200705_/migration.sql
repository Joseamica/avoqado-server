-- AlterTable
ALTER TABLE "public"."Payment" ALTER COLUMN "source" SET DEFAULT 'OTHER';

-- AlterTable
ALTER TABLE "public"."RawMaterial" ALTER COLUMN "unitType" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."UnitConversion" ALTER COLUMN "unitType" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;
