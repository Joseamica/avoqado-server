-- Migration: Add Blumon Multi-Merchant Support
-- Date: 2025-11-05
-- Purpose: Enable multi-merchant payment routing on PAX terminals with Blumon

-- Add Blumon-specific fields to MerchantAccount table
ALTER TABLE "MerchantAccount" ADD COLUMN "blumonSerialNumber" TEXT;
ALTER TABLE "MerchantAccount" ADD COLUMN "blumonPosId" TEXT;
ALTER TABLE "MerchantAccount" ADD COLUMN "blumonEnvironment" TEXT;
ALTER TABLE "MerchantAccount" ADD COLUMN "blumonMerchantId" TEXT;

-- Add multi-merchant support to Terminal table
ALTER TABLE "Terminal" ADD COLUMN "assignedMerchantIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS "MerchantAccount_blumonSerialNumber_idx" ON "MerchantAccount"("blumonSerialNumber");
CREATE INDEX IF NOT EXISTS "Terminal_assignedMerchantIds_idx" ON "Terminal" USING GIN ("assignedMerchantIds");

-- Add comments for documentation
COMMENT ON COLUMN "MerchantAccount"."blumonSerialNumber" IS 'Blumon device serial number (e.g., "2841548417")';
COMMENT ON COLUMN "MerchantAccount"."blumonPosId" IS 'Momentum API posId for this merchant (e.g., "376")';
COMMENT ON COLUMN "MerchantAccount"."blumonEnvironment" IS 'Blumon environment: SANDBOX or PRODUCTION';
COMMENT ON COLUMN "MerchantAccount"."blumonMerchantId" IS 'Blumon merchant identifier';
COMMENT ON COLUMN "Terminal"."assignedMerchantIds" IS 'Array of MerchantAccount IDs this terminal can use for payment processing';
