-- Additive indexes; historical rows are preserved and no unique association is imposed retroactively.
CREATE INDEX "TerminalPaymentRequest_payment_owner_idx" ON "TerminalPaymentRequest" ("paymentId");
CREATE INDEX "TerminalPaymentRequest_recovery_cursor_idx" ON "TerminalPaymentRequest" ("status", "createdAt", "id");
