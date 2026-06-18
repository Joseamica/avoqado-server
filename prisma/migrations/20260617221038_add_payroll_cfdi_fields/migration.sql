-- CreateEnum
CREATE TYPE "public"."PayrollCfdiStatus" AS ENUM ('PENDING', 'STAMPED', 'ERROR');

-- AlterTable
ALTER TABLE "public"."Employee" ADD COLUMN     "claveEntFed" TEXT,
ADD COLUMN     "numEmpleado" TEXT,
ADD COLUMN     "registroPatronal" TEXT,
ADD COLUMN     "salarioDiarioIntegradoCents" INTEGER,
ADD COLUMN     "tipoContrato" TEXT NOT NULL DEFAULT '01',
ADD COLUMN     "tipoRegimen" TEXT NOT NULL DEFAULT '02';

-- AlterTable
ALTER TABLE "public"."PayrollLine" ADD COLUMN     "cfdiError" TEXT,
ADD COLUMN     "cfdiProviderId" TEXT,
ADD COLUMN     "cfdiStatus" "public"."PayrollCfdiStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "cfdiUuid" TEXT;

