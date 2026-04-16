-- CreateEnum
CREATE TYPE "public"."SimCustodyEnforcementMode" AS ENUM ('OFF', 'WARN', 'ENFORCE');

-- AlterTable
ALTER TABLE "public"."Organization" ADD COLUMN     "simCustodyEnforcementMode" "public"."SimCustodyEnforcementMode" NOT NULL DEFAULT 'OFF';
