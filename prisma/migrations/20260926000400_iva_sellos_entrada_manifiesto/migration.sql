-- IVA por producto, plan 3: sellos por renglón, entrada documental del intento, protocolo de emisión y manifiesto
-- de la global. Todo aditivo. "OrderItem" es tabla caliente: sólo una columna nullable, sin backfill ni NOT NULL.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "ivaTratamiento" "IvaTratamiento";

ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "entrada" JSONB;
ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "entradaHuella" TEXT;
-- Sin default A PROPÓSITO: una reserva hecha por código anterior al plan 3 queda NULL y el encendido lo detecta.
ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "protocoloIva" INTEGER;
ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "enviadoAt" TIMESTAMP(3);
ALTER TABLE "Cfdi" ADD COLUMN IF NOT EXISTS "falloDefinitivo" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "OrderItemSelloIva" (
  "id" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "cfdiId" TEXT NOT NULL,
  "intento" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderItemSelloIva_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderItemSelloIva_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderItemSelloIva_cfdiId_fkey" FOREIGN KEY ("cfdiId") REFERENCES "Cfdi"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrderItemSelloIva_orderItemId_cfdiId_key" ON "OrderItemSelloIva"("orderItemId", "cfdiId");
CREATE INDEX IF NOT EXISTS "OrderItemSelloIva_cfdiId_idx" ON "OrderItemSelloIva"("cfdiId");

CREATE TABLE IF NOT EXISTS "CfdiGlobalOrden" (
  "id" TEXT NOT NULL,
  "cfdiId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "huella" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CfdiGlobalOrden_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CfdiGlobalOrden_cfdiId_fkey" FOREIGN KEY ("cfdiId") REFERENCES "Cfdi"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CfdiGlobalOrden_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "CfdiGlobalOrden_cfdiId_orderId_key" ON "CfdiGlobalOrden"("cfdiId", "orderId");
CREATE INDEX IF NOT EXISTS "CfdiGlobalOrden_orderId_idx" ON "CfdiGlobalOrden"("orderId");
