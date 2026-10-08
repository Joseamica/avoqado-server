-- AlterTable
ALTER TABLE "ClassSession" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "originalStaffId" TEXT,
ADD COLUMN     "staffAssignedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ServicePayTableVersion" ADD COLUMN     "coverBonusAmount" DECIMAL(12,2),
ADD COLUMN     "coverBonusHours" INTEGER,
ADD COLUMN     "lateCancelHours" INTEGER;


-- Reglas de clase (spec fase 3 §7.3): horas enteras de 1 a 168; bono > 0 y <= $100,000; horas y bono de suplencia juntos.
ALTER TABLE "ServicePayTableVersion" ADD CONSTRAINT "ServicePayTableVersion_suplencia_valida"
  CHECK (
    ("coverBonusHours" IS NULL) = ("coverBonusAmount" IS NULL)
    AND ("coverBonusHours" IS NULL OR "coverBonusHours" BETWEEN 1 AND 168)
    AND ("coverBonusAmount" IS NULL OR ("coverBonusAmount" > 0 AND "coverBonusAmount" <= 100000))
  );
ALTER TABLE "ServicePayTableVersion" ADD CONSTRAINT "ServicePayTableVersion_cancelacion_valida"
  CHECK ("lateCancelHours" IS NULL OR "lateCancelHours" BETWEEN 1 AND 168);

-- BACKFILL:INICIO
-- Spec fase 3 §7.2. Sólo lo vacío: repetirlo no cambia nada. Ninguna regla está prendida todavía, así que estas
-- aproximaciones (createdAt, updatedAt) no le pagan a nadie.
UPDATE "ClassSession" SET "originalStaffId" = "assignedStaffId", "staffAssignedAt" = "createdAt"
  WHERE "assignedStaffId" IS NOT NULL AND "originalStaffId" IS NULL;
UPDATE "ClassSession" SET "cancelledAt" = "updatedAt"
  WHERE status = 'CANCELLED' AND "cancelledAt" IS NULL;
-- BACKFILL:FIN
