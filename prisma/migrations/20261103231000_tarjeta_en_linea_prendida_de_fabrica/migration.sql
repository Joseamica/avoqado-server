-- A (founder, 2-nov-2026): el pago con tarjeta en la tienda en línea viene PRENDIDO; la tienda lo ofrece sólo cuando el negocio
-- tiene su cuenta de Stripe conectada y cobrable (`findCardMerchant`), y cada negocio lo puede apagar.
ALTER TABLE "OnlineOrderingSettings" ALTER COLUMN "acceptsCardOnline" SET DEFAULT true;

-- Negocios que ya existen: se prende sólo a quien NUNCA expresó el switch. Cuenta como expresado el cambio por el panel o el MCP
-- (ONLINE_ORDERING_CARD_TOGGLED) y también un `false` repetido, que no escribe TOGGLED pero queda en el patch de
-- ONLINE_ORDERING_SETTINGS_UPDATED. Usa el índice ActivityLog(entity, entityId).
UPDATE "OnlineOrderingSettings" s
SET "acceptsCardOnline" = true
WHERE s."acceptsCardOnline" = false
  AND NOT EXISTS (
    SELECT 1 FROM "ActivityLog" a
    WHERE a."entity" = 'OnlineOrderingSettings'
      AND a."entityId" = s."id"
      AND (
        a."action" = 'ONLINE_ORDERING_CARD_TOGGLED'
        OR (a."action" = 'ONLINE_ORDERING_SETTINGS_UPDATED' AND a."data"->'patch' ? 'acceptsCardOnline')
      )
  );
