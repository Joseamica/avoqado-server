-- AlterTable
ALTER TABLE "public"."SerializedItem" ADD COLUMN     "ownerApprovedAt" TIMESTAMP(3),
ADD COLUMN     "ownerApprovedById" TEXT,
ADD COLUMN     "requiresOwnerApproval" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "SerializedItem_organizationId_requiresOwnerApproval_idx" ON "public"."SerializedItem"("organizationId", "requiresOwnerApproval");
