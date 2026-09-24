-- Webhook de Facturapi por emisor (organización). Aditiva: columnas opcionales, sin datos.
ALTER TABLE "FiscalEmisor" ADD COLUMN IF NOT EXISTS "webhookId" TEXT;
ALTER TABLE "FiscalEmisor" ADD COLUMN IF NOT EXISTS "webhookSecretEnc" TEXT;
ALTER TABLE "FiscalEmisor" ADD COLUMN IF NOT EXISTS "webhookUrl" TEXT;
ALTER TABLE "FiscalEmisor" ADD COLUMN IF NOT EXISTS "webhookConfiguredAt" TIMESTAMP(3);
