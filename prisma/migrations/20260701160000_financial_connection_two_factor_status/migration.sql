-- Add PENDING_TWO_FACTOR_AUTH status to FinancialConnectionStatus enum
-- This represents the state where 2FA validation is needed (occurs between
-- PENDING_DEVICE_VALIDATION and PENDING_ACCOUNT_SELECTION in the connection flow)
ALTER TYPE "FinancialConnectionStatus" ADD VALUE 'PENDING_TWO_FACTOR_AUTH' AFTER 'PENDING_DEVICE_VALIDATION';
