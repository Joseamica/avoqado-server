-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "slug" TEXT;

-- CreateIndex (optional, will be enforced if slug becomes required)
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
