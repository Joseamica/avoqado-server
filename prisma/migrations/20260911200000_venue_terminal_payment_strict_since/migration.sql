-- Aditiva e idempotente. El INTERRUPTOR POR VENUE de la lista blanca estricta de desenlaces (§8 C.1 / I.6).
--
-- NULL = apagado: el venue se sigue rigiendo por el predicado HEREDADO (en vuelo + UNKNOWN), que es exactamente
-- lo que corre hoy en producción. Por eso la columna nace en NULL para TODOS: desplegar no cambia nada, que es
-- la condición del orden de despliegue aprobado (servidor primero, sin que nada nuevo bloquee).
--
-- Una fecha = encendido desde ella. Las solicitudes anteriores a esa fecha se siguen juzgando con el predicado
-- heredado (la «migración acotada por fecha»), porque bloquear las 375 filas históricas dejaría las terminales
-- muertas y la conciliación B —su única salida— todavía no existe.
ALTER TABLE "Venue" ADD COLUMN IF NOT EXISTS "terminalPaymentStrictSince" TIMESTAMP(3);

-- Encendido/apagado SEPARADO del corte (P1-3 de la auditoría de Codex): apagar conserva la fecha, así que
-- reencender no desplaza el corte ni deja descubierto el periodo que ya estaba protegido.
ALTER TABLE "Venue" ADD COLUMN IF NOT EXISTS "terminalPaymentStrictEnabled" BOOLEAN NOT NULL DEFAULT false;
