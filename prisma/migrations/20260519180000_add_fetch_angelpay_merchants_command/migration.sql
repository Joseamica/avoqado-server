-- Add FETCH_ANGELPAY_MERCHANTS to TpvCommandType enum (2026-05-19).
--
-- The value was added to prisma/schema.prisma's enum but no migration ever
-- shipped it to the database, so any attempt to enqueue this command failed
-- at runtime with Postgres error 22P02 "invalid input value for enum".
--
-- ALTER TYPE ... ADD VALUE must run OUTSIDE a transaction. Prisma's migrate
-- engine handles that automatically.

ALTER TYPE "TpvCommandType" ADD VALUE IF NOT EXISTS 'FETCH_ANGELPAY_MERCHANTS';
