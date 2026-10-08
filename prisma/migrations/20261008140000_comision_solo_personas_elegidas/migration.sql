-- 🔴 Dinero. D-ELEGIDOS (fase 3 de Pago al personal, aprobado por el founder el 8-oct-2026).
--
-- El panel de comisiones ofrecía «Sólo seleccionados» («La comisión solo aplica a los empleados que agregues»), pero sólo
-- creaba excepciones para los elegidos y el servidor les pagaba a TODOS. El esquema gana a quién aplica, con el mismo patrón
-- que las categorías: `filterByStaff` + `staffIds`. Con `filterByStaff`, SÓLO cobra de ese esquema quien está en la lista.
--
-- Aditivo: los esquemas existentes quedan en «todos» (false, lista vacía) y pagan exactamente lo de hoy. En PostgreSQL 11+
-- agregar una columna con un DEFAULT constante no reescribe la tabla.

-- AlterTable
ALTER TABLE "CommissionConfig" ADD COLUMN     "filterByStaff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "staffIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
