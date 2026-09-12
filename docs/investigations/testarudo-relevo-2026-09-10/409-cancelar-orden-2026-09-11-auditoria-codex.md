# Auditoría Codex — 409 al cancelar orden, 11-sep-2026

Documento revisado: [409-cancelar-orden-2026-09-11.md](./409-cancelar-orden-2026-09-11.md).

**Veredicto:** el diagnóstico de la carrera Android está sustentado; el plan requiere correcciones antes de implementarlo. No retirar la protección del 409. No aprobar A usando CANCELLED de producción como prueba de ausencia de cargo, ni B como cancelación diferida invisible después de un rechazo.

Revisión de código y lecturas de producción; no pruebas ejecutadas, cambios de lógica, limpieza de órdenes, commit, push ni deploy. Este informe es el único archivo creado por esta revisión. El árbol sigue cambiando por otras sesiones; las líneas son las observadas en esta revisión.

## Evidencia comprobada independientemente

- Server HEAD local: `3000f3d0`. Referencia local `origin/main`: `0265daaa`. Verificado el código de cancelación de esta última referencia, sin confundirla con HEAD de develop. No consulté el panel de Render para certificar qué binario está desplegado.
- Android HEAD: `46c5cdc`; iOS HEAD: `b7ad204`; TPV HEAD: `aea0169` (`v2.9.2`). Contrastados los caminos relevantes con el árbol.
- Better Stack source 1720702, tabla `t284025.render_log_stream`, hot + S3, ventana 16:22:40–16:24:00 UTC:
  - DELETE comienza **16:23:04.926684**; termina con **409 en 21.502 ms**.
  - POST cancel comienza **16:23:04.985810**: **59.126 ms después**; termina 200.
  - Long-poll termina 409 a las 16:23:05.002869.
  - Son registros **Request End**, no cierres prematuros.
  - El userAgent sí se pudo consultar: **okhttp/4.12.0**. Identifica la biblioteca HTTP, **no la versión del APK Sunmi**. Esa pregunta sigue abierta.
- Postgres de producción: conexión con `default_transaction_read_only=on`, transacción `BEGIN READ ONLY`, `statement_timeout=12000`; comprobado `transaction_read_only=on`. Credenciales leídas en memoria, nunca impresas.
  - Solicitud `2e183233-3593-47b5-9134-01a59245f054`: CANCELLED / failureCode CANCELLED, sin paymentId; ACK 16:22:49.705 y actualización 16:23:38.011 UTC.
  - Orden `cmtx607hq01qlo82aohazdp79`: CONFIRMED/PENDING, $88, **cero Payment**.
  - Orden `cmtx60x1h01qto82a0hczobxq`: CANCELLED, $80, cero Payment.
  - Orden `cmtx61ctj01r5o82aasn36n1b`: COMPLETED/PAID, un Payment COMPLETED REGULAR por $80 + $8.
  - Recontadas candidatas abiertas/PENDING sin Payment ni solicitud COMPLETED, con solicitud negativa en los 14 días hasta 11-sep 16:39 UTC: **Testarudo 21 / $4,132.25; Amaena 3 / $1,414.00**.
  - Filas que activaría el predicado histórico, al consultar: **PAX 304** (296 CANCELLED + 7 FAILED + 1 TIMED_OUT), **Nexgo Testarudo 53**, **Nexgo Amaena 12**. Las 305 del documento incluían una solicitud en vuelo del corte anterior: no es una discrepancia en el histórico.
- Los timestamps de Postgres se releyeron como `::text`: el parser por defecto de node-pg para timestamp sin zona los presentaba desplazados seis horas al convertirlos a Date en esta Mac. Los horarios arriba son los valores textuales corroborados con Better Stack.

No revalidé todas las líneas de la cronología, el desglose completo de las solicitudes del día ni el portal bancario. Las cantidades de órdenes son candidatas a conciliación, no 24 autorizaciones de cancelación.

## Hallazgos y correcciones necesarias

### P1 — A no puede usar CANCELLED de producción como «no se cobró»

Documento §4.A, línea 133, contradice su propia advertencia de §4.E. En `git show origin/main:src/services/terminal-payment.service.ts`, líneas 980–986, el vigía produce CANCELLED sólo por gracia y ausencia de Payment. La solicitud investigada terminó exactamente así.

Esperar el POST cancel elimina el desorden de transporte; esperar ese CANCELLED no acredita el resultado bancario. Mantener la intención pendiente hasta evidencia del intento, también al hablar con backend antiguo. No convertir un 404, error de red o expiración del polling en permiso para borrar/reautorizar.

El comentario de producción sobre CANCEL_REQUESTED tampoco ofrece una garantía: conciliar después y emitir 🚨 detecta el daño; no impide cancelar una orden cuyo cobro sigue ejecutándose.

