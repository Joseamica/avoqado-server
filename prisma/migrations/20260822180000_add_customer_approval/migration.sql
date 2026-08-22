-- Fase 1 — Aprobación de clientes por el venue.
--
-- Semántica: el venue decide a quién le deja reservar. Sólo aplica cuando
-- ReservationSettings.requireCustomerApproval está prendido (default OFF); con el switch
-- apagado el gate ni siquiera lee estos campos.
--
-- 🔴 REGLA QUE NO SE ROMPE: ningún Customer existente pasa a PENDING — ni aquí ni al mover el
-- switch. El default de la columna es APPROVED y el backfill de abajo sólo rellena fechas.
-- Alguien que ya reservaba no puede quedarse fuera por prender una casilla.

-- CreateEnum
CREATE TYPE "CustomerApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "accountActivatedAt" TIMESTAMP(3),
ADD COLUMN     "approvalDecidedAt" TIMESTAMP(3),
ADD COLUMN     "approvalDecidedByStaffId" TEXT,
ADD COLUMN     "approvalDecisionReason" TEXT,
ADD COLUMN     "approvalRequestedAt" TIMESTAMP(3),
ADD COLUMN     "approvalStatus" "CustomerApprovalStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "approvalVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ReservationSettings" ADD COLUMN     "customerApprovalNotificationRoles" "StaffRole"[] DEFAULT ARRAY['OWNER', 'ADMIN']::"StaffRole"[],
ADD COLUMN     "requireCustomerApproval" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Customer_venueId_approvalStatus_approvalRequestedAt_idx" ON "Customer"("venueId", "approvalStatus", "approvalRequestedAt");

-- AddForeignKey
-- Restrict: dar de baja a un staff nunca borra la historia de quién aprobó a quién.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_approvalDecidedByStaffId_fkey" FOREIGN KEY ("approvalDecidedByStaffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariante: no se puede exigir aprobación sin exigir cuenta. Sin cuenta no hay a quién
-- aprobar, y el cliente quedaría bloqueado sin forma de pedir acceso.
ALTER TABLE "ReservationSettings"
  ADD CONSTRAINT "ReservationSettings_approval_requires_account_check"
  CHECK (NOT "requireCustomerApproval" OR "requireAccount");

-- Backfill: los que YA activaron cuenta (password, Consumer o proveedor social) quedan con su
-- historia sellada en createdAt — así la bandeja "en espera" nace vacía y ningún reporte ve
-- fechas nulas. Los contactos de CRM (sin cuenta) conservan accountActivatedAt = NULL: aún no
-- son una cuenta, y pedirán aprobación el día que alguien los active.
UPDATE "Customer"
   SET "accountActivatedAt"  = "createdAt",
       "approvalRequestedAt" = "createdAt",
       "approvalDecidedAt"   = "createdAt"
 WHERE "password" IS NOT NULL
    OR "consumerId" IS NOT NULL
    OR "providerId" IS NOT NULL;
