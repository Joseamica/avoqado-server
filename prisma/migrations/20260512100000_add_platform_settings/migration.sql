-- PlatformSettings: singleton table for global Avoqado knobs.
-- Single row enforced by always upserting on id='default'.

CREATE TABLE IF NOT EXISTS "PlatformSettings" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "ecommercePlatformFeeBpsDefault" INTEGER NOT NULL DEFAULT 100,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedById" TEXT,

  CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row so the service helpers can always read it without
-- a separate first-time setup step.
INSERT INTO "PlatformSettings" ("id", "ecommercePlatformFeeBpsDefault")
VALUES ('default', 100)
ON CONFLICT ("id") DO NOTHING;
