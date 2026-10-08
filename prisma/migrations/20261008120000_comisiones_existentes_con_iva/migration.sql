-- 🔴 Dinero. Fase 3 de Pago al personal, decisión del founder I3 = «A, configurable» (8-oct-2026).
--
-- La fase cambió el significado de `CommissionConfig.includeTax = false`: antes NO restaba nada (el `taxAmount` de la
-- orden suele ser 0, así que se comisionaba sobre lo cobrado, CON IVA); con la fase es «sin IVA» (D5 enmendada) y un
-- esquema del 5 % que comisionaba $5.80 sobre una venta de $116 pasaría a $5.00 sin aviso.
--
-- Para que nadie cobre distinto el día del despliegue, TODOS los esquemas que ya existen quedan «con IVA» (lo que pagan
-- hoy): de sede y de organización, de cualquier tipo de cálculo, activos o no. Los esquemas NUEVOS siguen naciendo
-- «sin IVA» (default de la columna y de `createCommissionConfig`), y cada esquema se cambia desde el dashboard con su
-- interruptor «Calcular con IVA» (el negocio que quiera «sin IVA», p. ej. el que lo pidió, lo apaga tras desplegar).
--
-- Única tabla con esta bandera: `CommissionConfig` (ni las excepciones por persona ni los niveles la tienen).
-- Idempotente: una segunda corrida no encuentra filas. No cambia el schema (sin `schema:map`).
-- Límite conocido: un esquema que el código ANTERIOR cree entre esta migración y el arranque del código nuevo nace con
-- el default (false = «sin IVA»), igual que cualquier esquema nuevo.
UPDATE "CommissionConfig" AS esquema
SET "includeTax" = true
WHERE esquema."includeTax" = false;
