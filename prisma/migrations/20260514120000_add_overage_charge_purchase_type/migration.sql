-- Add OVERAGE_CHARGE to TokenPurchaseType enum (Postgres ALTER TYPE syntax)
ALTER TYPE "TokenPurchaseType" ADD VALUE IF NOT EXISTS 'OVERAGE_CHARGE';
