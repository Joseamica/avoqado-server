-- Loosen MERCADO_PAGO configSchema: all fields are OAuth-managed, never user-input.
--
-- The original seed marked mpUserId, accessTokenCiphertext, etc. as `required`
-- because the credentials envelope needs those keys. But the EcommerceMerchant
-- create wizard reads the same schema to demand fields from the user, which
-- breaks the OAuth flow (operator can't fill in an encrypted token by hand).
--
-- Fix: keep the property descriptions (useful for ops/docs), drop the `required`
-- array. The OAuth callback handler still writes all the fields with proper
-- types via connection.service.persistTokens — schema-level enforcement isn't
-- needed because every write goes through that one chokepoint.
UPDATE "PaymentProvider"
SET "configSchema" = '{
  "type": "object",
  "description": "Credentials filled in by the OAuth callback after the seller authorizes Avoqado. Not user-input — DO NOT render in EcommerceMerchant create forms.",
  "properties": {
    "schemaVersion":         { "type": "integer", "const": 1 },
    "keyVersion":            { "type": "integer", "const": 1 },
    "mpUserId":              { "type": "string", "description": "MP user_id of the seller (= EcommerceMerchant.providerMerchantId)" },
    "accessTokenCiphertext": { "type": "string", "description": "AES-256-GCM ciphertext (base64) of the seller access_token" },
    "refreshTokenCiphertext":{ "type": "string", "description": "AES-256-GCM ciphertext (base64) of the seller refresh_token" },
    "expiresAt":             { "type": "string", "format": "date-time", "description": "ISO timestamp when access_token expires (180 days)" },
    "scope":                 { "type": "string" },
    "liveMode":              { "type": "boolean" },
    "lastRefreshedAt":       { "type": "string", "format": "date-time" },
    "publicKey":             { "type": "string", "description": "Seller publicKey returned by OAuth (passed to the frontend Brick)" }
  }
}'::jsonb,
"updatedAt" = NOW()
WHERE "code" = 'MERCADO_PAGO';
