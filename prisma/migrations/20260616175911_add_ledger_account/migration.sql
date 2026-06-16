-- CreateEnum
CREATE TYPE "public"."LedgerAccountType" AS ENUM ('ACTIVO', 'PASIVO', 'CAPITAL', 'INGRESO', 'COSTO', 'GASTO', 'ORDEN');

-- CreateEnum
CREATE TYPE "public"."LedgerAccountNature" AS ENUM ('DEUDORA', 'ACREEDORA');

-- CreateTable
CREATE TABLE "public"."LedgerAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rfc" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "satGroupingCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "public"."LedgerAccountType" NOT NULL,
    "nature" "public"."LedgerAccountNature" NOT NULL,
    "parentId" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "isPostable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerAccount_organizationId_rfc_parentId_idx" ON "public"."LedgerAccount"("organizationId", "rfc", "parentId");

-- CreateIndex
CREATE INDEX "LedgerAccount_organizationId_rfc_satGroupingCode_idx" ON "public"."LedgerAccount"("organizationId", "rfc", "satGroupingCode");

-- CreateIndex
CREATE INDEX "LedgerAccount_organizationId_rfc_isPostable_idx" ON "public"."LedgerAccount"("organizationId", "rfc", "isPostable");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_organizationId_rfc_code_key" ON "public"."LedgerAccount"("organizationId", "rfc", "code");

-- AddForeignKey
ALTER TABLE "public"."LedgerAccount" ADD CONSTRAINT "LedgerAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LedgerAccount" ADD CONSTRAINT "LedgerAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
