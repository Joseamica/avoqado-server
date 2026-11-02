-- A (founder, 2-nov-2026): el pago con tarjeta en la tienda en línea viene PRENDIDO; la tienda lo ofrece sólo cuando el negocio
-- tiene su cuenta de Stripe conectada y cobrable (`findCardMerchant`), y cada negocio lo puede apagar.
ALTER TABLE "OnlineOrderingSettings" ALTER COLUMN "acceptsCardOnline" SET DEFAULT true;

-- Negocios que ya existen: se prende a quien nunca tocó el switch. Quien lo cambió (bitácora ONLINE_ORDERING_CARD_TOGGLED, por el
-- panel o el MCP) conserva su decisión. Usa el índice ActivityLog(entity, entityId).
UPDATE "OnlineOrderingSettings" s
SET "acceptsCardOnline" = true
WHERE s."acceptsCardOnline" = false
  AND NOT EXISTS (
    SELECT 1 FROM "ActivityLog" a
    WHERE a."entity" = 'OnlineOrderingSettings' AND a."entityId" = s."id" AND a."action" = 'ONLINE_ORDERING_CARD_TOGGLED'
  );
