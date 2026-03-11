-- AlterTable
ALTER TABLE "public"."SaleVerification" ADD COLUMN     "isPortabilidad" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serialNumbers" TEXT[];

-- AlterTable
ALTER TABLE "public"."VenueSettings" ADD COLUMN     "terminalPermissions" JSONB;
