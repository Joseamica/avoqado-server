-- Seed Mercado Pago as a payment provider for Mexico.
--
-- Marketplace flow via Checkout Bricks (Split Payments 1:1). Sellers (venues)
-- authorize Avoqado via OAuth and keep their negotiated rates. Avoqado collects
-- a configurable `application_fee` on each /v1/payments call.
--
-- The configSchema describes the JSON shape Avoqado stores in
-- EcommerceMerchant.providerCredentials after the OAuth flow completes.
-- See src/services/mercado-pago/types.ts → MercadoPagoCredentials.
INSERT INTO "PaymentProvider" (
  "id",
  "code",
  "name",
  "type",
  "countryCode",
  "active",
  "configSchema",
  "createdAt",
  "updatedAt"
) VALUES (
  'c49mn9cbt3qbjg5jq9eeyahr',
  'MERCADO_PAGO',
  'Mercado Pago',
  'PAYMENT_PROCESSOR',
  ARRAY['MX'],
  true,
  '{
    "type": "object",
    "required": [
      "schemaVersion",
      "keyVersion",
      "mpUserId",
      "accessTokenCiphertext",
      "refreshTokenCiphertext",
      "expiresAt",
      "publicKey"
    ],
    "properties": {
      "schemaVersion":          { "type": "integer", "const": 1 },
      "keyVersion":             { "type": "integer", "const": 1 },
      "mpUserId":               { "type": "string" },
      "accessTokenCiphertext":  { "type": "string" },
      "refreshTokenCiphertext": { "type": "string" },
      "expiresAt":              { "type": "string", "format": "date-time" },
      "scope":                  { "type": "string" },
      "liveMode":               { "type": "boolean" },
      "lastRefreshedAt":        { "type": "string", "format": "date-time" },
      "publicKey":              { "type": "string" }
    }
  }'::jsonb,
  NOW(),
  NOW()
) ON CONFLICT ("code") DO NOTHING;
