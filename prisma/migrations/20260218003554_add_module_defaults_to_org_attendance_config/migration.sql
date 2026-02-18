-- AlterTable
ALTER TABLE "public"."OrganizationAttendanceConfig" ADD COLUMN     "attendanceTracking" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enableBarcodeScanner" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "enableCardPayments" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "enableCashPayments" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "requireDepositPhoto" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireFacadePhoto" BOOLEAN NOT NULL DEFAULT false;
