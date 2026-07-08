-- Faltaban en el enum: los mapeos de ISN (ee686436) y depreciación necesitan su AccountMovementType.
ALTER TYPE "AccountMovementType" ADD VALUE IF NOT EXISTS 'ISN_EXPENSE';
ALTER TYPE "AccountMovementType" ADD VALUE IF NOT EXISTS 'ISN_PAYABLE';
ALTER TYPE "AccountMovementType" ADD VALUE IF NOT EXISTS 'DEPRECIATION_EXPENSE';
ALTER TYPE "AccountMovementType" ADD VALUE IF NOT EXISTS 'ACCUMULATED_DEPRECIATION';
