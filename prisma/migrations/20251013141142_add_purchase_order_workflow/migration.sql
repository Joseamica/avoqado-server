/*
  Warnings:

  - Adds PENDING_APPROVAL, REJECTED, and APPROVED statuses to PurchaseOrderStatus enum
  - Adds approval tracking fields: approvedBy, approvedAt, rejectedBy, rejectedAt, rejectionReason
  - Reorders enum for logical workflow: DRAFT → PENDING_APPROVAL → APPROVED → SENT → CONFIRMED → SHIPPED → PARTIAL/RECEIVED

*/

-- Step 1: Add new enum values (MUST be outside transaction)
ALTER TYPE "public"."PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';
ALTER TYPE "public"."PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "public"."PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'APPROVED';

-- Force commit to make enum values usable
COMMIT;

-- Step 2: Add approval tracking columns
BEGIN;

ALTER TABLE "public"."PurchaseOrder" ADD COLUMN IF NOT EXISTS "approvedBy" TEXT;
ALTER TABLE "public"."PurchaseOrder" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "public"."PurchaseOrder" ADD COLUMN IF NOT EXISTS "rejectedBy" TEXT;
ALTER TABLE "public"."PurchaseOrder" ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3);
ALTER TABLE "public"."PurchaseOrder" ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;

-- Step 3: Migrate existing data if needed
-- Orders that are currently CONFIRMED can be considered APPROVED
-- (since CONFIRMED was being used for "approved by manager" in the old system)
-- This is optional - comment out if you want to keep existing CONFIRMED as-is
-- UPDATE "public"."PurchaseOrder" SET "status" = 'APPROVED' WHERE "status" = 'CONFIRMED';

-- Note: We keep existing statuses as-is for backward compatibility
-- New orders will use the new workflow

COMMIT;
