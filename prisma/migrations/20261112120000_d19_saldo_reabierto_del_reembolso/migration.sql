-- D19 (founder 10-nov «A»): un abono devuelto vuelve a deberse. Cuánto, lo fija UNA vez quien escribe el REFUND.
-- Aditiva y nullable: las filas existentes quedan en NULL (= no reabren nada, como hasta hoy).
ALTER TABLE "Payment" ADD COLUMN "reopenedAmount" DECIMAL(12,2);
ALTER TABLE "Payment" ADD COLUMN "reopenedTipAmount" DECIMAL(10,2);
