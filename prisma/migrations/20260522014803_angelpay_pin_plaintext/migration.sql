-- AlterTable
ALTER TABLE "public"."AngelPayUserAccount" ADD COLUMN     "pin" TEXT;

-- RenameIndex
ALTER INDEX "public"."MerchantAccount_providerId_externalMerchantId_angelpayUserAccou" RENAME TO "MerchantAccount_providerId_externalMerchantId_angelpayUserA_key";