### P1 — Cancelar una orden todavía tiene una carrera de servidor

`src/services/mobile/order.mobile.service.ts:3191` lee paymentStatus; `:3219` consulta la reserva; `:3225` actualiza a CANCELLED. Son operaciones separadas, sin transacción ni lock compartido.

Intercalado posible: DELETE lee «sin pagos/sin reserva»; otro proceso admite un cobro para la orden; DELETE la cancela usando su lectura anterior. Otro intercalado permite que un pago se confirme entre la comprobación inicial y el UPDATE de cancelación.

La admisión remota sí bloquea Order en `terminal-payment.service.ts:551`, pero sólo valida paymentStatus=PAID (`:557–565`); no valida status=CANCELLED. El registro de dinero también toma el lock de Order (`payment.tpv.service.ts:2317`).

**Corrección necesaria:** comprobaciones y cancelación bajo el mismo lock de Order que usan admisión/registro, con relectura de pagos y obligaciones dentro de la transacción. La admisión de una autorización NUEVA debe rechazar una orden cancelada. Esto no debe impedir registrar una aprobación bancaria YA ocurrida: ese dinero se registra y se concilia.

Las pruebas actuales de cancelOrder en `tests/unit/services/mobile/order.mobile.service.test.ts:1034` usan mocks; no prueban este intercalado. Una conserva además el nombre obsoleto «CANCEL_REQUESTED ... does not match».

### P1 — B requiere un contrato de cancelación diferida explícito

Responder 409 «no cancelada» y cancelarla después en segundo plano cambia el significado observable para APK antiguos. El cajero puede seguir utilizando esa misma orden, modificarla o iniciar otra operación mientras cree que su cancelación fue rechazada.

No usar ActivityLog como cola de negocio. La regla `.claude/rules/critical-warnings.md:252` mantiene logAction fuera de la transacción y tolera su fallo; no puede ser la única obligación durable.

Si se implementa B como complemento, necesita una entidad/campo operativo durable con intentId, orderId, requestId, actor y revisión o mecanismo equivalente para invalidar la intención al reanudar la venta. Su ejecución requiere las comprobaciones y locks anteriores; idempotencia; estado visible «cancelación pendiente» y confirmación final. Los efectos de referidos, mesa y notificación deben conservarse, con outbox cuando corresponda y bitácora después del commit.

Si el cajero creó OTRA orden, no hay que tocarla ni inferir que sustituye a la primera por monto y proximidad temporal. Si reanudó la MISMA orden, una intención obsoleta no debe borrarla.

**Preferencia:** A corregida + garantía atómica de servidor. B puede dar durabilidad compartida, pero no como atajo invisible «sin APK nuevo».

### P2 — La salida de Android puede ocultar el resultado del DELETE

Además del Thread confirmado en `TerminalPaymentService.kt:548–570`, `PaymentFlowScreen.kt:211–216` llama a `viewModel.cancel()` y a `onCancel()` inmediatamente. Cambiar sólo el servicio a suspend no hace que esa pantalla espere ni que siga mostrando `_cancelFailure`.

`PaymentFlowViewModel.kt:1855–1861` invalida la generación y limpia identidades de UI antes de conocer el resultado. La intención y correlación deben persistirse **antes de la primera petición**, no recién después de que un polling agote su espera. Cubrir muerte del proceso en toda esa secuencia.

`TablesViewModel.kt:358–378` y `:416–430` también envían cancelOrder directamente. El primero muestra rechazo; el masivo lo cuenta como fallo. Dependen de que el servidor proteja la orden de forma atómica.

### P2 — El documento sobrestima la secuenciación de iOS

En HEAD y árbol de `avoqado-ios/Payment/PaymentFlowView.swift:234–244`, el await está dentro de un Task separado; `goBack()` está **fuera**. Por tanto, la navegación no espera al cancel.

Ese callback no envía DELETE, así que no es la misma pareja de peticiones simultáneas de Android. Aun así, no prueba que una cancelación posterior de la orden esté secuenciada con el POST. `PaymentFlowViewModel.swift:1886–1904` borra currentOrderId incluso después de fallar cancelCurrentOrder. Incluir iOS en el contrato y la recuperación durable.

### P2 — Faltan piezas explícitas del contrato de A

El POST cancel actual (`terminal-payment.mobile.controller.ts:409–414`) responde success/mensaje sobre el envío; no devuelve el desenlace financiero ni distingue todas las variantes propuestas en A. El servicio puede registrar la intención y luego no entregar al socket.

El ConflictError del DELETE (`order.mobile.service.ts:3220`) se construye sin code específico; no clasificar cualquier 409 como «cancelación pendiente». GET devuelve cancelDisposition, pero no failureCode; si el cliente necesita TPV_CONFIRMED_NO_CHARGE, definir el contrato aditivo o usar un desenlace canónico cuya semántica esté probada. DTOs Android/iOS deben acompañarlo.

