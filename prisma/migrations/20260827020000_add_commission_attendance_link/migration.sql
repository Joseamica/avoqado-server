-- Asistencia → comisiones: regla por esquema (apagada de fábrica) + rastro del castigo aplicado.
ALTER TABLE "CommissionConfig" ADD COLUMN "attendanceLinked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CommissionConfig" ADD COLUMN "attendanceLatePenaltyRate" DECIMAL(5,4);
ALTER TABLE "CommissionCalculation" ADD COLUMN "attendancePenaltyRate" DECIMAL(5,4);
