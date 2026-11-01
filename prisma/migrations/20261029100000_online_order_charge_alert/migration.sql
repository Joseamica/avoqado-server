-- AlterTable
ALTER TABLE "OnlineOrderCharge" ADD COLUMN     "inDoubtSince" TIMESTAMP(3),
ADD COLUMN     "stuckAlertedAt" TIMESTAMP(3);
