/*
  Warnings:

  - Adds FIFO (First-In-First-Out) batch tracking system for inventory management
  - Creates StockBatch model for tracking individual inventory lots with locked costs
  - Adds BatchStatus enum: ACTIVE, DEPLETED, EXPIRED, QUARANTINED
  - Links batches to RawMaterialMovement for audit trail
  - Enables accurate cost tracking and expiration management for perishable goods

*/

-- Step 1: Create BatchStatus enum (MUST be outside transaction)
DO $$ BEGIN
  CREATE TYPE "public"."BatchStatus" AS ENUM ('ACTIVE', 'DEPLETED', 'EXPIRED', 'QUARANTINED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Force commit to make enum usable
COMMIT;

-- Step 2: Create StockBatch table and add batch tracking columns
BEGIN;

-- Create StockBatch table for FIFO inventory costing
CREATE TABLE IF NOT EXISTS "public"."StockBatch" (
    "id" TEXT NOT NULL,
    "rawMaterialId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT,
    "batchNumber" TEXT NOT NULL,
    "initialQuantity" DECIMAL(12,3) NOT NULL,
    "remainingQuantity" DECIMAL(12,3) NOT NULL,
    "unit" "public"."Unit" NOT NULL,
    "costPerUnit" DECIMAL(10,4) NOT NULL,
    "receivedDate" TIMESTAMP(3) NOT NULL,
    "expirationDate" TIMESTAMP(3),
    "status" "public"."BatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "depletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBatch_pkey" PRIMARY KEY ("id")
);

-- Add unique constraint for batch number per raw material
ALTER TABLE "public"."StockBatch" ADD CONSTRAINT "StockBatch_rawMaterialId_batchNumber_key" UNIQUE ("rawMaterialId", "batchNumber");

-- Add foreign key constraints
ALTER TABLE "public"."StockBatch" ADD CONSTRAINT "StockBatch_rawMaterialId_fkey"
    FOREIGN KEY ("rawMaterialId") REFERENCES "public"."RawMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."StockBatch" ADD CONSTRAINT "StockBatch_venueId_fkey"
    FOREIGN KEY ("venueId") REFERENCES "public"."Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."StockBatch" ADD CONSTRAINT "StockBatch_purchaseOrderItemId_fkey"
    FOREIGN KEY ("purchaseOrderItemId") REFERENCES "public"."PurchaseOrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add indexes for FIFO queries (critical for performance)
CREATE INDEX IF NOT EXISTS "StockBatch_rawMaterialId_idx" ON "public"."StockBatch"("rawMaterialId");
CREATE INDEX IF NOT EXISTS "StockBatch_venueId_idx" ON "public"."StockBatch"("venueId");
CREATE INDEX IF NOT EXISTS "StockBatch_status_idx" ON "public"."StockBatch"("status");
CREATE INDEX IF NOT EXISTS "StockBatch_receivedDate_idx" ON "public"."StockBatch"("receivedDate"); -- Critical for FIFO ordering
CREATE INDEX IF NOT EXISTS "StockBatch_expirationDate_idx" ON "public"."StockBatch"("expirationDate");
CREATE INDEX IF NOT EXISTS "StockBatch_purchaseOrderItemId_idx" ON "public"."StockBatch"("purchaseOrderItemId");

-- Add batch tracking to RawMaterialMovement for audit trail
ALTER TABLE "public"."RawMaterialMovement" ADD COLUMN IF NOT EXISTS "batchId" TEXT;

ALTER TABLE "public"."RawMaterialMovement" ADD CONSTRAINT "RawMaterialMovement_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "public"."StockBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "RawMaterialMovement_batchId_idx" ON "public"."RawMaterialMovement"("batchId");

COMMIT;
