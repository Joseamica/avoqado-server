-- DropForeignKey
ALTER TABLE "public"."VenuePaymentConfig" DROP CONSTRAINT "VenuePaymentConfig_secondaryAccountId_fkey";

-- DropForeignKey
ALTER TABLE "public"."VenuePaymentConfig" DROP CONSTRAINT "VenuePaymentConfig_tertiaryAccountId_fkey";

-- AddForeignKey
ALTER TABLE "public"."VenuePaymentConfig" ADD CONSTRAINT "VenuePaymentConfig_secondaryAccountId_fkey" FOREIGN KEY ("secondaryAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VenuePaymentConfig" ADD CONSTRAINT "VenuePaymentConfig_tertiaryAccountId_fkey" FOREIGN KEY ("tertiaryAccountId") REFERENCES "public"."MerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
