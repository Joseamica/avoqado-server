-- AlterTable
ALTER TABLE "AreaTicketFulfillment" ADD COLUMN     "settlementRoute" "AreaSettlementRoute" NOT NULL DEFAULT 'AVOQADO',
ALTER COLUMN "orderId" DROP NOT NULL;
