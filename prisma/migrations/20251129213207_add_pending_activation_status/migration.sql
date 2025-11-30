-- AlterEnum
ALTER TYPE "public"."TerminalStatus" ADD VALUE 'PENDING_ACTIVATION';

-- AlterTable
ALTER TABLE "public"."Terminal" ALTER COLUMN "serialNumber" DROP NOT NULL;
