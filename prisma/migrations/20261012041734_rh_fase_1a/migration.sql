-- CreateEnum
CREATE TYPE "WorkRelation" AS ENUM ('EMPLEADO_NOMINA', 'ASIMILADO', 'INDEPENDIENTE_FACTURA', 'RENTA_SILLA');

-- CreateEnum
CREATE TYPE "PayComponentKind" AS ENUM ('SALARY', 'HOURLY', 'BONUS_FIXED', 'CHAIR_RENT', 'BONUS_CONDITIONAL');

-- CreateTable
CREATE TABLE "StaffPosition" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "icon" TEXT,
    "suggestedRole" "StaffRole" NOT NULL,
    "suggestedRelation" "WorkRelation",
    "tracksAttendanceDefault" BOOLEAN NOT NULL DEFAULT true,
    "componentKinds" "PayComponentKind"[] DEFAULT ARRAY[]::"PayComponentKind"[],
    "migrationKey" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAssignment" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "relation" "WorkRelation",
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "tracksAttendance" BOOLEAN NOT NULL DEFAULT true,
    "supersedesId" TEXT,
    "migrationKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffPosition_migrationKey_key" ON "StaffPosition"("migrationKey");

-- CreateIndex
CREATE INDEX "StaffPosition_venueId_archivedAt_idx" ON "StaffPosition"("venueId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAssignment_supersedesId_key" ON "StaffAssignment"("supersedesId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAssignment_migrationKey_key" ON "StaffAssignment"("migrationKey");

-- CreateIndex
CREATE INDEX "StaffAssignment_venueId_staffId_effectiveTo_idx" ON "StaffAssignment"("venueId", "staffId", "effectiveTo");

-- CreateIndex
CREATE INDEX "StaffAssignment_venueId_positionId_effectiveTo_idx" ON "StaffAssignment"("venueId", "positionId", "effectiveTo");

-- AddForeignKey
ALTER TABLE "StaffPosition" ADD CONSTRAINT "StaffPosition_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "StaffPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "StaffAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariante de fechas (spec RH §3.2): una vigencia nunca termina antes de empezar.
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_vigencia_valida"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");
