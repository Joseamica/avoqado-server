-- BillingObligationConflict — obligaciones de cobro que la entrega no pudo representar sin pisar otra
-- (diseño v5 de la compra, 22-sep-2026). Aditiva: tipos y tabla nuevos, nada existente cambia.
DO $$ BEGIN
  CREATE TYPE "BillingObligationConflictKind" AS ENUM ('DUPLICATE_PLAN', 'DUPLICATE_FEATURE', 'UNKNOWN_PRODUCT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BillingObligationConflictStatus" AS ENUM ('PENDING', 'RESOLVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "BillingObligationConflict" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "customerId" TEXT,
    "kind" "BillingObligationConflictKind" NOT NULL,
    "conflictsWith" TEXT[],
    "featureCode" TEXT,
    "status" "BillingObligationConflictStatus" NOT NULL DEFAULT 'PENDING',
    "detectedBy" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByStaffId" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingObligationConflict_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BillingObligationConflict_subscriptionId_key" ON "BillingObligationConflict"("subscriptionId");
CREATE INDEX IF NOT EXISTS "BillingObligationConflict_venueId_status_idx" ON "BillingObligationConflict"("venueId", "status");
