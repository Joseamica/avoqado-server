-- 🔴 Dinero (auditoría de Codex, 29-sep-2026). `CommissionCalculation.tipAmount` significa ahora «la
-- propina que ENTRÓ a la base de la comisión» (0 si la regla la excluye): el reverso de un reembolso
-- pesa la propina devuelta sólo en la comisión que la incluyó. El código anterior guardaba la propina
-- CRUDA aunque la regla la excluyera; leída con el significado nuevo, devolver toda la venta revertía
-- el 90 % de la comisión en vez del 100 %.
--
-- Normaliza lo que dejó el código anterior: las filas ya materializadas y los efectos del outbox que
-- todavía no se entregan (un efecto DONE ya es una fila, y su foto se conserva tal cual). Idempotente.
-- Medido en producción el 29-sep: 213 filas y 19 efectos, ninguno con propina ⇒ hoy no cambia nada;
-- cubre lo que el código anterior escriba entre hoy y el despliegue.
-- Límite conocido: se juzga con la regla ACTUAL; si alguien cambió «incluir propinas» después de la
-- venta, la fila se lee con la regla nueva (no hay cómo saber la de entonces).
UPDATE "CommissionCalculation" AS fila
SET "tipAmount" = 0
FROM "CommissionConfig" AS regla
WHERE regla.id = fila."configId"
  AND regla."includeTips" = false
  AND fila."tipAmount" <> 0;

UPDATE "PaymentEffect" AS fila
SET payload = jsonb_set(fila.payload, '{tipAmount}', '0'::jsonb)
FROM "CommissionConfig" AS regla
WHERE fila.kind = 'COMMISSION'
  AND fila.status IN ('PENDING', 'PROCESSING', 'DEAD_LETTER')
  AND fila.payload ? 'tipAmount'
  AND regla.id = fila.payload ->> 'configId'
  AND regla."includeTips" = false;
