-- Additive, idempotent. Durable-net bookkeeping (Codex r11, P1-B): the last collision-evidence Payment.id the sweep already
-- walked for this released request, so a bounded page of five can ADVANCE instead of re-reading the same five forever.
-- NULL = start from the beginning. Never sent to clients; written without touching "updatedAt".
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN IF NOT EXISTS "collisionEvidenceCursor" TEXT;
