-- Valida las FK que 20261028100000 creó NOT VALID. VALIDATE toma SHARE UPDATE EXCLUSIVE: lee OrderItem sin frenar las
-- escrituras de las ventas (todas las filas existentes tienen "creditPackId" NULL). Archivo propio: en el mismo archivo el
-- candado del ADD CONSTRAINT seguiría tomado durante la lectura.
ALTER TABLE "OrderItem" VALIDATE CONSTRAINT "OrderItem_creditPackId_fkey";
ALTER TABLE "CreditPackPurchase" VALIDATE CONSTRAINT "CreditPackPurchase_orderItemId_fkey";
