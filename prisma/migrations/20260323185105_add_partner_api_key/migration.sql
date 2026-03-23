-- DropIndex
DROP INDEX "public"."idx_product_name_trgm";

-- DropIndex
DROP INDEX "public"."idx_raw_material_name_trgm";

-- DropIndex
DROP INDEX "public"."idx_supplier_name_trgm";

-- CreateTable
CREATE TABLE "public"."PartnerAPIKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT,
    "secretKeyHash" TEXT NOT NULL,
    "sandboxMode" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerAPIKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerAPIKey_secretKeyHash_key" ON "public"."PartnerAPIKey"("secretKeyHash");

-- CreateIndex
CREATE INDEX "PartnerAPIKey_organizationId_idx" ON "public"."PartnerAPIKey"("organizationId");

-- AddForeignKey
ALTER TABLE "public"."PartnerAPIKey" ADD CONSTRAINT "PartnerAPIKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
