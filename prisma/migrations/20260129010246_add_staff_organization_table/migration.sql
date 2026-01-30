-- CreateEnum
CREATE TYPE "public"."OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateTable
CREATE TABLE "public"."StaffOrganization" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "public"."OrgRole" NOT NULL DEFAULT 'MEMBER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedById" TEXT,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "StaffOrganization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffOrganization_staffId_idx" ON "public"."StaffOrganization"("staffId");

-- CreateIndex
CREATE INDEX "StaffOrganization_organizationId_idx" ON "public"."StaffOrganization"("organizationId");

-- CreateIndex
CREATE INDEX "StaffOrganization_isPrimary_idx" ON "public"."StaffOrganization"("isPrimary");

-- CreateIndex
CREATE UNIQUE INDEX "StaffOrganization_staffId_organizationId_key" ON "public"."StaffOrganization"("staffId", "organizationId");

-- AddForeignKey
ALTER TABLE "public"."StaffOrganization" ADD CONSTRAINT "StaffOrganization_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "public"."Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StaffOrganization" ADD CONSTRAINT "StaffOrganization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
