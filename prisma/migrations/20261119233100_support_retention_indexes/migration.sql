CREATE INDEX "SupportWhatsappLink_expiresAt_id_idx" ON "SupportWhatsappLink"("expiresAt", "id");
CREATE INDEX "SupportLinkChallenge_createdAt_id_idx" ON "SupportLinkChallenge"("createdAt", "id");
CREATE INDEX "SupportMessage_createdAt_id_idx" ON "SupportMessage"("createdAt", "id");
CREATE INDEX "SupportBudget_windowStart_key_idx" ON "SupportBudget"("windowStart", "key");
CREATE INDEX "SupportConversation_selectionExpiresAt_id_idx" ON "SupportConversation"("selectionExpiresAt", "id");
