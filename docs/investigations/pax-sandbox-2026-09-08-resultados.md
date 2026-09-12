# PAX contactless: resultados de pruebas con fallos controlados

Continuación del 9 de septiembre: [pruebas de chip con y sin corte de Wi-Fi](./pax-chip-2026-09-09-resultados.md). Este documento conserva los resultados de contactless del día 8.

8 de septiembre de 2026, 23:17–23:36 CDMX. Usuario confirmó tarjeta de pruebas fija en contactless y PAX conectada por USB. Pruebas sobre el APK instalado `com.jaac.avoqado_tpv.sandbox` 2.8.7-sandbox (104), cuenta sandbox B de Blumon, venue local Restaurante El Atole. Configuración y SHA-256 del APK en [preparación](./pax-sandbox-2026-09-08-preparacion.md).

**Resultado:** las cuatro ventas sandbox quedaron registradas una sola vez. El reintento tras perder una respuesta conservó la identidad del pago y recuperó el recibo. La cola sobrevivió a la muerte del proceso y pudo registrarse tras reabrir la app y tocar «Reintentar». Sin red antes de iniciar, la app bloqueó la operación antes del SDK.

Estos resultados corresponden a **contactless y Pago rápido**, endpoint `POST /api/v1/tpv/venues/:id/fast`. No son una prueba del chip ni del endpoint `/orders/:id` del incidente original.

## Resultados por escenario

| Importe, sin propina | Escenario realmente ejecutado | Resultado |
|---|---|---|
| $10.00 | Control sin fallos | Una autorización, un Payment, orden PAID, saldo cero, un recibo y QR visible |
| $10.01 | Segundo control: la primera versión del filtro de inyección no se activó | Misma verificación correcta. Se conserva como control adicional, **no** como prueba de pérdida de respuesta |
| $10.02 | Se reenvió el POST, se recibió íntegramente el 201 del servidor y se destruyó la conexión hacia la PAX sin entregárselo | Dos POST con la misma clave y el mismo hash de cuerpo; sólo una autorización del SDK, un Payment y un recibo. El segundo POST recuperó el QR |
| $10.03 | Se descartaron los POST de registro antes de reenviarlos al servidor; Blumon siguió accesible | Host aprobado; tras cinco intentos, libreta `ENTREGADA_A_COLA` y fila Room persistida. Un worker inmediato realizó otros cinco intentos. Se cerró el proceso, se verificó la persistencia, se levantó el bloqueo y se reabrió la app. «Reintentar» registró el pago sin nueva autorización |
| $10.04 propuestos | Wi-Fi y datos móviles apagados antes de tocar Tarjeta | Mensaje «Sin conexión a internet. ¿Cobrar en efectivo?». No hubo marcador de inicio SDK, nueva fila de libreta ni Payment por ese importe en la ventana. Se canceló la pantalla sin cobrar efectivo |

Se autorizaron **$40.06 en sandbox**, repartidos en cuatro ventas. No hubo reembolsos ni operación financiera en producción.

## Tiempos medidos

Diferencias entre marcadores del mismo logcat y reloj del dispositivo; no se restaron timestamps del teléfono a timestamps de la Mac. Se observó aproximadamente un segundo de diferencia entre ambos relojes durante el recorrido.

| Venta | AUTORIZANDO → HOST_RESPONDIO | Inicio de registro → recibo en estado Success | PREPARANDO → recibo |
|---|---:|---:|---:|
| $10.00 | 1 332 ms | 768 ms | 4 083 ms |
| $10.01 | 1 867 ms | 248 ms | 3 485 ms |
| $10.02, primera respuesta perdida | 1 113 ms | 1 050 ms | 3 528 ms |

Para $10.03, autorización: **953 ms**; inicio de registro → entrega a cola: **7 899 ms**. El recibo no podía existir todavía en esa primera pantalla, porque los POST se descartaban antes del backend.

En el proxy de $10.02, el primer POST obtuvo 201 en 332.367 ms, se perdió su respuesta y el siguiente POST obtuvo 201 en 46.045 ms. Esos tiempos abarcan la respuesta completa del servidor local, no sólo el commit. El primer cuerpo ya estaba completo antes de cortar el socket del cliente.

## Evidencia durable y verificación final en PostgreSQL real

Consultas de sólo lectura en PostgreSQL local `av-db-25`, filtradas por venue y claves explícitas, límite de 10 filas y timeout de 5 segundos. Las aserciones finales verificaron cuatro claves distintas, cuatro Payments COMPLETED con importes exactos, propina cero, órdenes PAID con saldo cero, un DigitalReceipt y un VenueTransaction por Payment.

| Importe | attemptId / idempotencyKey | Payment |
|---|---|---|
| $10.00 | `b1dade38-465c-4dfd-b1f6-6d78efb6fb80` | `cmttnga81004pc9uemwxt765q` |
| $10.01 | `7ec22f25-6868-45d6-9bfc-eb73e4de68be` | `cmttnmjrq0055c9ueujnqxwia` |
| $10.02 | `77dad76a-57fa-4b96-baea-69c8283713ba` | `cmttnphnb005lc9ueol1aneqc` |
| $10.03 | `18c75a23-3fea-4275-ad8a-8889683e365f` | `cmttnu6il0061c9ueq2i0c40j` |

