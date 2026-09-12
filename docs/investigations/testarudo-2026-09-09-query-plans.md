# Consultas de recuperación y trabajos diferidos: PostgreSQL local

9 de septiembre de 2026. Verificación `avq-verify` local `y3nZ7r`, huella `d648467fa8164e94`, 39 s incluida generación del cliente y preparación de datos. No representa latencia HTTP ni tiempos de producción. El árbol compartido cambió durante la corrida; los resultados corresponden al snapshot indicado.

Se insertaron 100 000 filas sintéticas adicionales en cada tabla Order, Payment, TerminalPaymentRequest y PaymentEffect dentro de una transacción exclusiva de este experimento. Se distribuyeron 100 solicitudes UNKNOWN y 10 000 obligaciones PENDING, más el registro semilla. Después de `ANALYZE` se ejecutó `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; al finalizar se revirtió toda la transacción. Una lectura posterior confirmó cero organizaciones sintéticas residuales. Base propia local: `codex_testarudo_test_20260909`; sin escrituras de producción ni cambios en la base compartida.

| Consulta | Filas devueltas | Ejecución local | Plan principal |
|---|---:|---:|---|
| Payment por identidad exacta de solicitud | 1 | 0.032 ms | Índice de identidad JSON y venue |
| Protección de una orden con resultado pendiente | 1 | 0.048 ms | Índice de recuperación por venta |
| Página de obligaciones pendientes | 101, incluido indicador de siguiente página | 0.090 ms | Índice venue/estado/fecha/id |
| Terminales ocupadas, 100 candidatas | 100 | 0.370 ms | Agregado sobre búsqueda por índice |
| Asociación histórica de Payment | 0 | 0.014 ms | Índice de paymentId |
| Página del reconciliador UNKNOWN | 100 | 0.085 ms | Índice de solicitudes activas y ordenamiento |
| Total de obligaciones pendientes | 1 agregado sobre 10 001 filas | 10.056 ms | Bitmap por estado |
| Selección de 25 trabajos con SKIP LOCKED | 25 | 12.953 ms | Bitmap, ordenamiento y bloqueo de las 25 filas |

La última consulta mide selección y bloqueo; no la ejecución de efectos ni el UPDATE completo de reclamación. Conteo y selección examinan el conjunto pendiente, aunque la respuesta y la concurrencia del consumidor sean acotadas. Los datos recién insertados están calientes y tienen una distribución sintética; estos tiempos no constituyen un SLA ni sustituyen las mediciones del negocio después de desplegar. Los tests separados cubren CAS, vencimiento del lease, duplicados y paginación completa.

La primera preparación venció su transacción; la segunda se canceló exclusivamente en el PID del experimento. Ambas quedaron revertidas y no produjeron resultados de rendimiento. El generador repetía la conversión JSON de la fila por cada columna al expandir un valor compuesto. La versión final usa una función en FROM LATERAL, evitando esa repetición conforme a la [documentación de tipos compuestos de PostgreSQL](https://www.postgresql.org/docs/current/rowtypes.html#ROWTYPES-USAGE).

[Evidencia completa de los planes](./testarudo-2026-09-09-query-plans.json). El generador reproducible está conservado provisionalmente en `.superpowers/sdd/testarudo-2026-09-09-implementation/lab-harness/measure-recovery-plans.cjs`.
