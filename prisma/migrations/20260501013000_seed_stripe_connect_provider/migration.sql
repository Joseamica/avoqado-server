INSERT INTO "PaymentProvider" ("id", "code", "name", "type", "countryCode", "active", "createdAt", "updatedAt")
VALUES (
  'stripe_connect_provider_mx',
  'STRIPE_CONNECT',
  'Stripe Connect',
  'PAYMENT_PROCESSOR',
  ARRAY['MX']::TEXT[],
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE
SET
  "name" = EXCLUDED."name",
  "type" = EXCLUDED."type",
  "countryCode" = EXCLUDED."countryCode",
  "active" = true,
  "updatedAt" = CURRENT_TIMESTAMP;
