-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletStampShape" ADD VALUE 'CUP';
ALTER TYPE "WalletStampShape" ADD VALUE 'SCISSORS';
ALTER TYPE "WalletStampShape" ADD VALUE 'DUMBBELL';
ALTER TYPE "WalletStampShape" ADD VALUE 'FLOWER';
ALTER TYPE "WalletStampShape" ADD VALUE 'BAG';
