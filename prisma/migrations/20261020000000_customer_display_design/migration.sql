-- Aditiva e idempotente: no toca una sola fila existente. Desplegarla no cambia el comportamiento de nadie
-- (sin diseño, la tablet usa la fábrica, que se ve idéntica a hoy — spec §2).
DO $$ BEGIN
  CREATE TYPE "CustomerDisplayTheme" AS ENUM ('LIGHT', 'DARK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CustomerDisplayAssetKind" AS ENUM ('SLIDE', 'LOGO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "CustomerDisplayDesign" (
  "id"             TEXT NOT NULL,
  "terminalId"     TEXT NOT NULL,
  "theme"          "CustomerDisplayTheme" NOT NULL DEFAULT 'LIGHT',
  "accentColor"    TEXT,
  "logoAssetId"    TEXT,
  "welcomeText"    TEXT,
  "thanksText"     TEXT,
  "slides"         JSONB NOT NULL DEFAULT '[]',
  "slideSeconds"   INTEGER NOT NULL DEFAULT 8,
  "showPromotions" BOOLEAN NOT NULL DEFAULT false,
  "schemaVersion"  INTEGER NOT NULL DEFAULT 1,
  "revision"       INTEGER NOT NULL DEFAULT 1,
  "updatedById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerDisplayDesign_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerDisplayDesign_terminalId_key" ON "CustomerDisplayDesign"("terminalId");

CREATE TABLE IF NOT EXISTS "CustomerDisplayAsset" (
  "id"          TEXT NOT NULL,
  "venueId"     TEXT NOT NULL,
  "kind"        "CustomerDisplayAssetKind" NOT NULL,
  "objectPath"  TEXT NOT NULL,
  "sha256"      TEXT NOT NULL,
  "mime"        TEXT NOT NULL,
  "width"       INTEGER NOT NULL,
  "height"      INTEGER NOT NULL,
  "bytes"       INTEGER NOT NULL,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerDisplayAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerDisplayAsset_objectPath_key" ON "CustomerDisplayAsset"("objectPath");
CREATE INDEX IF NOT EXISTS "CustomerDisplayAsset_venueId_kind_idx" ON "CustomerDisplayAsset"("venueId", "kind");

DO $$ BEGIN
  ALTER TABLE "CustomerDisplayDesign"
    ADD CONSTRAINT "CustomerDisplayDesign_terminalId_fkey"
    FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CustomerDisplayAsset"
    ADD CONSTRAINT "CustomerDisplayAsset_venueId_fkey"
    FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "customerDisplayDesignVersion"       INTEGER;
ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "customerDisplayInstallationId"      TEXT;
ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "customerDisplayInstallationSince"   TIMESTAMP(3);
ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "customerDisplayInstallationSwitches" JSONB;
ALTER TABLE "Terminal" ADD COLUMN IF NOT EXISTS "customerDisplayAck"                 JSONB;

