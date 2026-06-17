-- Auto-posting (slice 2): IVA trasladado cobrado necesita su propio tipo de movimiento → 208.01.
ALTER TYPE "AccountMovementType" ADD VALUE IF NOT EXISTS 'IVA_OUTPUT' BEFORE 'CASH_RECEIPT';
