-- 🔴 Dinero. D-FIJO (fase 3 de Pago al personal, aprobado por el founder el 8-oct-2026).
--
-- Un esquema de comisión FIXED guarda en `CommissionConfig.defaultRate` los PESOS que paga por venta, y el motor copia ese
-- monto a `CommissionCalculation.effectiveRate`. Las dos columnas eran Decimal(5,4): un fijo no pasaba de $9.9999 y uno de
-- $10 desbordaba la columna (500 al guardarlo, o la comisión no se materializaba). Se ensanchan a Decimal(12,4).
--
-- Ensanche sin pérdida: misma escala (4), más precisión. En PostgreSQL subir la precisión de un numeric sin cambiar la escala
-- no reescribe la tabla (sólo toma el candado un instante). Ninguna vista ni regla depende de estas columnas.
-- La API valida por tipo (`tasasDelEsquema.ts`): una tasa va de 0 a 100 %; un monto fijo, de más de $0 a $999,999.99.

-- AlterTable
ALTER TABLE "CommissionConfig" ALTER COLUMN "defaultRate" SET DATA TYPE DECIMAL(12,4);

-- AlterTable
ALTER TABLE "CommissionCalculation" ALTER COLUMN "effectiveRate" SET DATA TYPE DECIMAL(12,4);
