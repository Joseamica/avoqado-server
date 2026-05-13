-- Per-venue branding overrides for the public payment-link checkout
-- (pay.avoqado.io). NULL = use defaults; otherwise a JSON object with
-- showLogo / buttonColor / buttonShape / showImage / showTitle / showPrice.
ALTER TABLE "Venue" ADD COLUMN IF NOT EXISTS "paymentLinkBranding" JSONB;
