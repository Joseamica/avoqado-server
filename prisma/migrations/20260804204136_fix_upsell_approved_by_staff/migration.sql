-- DropForeignKey
ALTER TABLE "UpsellRule" DROP CONSTRAINT "UpsellRule_approvedById_fkey";

-- AddForeignKey
ALTER TABLE "UpsellRule" ADD CONSTRAINT "UpsellRule_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
