-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ServiceEarningSource" ADD VALUE 'COMMISSION';
ALTER TYPE "ServiceEarningSource" ADD VALUE 'TIP';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "staffPayStartDate" DATE;

-- CreateTable
CREATE TABLE "StaffPayTipWindow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "startedById" TEXT NOT NULL,
    "endedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPayTipWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffPayTipWindow_organizationId_startsAt_idx" ON "StaffPayTipWindow"("organizationId", "startsAt");

-- CreateIndex
CREATE INDEX "CommissionCalculation_venueId_calculatedAt_idx" ON "CommissionCalculation"("venueId", "calculatedAt");

-- AddForeignKey
ALTER TABLE "StaffPayTipWindow" ADD CONSTRAINT "StaffPayTipWindow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Lo que el ORM no expresa (spec fase 3 §6.1, §6.4, §7.1) ──

-- 1) El CHECK de la fase 2 se acota a las clases: un reverso de comisión o una propina devuelta son negativos por naturaleza.
ALTER TABLE "ServiceEarning" DROP CONSTRAINT "ServiceEarning_service_no_negativo";
ALTER TABLE "ServiceEarning" ADD CONSTRAINT "ServiceEarning_service_no_negativo"
  CHECK ("concept" <> 'SERVICE' OR "sourceType" <> 'CLASS_SESSION' OR "amount" >= 0);

-- 2) Un reverso automático por anulación, UNA vez por comisión y persona (§6.4). Se escribe `<> 'CLASS_SESSION'` y no
--    `= 'COMMISSION'`: Postgres no deja usar un valor de enum en la misma transacción que lo agrega («unsafe use of new
--    value»). Hoy es lo mismo: no existe RECONCILE de propina, y los RECONCILE de clase (liquidaciones) quedan fuera.
CREATE UNIQUE INDEX "ServiceEarning_reverso_venta_unico" ON "ServiceEarning"("sourceType", "sourceId", "staffId")
  WHERE "concept" = 'RECONCILE' AND "sourceType" <> 'CLASS_SESSION';

-- 3) Interruptor de propinas: a lo más una ventana abierta por organización; [startsAt, endsAt) nunca al revés, y una
--    ventana cerrada siempre sabe quién la cerró.
CREATE UNIQUE INDEX "StaffPayTipWindow_una_abierta" ON "StaffPayTipWindow"("organizationId") WHERE "endsAt" IS NULL;
ALTER TABLE "StaffPayTipWindow" ADD CONSTRAINT "StaffPayTipWindow_rango" CHECK ("endsAt" IS NULL OR "endsAt" >= "startsAt");
ALTER TABLE "StaffPayTipWindow" ADD CONSTRAINT "StaffPayTipWindow_cierre_completo" CHECK (("endsAt" IS NULL) = ("endedById" IS NULL));

-- 4) Los ajustes MANUAL ya guardados ganan el nombre visible de la persona mientras exista (Codex r2-17): así su recibo
--    abre aunque después la borren. Los que ya no tienen persona abren como «Persona dada de baja» (B5).
UPDATE "ServiceEarning" e
SET descriptor = e.descriptor || jsonb_build_object('persona', NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName")), ''))
FROM "Staff" s
WHERE s.id = e."staffId"
  AND e.concept = 'MANUAL'
  AND e.descriptor->>'persona' IS NULL
  AND NULLIF(TRIM(CONCAT(s."firstName", ' ', s."lastName")), '') IS NOT NULL;
