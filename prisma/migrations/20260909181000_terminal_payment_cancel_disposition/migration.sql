-- A cancellation intent is not a financial outcome. Legacy rows remain unknown.
ALTER TABLE "TerminalPaymentRequest" ADD COLUMN "cancelDisposition" TEXT;
