-- CreateIndex
CREATE INDEX "Order_venueId_createdAt_idx" ON "public"."Order"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_venueId_status_createdAt_idx" ON "public"."Order"("venueId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_venueId_createdAt_idx" ON "public"."Payment"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_venueId_status_createdAt_idx" ON "public"."Payment"("venueId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_merchantAccountId_createdAt_idx" ON "public"."Payment"("merchantAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "Review_venueId_createdAt_idx" ON "public"."Review"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "Shift_venueId_createdAt_idx" ON "public"."Shift"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "Shift_staffId_createdAt_idx" ON "public"."Shift"("staffId", "createdAt");

-- CreateIndex
CREATE INDEX "VenueTransaction_venueId_status_estimatedSettlementDate_idx" ON "public"."VenueTransaction"("venueId", "status", "estimatedSettlementDate");

-- CreateIndex
CREATE INDEX "time_entries_venueId_createdAt_idx" ON "public"."time_entries"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "time_entries_staffId_createdAt_idx" ON "public"."time_entries"("staffId", "createdAt");
