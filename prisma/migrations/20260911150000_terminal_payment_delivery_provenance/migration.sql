-- Additive, idempotent. Provenance of every delivery of a terminal payment request, written BEFORE emitting.
-- NULL keeps its meaning for historical rows: unknown provenance (never to be read as "never delivered").
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN IF NOT EXISTS "deliveryProvenance" JSONB;
