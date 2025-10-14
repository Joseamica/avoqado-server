-- AlterTable
ALTER TABLE "public"."RawMaterial" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT;

-- AlterTable
ALTER TABLE "public"."Supplier" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT;

-- CreateIndex
CREATE INDEX "RawMaterial_deletedAt_idx" ON "public"."RawMaterial"("deletedAt");

-- CreateIndex
CREATE INDEX "Supplier_deletedAt_idx" ON "public"."Supplier"("deletedAt");
