-- Add hardware information fields to Terminal table
-- These fields store the physical device manufacturer and model for payment terminals

-- Add brand column (hardware manufacturer: PAX, Ingenico, Verifone, etc.)
ALTER TABLE "Terminal" ADD COLUMN "brand" TEXT;

-- Add model column (hardware model: A910S, D220, VX520, etc.)
ALTER TABLE "Terminal" ADD COLUMN "model" TEXT;

-- Add comments for documentation
COMMENT ON COLUMN "Terminal"."brand" IS 'Hardware manufacturer (e.g., PAX, Ingenico, Verifone)';
COMMENT ON COLUMN "Terminal"."model" IS 'Hardware model (e.g., A910S, D220, VX520)';