### P2 — «No hubo doble cobro» y «son dos clientes» exceden la evidencia

Dos registros con marcas/últimos cuatro distintos y productos distintos no demuestran dos personas ni excluyen una aprobación del primer intento que todavía no llegó a Avoqado.

La afirmación defendible aquí es: **la primera orden no tiene Payment y la tercera tiene uno; no quedó acreditado un doble cargo bancario en esta revisión**. Para cerrar el desenlace de la primera hace falta su operación en procesador/terminal. No usar sólo monto/hora como identidad.

## C / N3: frontera que sí aceptaría

El diagnóstico sobre el árbol es correcto: el inbox pasa a PROCESSING antes de navegar (`RemotePaymentCoordinator.kt:125`), cancel sólo gana desde RECEIVED (`RemotePaymentInbox.kt:100`), y HomeViewModel ignora el evento de UI (`:1092`).

El CAS propuesto es adecuado sólo si compite contra **toda entrada capaz de mover dinero**, para el mismo intento. No basta «la UI aún no mostró lectura de tarjeta».

- PAX: cubrir autorización online y kernel contactless/offline. Ya hay barreras `markAuthorizing` y `markKernelEntered` en PaymentAttemptLedger (`:115`, `:142`), y cancel desde PREPARANDO (`:327`).
- AngelPay: cubrir tanto SDK integrado como Intent/fallback. `AngelPayPaymentViewModel.kt:723–734` persiste y marca autorización; no basta proteger sólo el Intent.
- Resolver también la ventana PROCESSING sin fila de libreta: ausencia de fila no es evidencia de que nunca hubo ejecución.
- Si gana cancel, persistir el resultado del inbox y su disposición de modo recuperable antes de anunciarlos. Si gana la entrada al SDK, conservar al receptor del resultado y mostrar el aviso; no inventar PRE_AUTHORIZATION.
- Una pantalla pidiendo tarjeta puede pertenecer ya al SDK: «aún no leyó» no habilita por sí solo una cancelación acreditada.

Esto requiere pruebas físicas en ambos fabricantes; no quedó probado aquí.

## Históricos y limpieza

Confirmo el riesgo del predicado histórico y la migración nullable sin backfill. «Declarar» las filas no basta para liberarlas: hace falta conciliación acreditada por intento y persistida, sin rellenar ACCEPTED por antigüedad.

E es insuficiente si «terminaron sin cobro» se deduce sólo del status. Revisar también negativos legacy sin evidencia, no únicamente CANCELLED por gracia. Consultar el procesador cuando falte resultado fiable y comprobar que no quede una ejecución/cola capaz de autorizar. Una ausencia puntual en el portal tampoco garantiza por sí sola que no aparezca después.

Antes de cualquier limpieza: lista exacta de órdenes e intentos con evidencia, relectura y cierre transaccional, preservar trazabilidad y aprobación del founder. **No se hizo limpieza alguna.**

El árbol ya incorpora cambios posteriores a mi revisión previa: procedencia antes de emit y tombstone en la sonda. No los vuelvo a reportar como si siguieran sin corregir; tampoco certifico aquí toda su implementación.

## Pruebas exigibles al implementar

1. Android: invertir deliberadamente la llegada de cancel/DELETE; proceso muerto antes de POST, después del ACK y antes/después de DELETE; sin red; retorno de pantalla y arranque nuevo; misma requestId durable.
2. Postgres real: cancelación contra nueva admisión y contra registro de pago; cancelación solicitada todavía activa; resultado final pagado; pagos parciales; orden cancelada no admite nueva autorización.
3. Backend antiguo: CANCELLED por gracia nunca dispara cierre automático «sin cargo»; 409 ajeno, 404 y error de transporte no se interpretan como evidencia.
4. B, si se adopta: intención obsoleta tras editar/reanudar la orden, duplicado del job, caída antes/después del commit y preservación de efectos de mesa/referidos.
5. PAX y Nexgo: cancel antes de la barrera, carrera con la barrera, kernel/SDK ya activo, aprobación tardía y pérdida de respuestas. Verificar una autorización y un registro por intento.
6. Pruebas de paridad iOS y contratos aditivos. Typecheck/build/suites mediante avq-verify, leyendo su veredicto real. Esta auditoría no ejecutó esas pruebas.

Prioridad propuesta: corregir A y la atomicidad del servidor, resolver N3 con la frontera de dinero, conciliar históricos y validar la convivencia de versiones. Mantener la optimización de latencia fuera de las comprobaciones de autorización del SDK; medir el impacto de cualquier nueva consulta.

