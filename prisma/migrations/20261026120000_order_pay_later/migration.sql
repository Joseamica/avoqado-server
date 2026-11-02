-- «Pagar después» explícito (founder 26-oct, «como Toast»). Sin default: las filas existentes quedan en NULL y siguen
-- con la regla de antes; sólo el alta del POS lo escribe en true/false.
ALTER TABLE "Order" ADD COLUMN "payLater" BOOLEAN;
