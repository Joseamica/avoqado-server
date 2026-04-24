-- AlterTable
ALTER TABLE "public"."ReservationSettings" ADD COLUMN     "creditFreeRefundHoursBefore" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "creditLateRefundPercent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creditNoShowRefund" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "creditRefundMode" TEXT NOT NULL DEFAULT 'TIME_BASED';
