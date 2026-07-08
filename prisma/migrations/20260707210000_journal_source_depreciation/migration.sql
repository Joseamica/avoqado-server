-- Nuevo origen de póliza: depreciación de activos fijos (deducción de inversiones).
ALTER TYPE "JournalEntrySource" ADD VALUE IF NOT EXISTS 'DEPRECIATION';
