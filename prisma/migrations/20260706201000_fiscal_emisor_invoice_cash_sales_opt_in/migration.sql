-- FiscalEmisor.invoiceCashSales: opt-in (default false) for whether CASH sales may be invoiced at all
-- (customer self-invoice QR / Flow A AND the month-end factura global / Flow C). Most venues do not
-- declare cash income, so cash is left uninvoiced unless the venue explicitly turns this on.
-- ADD COLUMN ... DEFAULT false sets every existing emisor to false — no separate data update needed.
ALTER TABLE "FiscalEmisor" ADD COLUMN "invoiceCashSales" BOOLEAN NOT NULL DEFAULT false;