Para $10.03, después de `am force-stop` y **antes** de recuperar:

- PostgreSQL: cero Payments para esa clave.
- Room: libreta `ENTREGADA_A_COLA`, `host_approved=1`, `amount_cents=1003`, `tip_cents=0`, ruta FAST, operación sandbox `81784` y referencia `429373244975`.
- Cola: fila 1, `PENDING`, importe `10.03`, propina `0.00`, misma clave y cuenta B, `retry_count=1`.

Después de recuperar y volver a comprobar Room con la app detenida: fila 1 en **SUCCESS**. La libreta conserva `ENTREGADA_A_COLA`; no se reporta falsamente como REGISTRADO. PostgreSQL tiene el único Payment y recibo indicados. Los tres intentos abiertos anteriores a esta sesión permanecieron sin cambios.

Al reabrir la app apareció el banner «1 pagos pendientes». No se observó drenado inmediato durante los aproximadamente 45 segundos hasta tocar «Reintentar»; después se sincronizó. Esta prueba acredita **recuperación manual tras reinicio**, no el plazo del worker periódico ni recuperación automática inmediata.

## Hallazgo adicional: se multiplican los reintentos HTTP

El bloqueo de $10.03 produjo **10 POST descartados** antes del reinicio: cinco del registro inicial y otros cinco del worker inmediato. Los logs sitúan `Payment Sync / Worker started`, claim e inicio de sincronización justo después de `ENTREGADA_A_COLA`. `PaymentSyncWorker` llama a `RecordPaymentUseCase`, que vuelve a aplicar su presupuesto de cinco intentos.

Después del reinicio y el toque manual hubo un undécimo POST, que sí llegó al servidor. Todos conservaron `idempotencyKey` e importe. El cuerpo reconstruido por la cola tiene un hash diferente del cuerpo inicial; no se afirma que ambas rutas envíen JSON idéntico. El reintento del caso $10.02, en cambio, sí conservó el mismo hash de cuerpo.

No se observó otra autorización del SDK al sincronizar. El hallazgo es multiplicación de carga HTTP y de espera ante un fallo persistente; no evidencia de duplicación de autorización en esta prueba.

## Instrumentación y límites

- Proxy temporal propio, sólo loopback `127.0.0.1:18799`, upstream local 3000, inyección limitada al venue de laboratorio, importe esperado, ruta de registro y misma clave. No se cambió el proxy existente de otra sesión ni su bitácora.
- Se escribieron primero dos pruebas del proxy. Tras detectar que la API transmite centavos, se corrigieron los fixtures al contrato real: ambas pruebas fallaron, se corrigió el filtro y ambas pasaron. Esto comprueba el instrumento de laboratorio; no es la suite del módulo de pagos.
- El primer lanzamiento del proxy también requirió corregir la comparación de ruta `/tmp` frente a `/private/tmp` de macOS. No se inició ninguna autorización durante ese ajuste.
- Logs capturados por PID y posteriormente por UID del paquete sandbox, sin limpiar logcat, guardando sólo marcadores, identidades de intento y metadatos seleccionados. Las copias temporales de Room se hicieron con el proceso detenido, incluyendo WAL/SHM cuando existían, y se eliminaron después de extraer los campos necesarios.
- `am force-stop` prueba persistencia tras muerte del proceso Android; no simula una caída de Postgres ni del servidor a mitad de su transacción. El corte posterior al commit se probó perdiendo la respuesta HTTP, sin matar el servidor.
- No se midieron comisiones, lealtad ni entrega duplicada de un outbox nuevo. No se implementó ese refactor. Tampoco se probó chip, corte durante autorización Blumon, ni consulta de historial después de un resultado incierto del procesador.
- Las autorizaciones de estas pruebas se observaron en respuestas del SDK y en la libreta; no se obtuvo un corte independiente del portal sandbox. No equivalen a liquidaciones reales.

No se modificó código de ejecución en TPV o servidor, ni se instalaron APK. No corresponden typecheck/build/suite de cambios de aplicación; no se reportan como ejecutados. Cualquier refactor monetario posterior mantiene la exigencia de TDD, integración transaccional contra Postgres real, `avq-verify` y auditoría.

## Estado final del laboratorio

Wi-Fi y datos móviles restaurados a su estado inicial, ambos encendidos. Túnel de la PAX restaurado a `tcp:8799 → tcp:8799`. Proxy temporal propio detenido y app sandbox reabierta. No se limpiaron los pagos de prueba ni los intentos anteriores. Sin push ni despliegue.

Evidencia local seleccionada en `/tmp/codex-testarudo-20260908/`: `contactless-control-markers.jsonl`, `contactless-recovery-markers.jsonl`, `fault-proxy-events.jsonl`, `worker-window.json`, `queue-after-process-death.json`, `room-final.json` y `final-postgres-assertions.json`. El campo `amountCents` de los tres primeros eventos del proxy correspondientes a $10.01 pertenece al filtro defectuoso inicial y muestra 100100: **no representa el importe cobrado**, que fue $10.01 y quedó verificado en Postgres. Los eventos de las pruebas posteriores usan centavos correctamente.
