-- Valida la FK que 20261015090000 creó NOT VALID. VALIDATE toma SHARE UPDATE EXCLUSIVE: lee OrderItem sin frenar las
-- escrituras de las ventas (todas las filas existentes tienen giftCardId NULL).
ALTER TABLE "OrderItem" VALIDATE CONSTRAINT "OrderItem_giftCardId_fkey";
