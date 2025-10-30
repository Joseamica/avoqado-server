-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "resetToken" TEXT,
ADD COLUMN     "resetTokenExpiry" TIMESTAMP(3),
ADD COLUMN     "resetTokenUsedAt" TIMESTAMP(3),
ADD COLUMN     "lastPasswordReset" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Staff_resetToken_key" ON "Staff"("resetToken");
