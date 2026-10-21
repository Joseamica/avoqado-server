-- IVA por producto, C1 (ajuste del founder, 7-oct-2026): la configuración del dueño manda.
-- Interruptor por RFC: «Incluir en la factura global las ventas cobradas fuera de la terminal» (efectivo, transferencia,
-- vales y tipos de pago propios). Apagado de fábrica: una venta sin cobros con comercio ya no entra sola a la global.
-- ADITIVA: una columna nueva con default; no toca ningún dato existente.
ALTER TABLE "FiscalEmisor" ADD COLUMN "includeOffTerminalSalesInGlobal" BOOLEAN NOT NULL DEFAULT false;
