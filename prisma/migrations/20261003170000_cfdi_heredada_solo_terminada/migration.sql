-- IVA por producto, D21 (decisión del founder 1-oct-2026, opción A): una factura de la ruta heredada (sin protocoloIva) sólo puede
-- existir terminada. Toda reserva nueva nace con protocoloIva = 1; con esto la ruta vieja ya no puede timbrar ni dejar una venta
-- facturada sin sellar sus renglones. Si alguna base tuviera una heredada sin terminar, esta migración FALLA a propósito: hay que
-- resolverla (terminarla o cancelarla en el PAC) antes de desplegar.
ALTER TABLE "Cfdi"
  ADD CONSTRAINT "Cfdi_heredada_solo_terminada"
  CHECK ("protocoloIva" IS NOT NULL OR "status" IN ('STAMPED', 'CANCEL_REQUESTED', 'CANCELLED'));
