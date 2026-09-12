CREATE INDEX "TerminalPaymentRequest_sale_recovery_idx"
ON "TerminalPaymentRequest" ("venueId", "orderId", "status", "createdAt", "id");

-- Prisma cannot express this JSON field index in its model. It supports exact,
-- tenant-scoped request recovery; time/amount similarity never proves identity.
CREATE INDEX "Payment_terminal_request_recovery_idx"
ON "Payment" ("venueId", ("processorData" #> '{terminalPaymentRequestId}'), "createdAt" DESC, "id" DESC);
