-- Cambio de escala 2->3: reescritura de tabla + ACCESS EXCLUSIVE (~ms con 450 filas en prod).
-- lock_timeout: si el lock no se adquiere en 5s (p.ej. una tx FIFO larga en vuelo), aborta
-- limpio y se reintenta el deploy - nunca se queda encolado bloqueando pagos.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Inventory" ALTER COLUMN "currentStock" SET DATA TYPE DECIMAL(12,3),
ALTER COLUMN "reservedStock" SET DATA TYPE DECIMAL(12,3),
ALTER COLUMN "minimumStock" SET DATA TYPE DECIMAL(12,3),
ALTER COLUMN "maximumStock" SET DATA TYPE DECIMAL(12,3);

-- AlterTable
ALTER TABLE "InventoryMovement" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(12,3),
ALTER COLUMN "previousStock" SET DATA TYPE DECIMAL(12,3),
ALTER COLUMN "newStock" SET DATA TYPE DECIMAL(12,3);
