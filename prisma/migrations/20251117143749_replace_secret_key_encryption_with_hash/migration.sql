-- DropIndex (remove old index on secretKeyEncrypted)
DROP INDEX IF EXISTS "EcommerceMerchant_secretKeyEncrypted_key";

-- AlterTable: Add secretKeyHash as nullable first
ALTER TABLE "EcommerceMerchant" ADD COLUMN IF NOT EXISTS "secretKeyHash" TEXT;

-- AlterTable: Rename webhookSecretEncrypted to webhookSecret
ALTER TABLE "EcommerceMerchant" RENAME COLUMN "webhookSecretEncrypted" TO "webhookSecret";

-- For existing merchants: Set a temporary hash (they'll regenerate keys)
-- Using a placeholder that won't conflict (timestamp-based)
UPDATE "EcommerceMerchant"
SET "secretKeyHash" = 'REGENERATE_REQUIRED_' || id
WHERE "secretKeyHash" IS NULL;

-- AlterTable: Make secretKeyHash required
ALTER TABLE "EcommerceMerchant" ALTER COLUMN "secretKeyHash" SET NOT NULL;

-- CreateIndex: Add unique index on secretKeyHash
CREATE UNIQUE INDEX "EcommerceMerchant_secretKeyHash_key" ON "EcommerceMerchant"("secretKeyHash");

-- AlterTable: Drop the old encrypted column (no longer needed)
ALTER TABLE "EcommerceMerchant" DROP COLUMN IF EXISTS "secretKeyEncrypted";

-- Note: Existing merchants will see "REGENERATE_REQUIRED_..." as their secretKeyHash
-- They'll need to regenerate API keys via dashboard, which is acceptable for development
