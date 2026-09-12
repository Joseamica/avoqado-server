CREATE INDEX "PaymentEffect_orderId_kind_status_idx" ON "PaymentEffect"("orderId", "kind", "status");
CREATE INDEX "PaymentEffect_paymentId_kind_idx" ON "PaymentEffect"("paymentId", "kind");
