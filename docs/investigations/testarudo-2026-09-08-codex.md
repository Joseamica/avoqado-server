# Testarudo: investigación de cobros y terminales — 8 de septiembre de 2026

Investigación de Codex, realizada en la noche del 8 de septiembre de 2026. Horas del negocio en `America/Mexico_City` (UTC−06:00). Consulta de producción en modo de sólo lectura, con límites de filas y timeouts. No se cambiaron pagos, órdenes ni configuraciones de producción, ni código de ejecución; no hubo push ni despliegue. Después se preparó la PAX de laboratorio y, con USB y tarjeta de pruebas confirmados por el usuario, se ejecutaron [pruebas sandbox de contactless, pérdida de respuesta y recuperación tras reinicio](./pax-sandbox-2026-09-08-resultados.md).

**Actualización posterior del 9-sep, tras investigar Android→TPV:** se recuperó una [traza más concreta de ambos casos](./testarudo-2026-09-09-android-tpv-relay.md). Para $319, TerminalLog registra GenericFailure de SaleIcc después de la primera aprobación y otro PreTrans bajo el mismo attemptId; esto reduce la incertidumbre anterior sobre el segundo intento. Para $308, el socket Nexgo se desconectó 500 ms después del envío; el servidor bloqueó otros cobros remotos hasta AUTO_RELEASED casi 26 minutos después. Las limitaciones de las secciones históricas deben leerse con esta actualización; no se ha identificado la excepción interna del GenericFailure ni la causa física de la desconexión.

## Hallazgo prioritario: dos autorizaciones de $319

**Actualización del 9 de septiembre:** los [CSV de ambos portales, cruzados con producción](./testarudo-2026-09-09-conciliacion-portales.md), confirman 167 aprobaciones Blumon de Testarudo frente a 166 Payments coincidentes; la única faltante es la primera operación de $319. Las 73 ventas exportadas de AngelPay coinciden por referencia e importe con 73 Payments. No aparece $308 ni $280 en el CSV AngelPay. Los archivos no acreditan liquidación ni reversos posteriores; sigue pendiente el corte/detalle de las dos operaciones de $319.

Hay evidencia de **dos autorizaciones aprobadas de Blumon por $319**, separadas por 98 segundos, pero un único Payment registrado en Avoqado. Es un **posible doble cobro**, no una confirmación de doble liquidación. Este caso no es ninguna de las cuatro órdenes originales del expediente.

| Evidencia | Primera autorización | Segunda autorización |
|---|---|---|
| Fecha y hora CDMX | 08/09/2026 14:00:15 | 08/09/2026 14:01:53 |
| Terminal | PAX 2841653112 | PAX 2841653112 |
| Importe total | $319.00 | $319.00 |
| Operación Blumon | 24237797 | 24237873 |
| Referencia del procesador | 20260908150012 | 20260908150111 |
| hostResponse del portal | 288563190332 | 962061836893 |
| Autorización | 06875D | 01993D |
| Respuesta | 00 / APROBADA | 00 / APROBADA |
| ProviderEventLog | PENDING, sin Payment vinculado | PROCESSED, vinculado al Payment |

Coinciden BIN, últimos cuatro dígitos, marca, banco y titular entre los dos webhooks. Los valores de tarjeta y titular se omiten del informe. Esa coincidencia refuerza la hipótesis de reintento de una misma tarjeta, aunque no es una identidad criptográfica de tarjeta.

El portal Element de Blumon muestra ambas ventas aprobadas. Los webhooks de producción corroboran los mismos importes y autorizaciones. La consulta acotada de eventos Blumon de Testarudo del día no devolvió eventos de reverso/cancelación; esto sólo describe los eventos recibidos, no acredita que el procesador jamás haya revertido o vaya a liquidar ambos cargos.

- Orden registrada: `ORD-1788897607207`, id `cmtt3g3sh072hnb2bv9s74m85`.
- Una sola solicitud POS→TPV: `39176505-33c1-49f5-9c75-ce652c9e24cb`, creada a las 14:00:07 y completada a las 14:01:54.
- Único Payment por $319 encontrado en Testarudo ese día: `cmtt3ievm073qnb2bk5huz7o5`, $290 + $29 de propina, autorización `01993D`, referencia `962061836893`.
- Productos de esa orden: chocolatín, flat white, latte vainilla y matcha cloud; una unidad de cada uno.
- Primer webhook: `cmtt3gazt072xnb2bo8cag1mc`; segundo: `cmtt3ieeu073onb2boora1bk5`.
- Better Stack todavía mostraba la reconciliación del primer webhook pendiente, sin Payment encontrado, alrededor de las 21:32 CDMX.

**Acción operativa necesaria:** conciliar las dos operaciones con el corte/estado de Blumon. Si ambas están vigentes, resolver el duplicado mediante el flujo de conciliación/reembolso autorizado. No inventar un segundo Payment ni reembolsar automáticamente con esta evidencia incompleta. No se ejecutó ninguna de esas acciones.

La cronología es compatible con una primera autorización cuya respuesta no se registró y un segundo intento; no recuperé una traza terminal completa que demuestre exactamente qué provocó ese segundo intento.

**Actualización tras reconectar Better Stack:** en la ventana 13:59–14:04 CDMX, el primer POST de registro que aparece para esa orden comenzó a las 14:01:54.842, después de la segunda autorización. Respondió 201 en **363.274 ms**, correlación `f98ff1bb-2573-4d68-b22f-590d688431bd`. La solicitud POS→TPV se emitió una vez a las 14:00:07.417. No aparece un POST de registro de la primera autorización en esa ventana. Esto sitúa la incertidumbre antes del registro observado en Avoqado; la latencia de ese POST no explica los dos cargos autorizados. No demuestra por sí solo qué hizo el SDK o el cajero entre ambos.

## Las cuatro órdenes del texto de Claude

Las cuatro originales seguían `CONFIRMED / PENDING`, con `paidAmount = 0`, al consultarlas. El texto original mezclaba UTC con hora local: por ejemplo, la venta A es de las **08:07 CDMX**, no de las 14:07.

| Caso | Orden original y hora CDMX | Evidencia posterior | Conclusión que sí permiten los datos |
|---|---|---|---|
| A · $77 | `ORD-1788876430402`, 08:07:10 | Solicitud PAX cancelada a las 08:08:08, sin resultado ni pago en esa orden. No se identificó una venta rehecha cercana. | Destino de esa venta sin aclarar. Preguntar por el latte de $70 + $7; no asumir ni entrega gratuita ni cobro. |
| B · $247.50 | `ORD-1788882485234`, 09:48:05 | Nueva orden `ORD-1788882515132` a las 09:48:35; pago Nexgo a las 09:48:53. Webhook AngelPay aprobado, transacción `260908095256`, autorización `05480I`. | Una venta rehecha es una inferencia fuerte: mismos productos, cantidades, importes y nota `m9`. Hay una aprobación AngelPay vinculada a la nueva orden. |
| C · $80 | `ORD-1788899460700`, 14:31:00 | Nueva orden `ORD-1788899557541` a las 14:32:37, Payment CASH de $80. Ambas tienen el mismo latte y total. | Efectivo registrado en otra orden; la recepción física del dinero sólo puede confirmarla el negocio. |
| D · $308 | `ORD-1788902050542`, 15:14:10 | Solicitud Nexgo sin resultado, luego `TIMED_OUT / AUTO_RELEASED`. Nueva orden `ORD-1788902108696` a las 15:15:08, Payment CASH de $280 + $28. Coinciden los cuatro productos y cantidades. | Venta rehecha en efectivo muy probable. No hay webhook AngelPay de $308 ni $280 en la ventana consultada; falta el corte para descartar un cargo cuya notificación no llegó. |

Para B, C y D cotejé las líneas de producto, no sólo el importe. El cierre de las originales requiere confirmar la relación operativa y usar el flujo normal con bitácora. No las cancelé.

No encontré un doble cobro demostrado en esas cuatro. **Eso no permite afirmar que en Testarudo no hubo dobles:** el caso adicional de $319 necesita investigación financiera inmediata. Tampoco demuestra la frase «la tarjeta no pasó» cuando sólo conocemos una cancelación local, timeout o ausencia de webhook.

## PAX: DNS confirmado, causa del atasco sin demostrar

Crashlytics confirma fallos de resolución de `api.avoqado.io` y `firebasestorage.googleapis.com` en la PAX de Testarudo con 2.8.7 (104), durante el tramo de aproximadamente 11:54–13:15 CDMX. Una consulta posterior de otro evento de Socket.IO devolvió otra terminal/venue y fue excluida; no se mezclaron clientes.

Los breadcrumbs muestran llamadas a `StartEmvTrans`, selección de aplicación de chip y respuesta a esa selección. El antiguo problema documentado de no responder la selección de aplicación ya tenía una corrección; no hay evidencia para atribuirle automáticamente este incidente.

`PIN incorrect or error: null` no prueba un PIN incorrecto: el consumidor escribe ese mensaje para cualquier valor distinto de cero, incluido `null`. Tampoco una custom key de fase, conservada en Crashlytics, prueba por sí sola la fase exacta del bloqueo actual. La contradicción entre seriales tiene un defecto documentado: `app_terminal_serial` captura `TerminalConfig.DEFAULT_SERIAL` al arrancar, antes de cargar la terminal real. Para atribuir los eventos se deben usar `terminal_id` y `venue_id`, cotejados con el snapshot del SDK; no el serial inicial congelado.

La fase de chip ocurre antes de la autorización online y antes del POST que registra el pago en Avoqado. Acelerar ese POST no destraba un kernel detenido en chip. El detector de 45 segundos informa; no demuestra recuperación ni garantiza interrumpir una llamada nativa. Su efecto depende de la pantalla y se reinicia al cambiar el estado observado.

**Reproducción de laboratorio del 9 de septiembre:** un control con chip se aprobó y registró en 319 ms desde el inicio del registro hasta el recibo, mientras chip/PIN consumió 9.335 s. Al cortar Wi-Fi en StartEmvTrans, el chip también terminó; después falló DNS de `sandbox-core.blumonpay.net`, sin POST de registro. No se reprodujo el bloqueo. El control exitoso también emitió dos veces `PIN incorrect or error: null`, confirmando que ese texto no demuestra un PIN incorrecto. Alcance, estados durables y límites en [resultados de chip](./pax-chip-2026-09-09-resultados.md).

No hay evidencia suficiente para decir «el DNS causó el atasco del chip» ni «cambiar a 8.8.8.8 lo arregla». Se necesitan tiempos por fase, correlacionados por intento, y reproducción en aparato. No cambié DNS ni activé cellularFailover.

## AngelPay: el diagnóstico es válido en parte y omite un mecanismo existente

Comparación sobre el commit publicado `aea0169507e3c8f62ca02121e8f79cef7d78485a` de TPV y el tag PAX `v2.8.7`. El árbol de trabajo tenía cambios de otras sesiones para clasificación de resultados y fases; no los consideré ya publicados ni los modifiqué.

Los AAR AngelPay 1.0.17 y 1.0.18 son binarios distintos. El 1.0.18 contiene presupuesto de 180 segundos y límite de 15 segundos en la retirada de tarjeta. Esto no prueba en aparato que ninguna ruta pueda quedar bloqueada: algunos relojes son cancelación cooperativa.

**Corrección importante:** ambos SDK, 1.0.17 y 1.0.18, ya contienen `verify_in_doubt` y consulta de historial por referencia. Inspeccioné bytecode con `javap`; la decompilación de Java tuvo errores, por lo que las conclusiones se basan en las instrucciones JVM.

En el orquestador 1.0.18 (`b0.s`), el método de verificación:

1. Se activa para ciertas clases de error y si hay referencia; no para todo resultado negativo.
2. Consulta historial y busca una operación con esa referencia.
3. Si encuentra estado `APROBADA`, reconstruye una aprobación.
4. Si la consulta falla o no aparece la referencia, deja el resultado sin aprobación y marca duda. Esa marca se convierte en código **G505**, aun con estado exterior `DECLINED`.

En el commit publicado, `onAngelPaySdkResult` usa `approved=false` para marcar el intento como descartado, salvo la excepción de sesión expirada. Luego imprime ticket de rechazo, permite reintentar y emite fallo al POS. Por tanto, **no basta con corregir únicamente U101**: un resultado G505 cuya consulta no pudo confirmar el cobro también debe conservar la incertidumbre. Que el SDK consulte una vez no proporciona reconciliación durable tras reinicio o pérdida persistente de red.

Evidencia binaria reproducible: SHA-256 AAR 1.0.17 `b3f9514e2b5dec1eec31108cf38cb61e9982bf7a01a8fa79daab2b33993d5034`; 1.0.18 `ae7d0e063be784a55c5ad2bd40482adee45b5a347995ddb5de8abb2c9b33a02b`.

## Servidor: medición actualizada tras reconectar el MCP de Better Stack

Revisión de `develop`, HEAD `d33f4ad2`. El endpoint de órdenes entra en `recordOrderPayment`, no debe confundirse con el flujo independiente de `recordFastPayment`.

La primera investigación no pudo extraer la distribución histórica. Después, a petición del usuario, ejecuté `codex mcp login betterstack`; el login terminó correctamente y comprobé que las herramientas del MCP ya responden. Las mediciones de esta sección sustituyen la limitación anterior.

Consulté `s3Cluster(primary, t284025_render_log_stream_s3)`, sólo filas de logs, host `avoqado-server`, método POST y la ruta exacta de registro de pago sobre órdenes de Testarudo, excluyendo subrutas. Periodo solicitado: 05/09 00:00 a 08/09 21:00 CDMX; el 5 ya no está disponible porque la retención de logs es **3 días**. Los resultados disponibles cubren los días 6, 7 y 8. Percentiles con `quantileExact`, agrupados por día CDMX. La consulta queda en `testarudo-2026-09-08-latency.sql` junto a este informe.

| Día | Evento HTTP | Solicitudes | p50 | p95 | Máximo |
|---|---|---:|---:|---:|---:|
| 6 sep | Request End | 130 | 533.930 ms | 9 767.491 ms | 10 008.882 ms |
| 6 sep | Request Closed Prematurely | 91 | 9 990.044 ms | 10 033.561 ms | 10 224.603 ms |
| 7 sep | Request End | 115 | 405.850 ms | 705.134 ms | 1 221.752 ms |
| 8 sep | Request End | 99 | 430.056 ms | 823.885 ms | 1 494.070 ms |

No aparecieron `Request Closed Prematurely` en el endpoint acotado los días 7 y 8. El día 6 hubo dos respuestas 5xx; los días 7 y 8, ninguna. Son solicitudes, no necesariamente ventas distintas. `Request End` acredita finalización del lado del servidor, no recepción física por la PAX.

**El p95 de varios días mezclaba estados operativos diferentes.** Las memorias documentan la ruta externa de Postgres y el cambio a la interna durante la noche del 6; la reducción sostenida de los días 7 y 8 es consistente con ese cambio. No hay evidencia en esta ventana de que el endpoint siga tardando 10 segundos el día 8.

Separé por correlación las solicitudes que alcanzaron `VenueTransaction created for payment` de las que no tienen ese marcador:

| Día | Con creación: respuestas completas / cortes | p50 / p95 de respuestas completas con creación | Mediana desde entrada al servicio hasta marcador de creación | Mediana desde creación hasta `Payment recorded successfully` |
|---|---:|---|---:|---:|
| 6 sep | 28 / 91 | 9 671.207 / 9 938.485 ms | 2 722 ms | 7 011 ms |
| 7 sep | 115 / 0 | 405.850 / 705.134 ms | 106 ms | 259 ms |
| 8 sep | 99 / 0 | 430.056 / 823.885 ms | 108 ms | 266 ms |

El 6 hubo otras 102 respuestas sin marcador de creación: p50 503.685 ms / p95 678.883 ms. Una consulta adicional encontró **100 logs explícitos de reintento idempotente** en el servicio de pagos de órdenes de Testarudo ese día. Por tanto, la mediana general cercana a medio segundo ocultaba la lentitud de las altas nuevas. No interpretar ausencia de marcador, por sí sola, como prueba de replay.

Los tiempos hasta el marcador de creación incluyen validaciones previas y la primera transacción; no son una medición aislada de duración de la transacción. El último marcador tampoco incluye todo el armado final de respuesta.

### Desglose observado de una solicitud lenta del día 6

Correlación `ec81b20f-9ab8-42c0-b9be-fcaf1f28323f`, orden `cmtpyn93c0141p12a456q3a8h`, 09:22 CDMX. Diferencias entre timestamps de logs del mismo request:

| Tramo observado | Tiempo |
|---|---:|
| Inicio HTTP → entrada a `recordOrderPayment` | 178 ms |
| Entrada al servicio → marcador posterior al primer commit | 2 827 ms |
| `Creating TransactionCost` → Payment/VenueTransaction actualizados con fees | 1 822 ms |
| Generación de recibo digital | 703 ms |
| Emisión de PAYMENT_COMPLETED → fin del bloque de actualización de orden | 4 263 ms |
| Fin de ese bloque → cierre prematuro observado | 430 ms |

Dentro del bloque de orden, la validación de disponibilidad de inventario consumió aproximadamente 1 046 ms; desde esa validación hasta el log de saldos actualizados, 991 ms; los logs de inicio/fin de deducción de inventario abarcaron 468 ms. Son subtramos, **no se suman otra vez** al bloque de 4 263 ms. El resto incluye otras consultas y huecos entre marcadores; no hay timer suficiente para atribuir cada milisegundo a lealtad, referidos o autofactura. El log de comisión del vendedor aparece intercalado, pues corre concurrentemente; no se suma como tramo secuencial.

Este ejemplo demuestra trabajo posterior al primer commit en el incidente histórico. No demuestra que el mismo costo persista después del cambio de ruta de Postgres ni que todo ese trabajo pueda diferirse sin conservar las invariantes de dinero y orden.

Lo comprobado en el código:

- `requestLogger.ts` ya distingue `Request End` y `Request Closed Prematurely`; ambas clases llevan `durationMs`. Una consulta que las mezcle no mide sólo latencia de respuestas entregadas. Un `finish` del servidor tampoco acredita recepción por la PAX.
- `recordOrderPayment` tiene hitos acumulativos `elapsedMs`, pero no tiempos individuales de todos los pasos. `PhaseTimer` detallado está en `recordFastPayment`.
- La primera transacción guarda el Payment y otros registros de dinero. Los saldos y el estado PAID de la orden se actualizan después, en otra transacción; esa segunda transacción también enlaza el asiento de inventario. No es correcto responder inmediatamente tras el primer commit sin resolver esas invariantes.
- Las comisiones ya se invocan sin `await` mediante `.catch(...)`. Por eso «85 sentencias posteriores, todas esperadas por la respuesta» es una simplificación incorrecta. Trabajo concurrente puede generar carga, pero no se atribuye como tiempo secuencial sin medirlo.
- Lealtad ya tiene un reconciliador durable y acotado, con `loyaltyEligibleAt`, claims y reintentos. Debe conservarse su integración; no partir de «lealtad no tiene respaldo durable». El marcador nace cuando la orden se marca pagada, no meramente cuando existe el Payment.
- `resolveAutofacturaAvailable` consulta disponibilidad; no es emitir una factura. Es parte del contrato de respuesta del recibo.
- Recibos y comisiones necesitan idempotencia respaldada por la base: sus índices actuales por Payment no equivalen a una restricción única que impida entrega duplicada.

Frontera propuesta, sujeta a medición y pruebas antes de implementar:

| Antes de responder | Trabajo diferible con respaldo durable |
|---|---|
| Pago persistido, identidad idempotente, montos/propinas, asignaciones y reconciliación del resultado del intento | Entrega/enriquecimiento del recibo, cálculo de comisiones y solicitudes de reseña |
| Orden con saldo/estado coherentes y marcadores/asientos necesarios para no perder ni duplicar inventario | Efectos de lealtad y referidos, integrados con su reconciliación existente |
| Outbox creado en la misma transacción que la obligación que representa | Emisión fiscal si corresponde a un flujo real de emisión; no confundirla con el lookup de disponibilidad |
| Campos y significado de respuesta que siguen usando los APK publicados; cierre/cajón consistente con los lectores actuales | Notificaciones y otros efectos externos idempotentes |

Para el recibo, conservar sólo las claves JSON y devolver `null` no garantiza compatibilidad funcional: los APK existentes pueden perder el QR. Hay que preservar un recibo mínimo durable y utilizable por el contrato viejo, o mantener su generación síncrona hasta introducir una capacidad explícita compatible. El APK revisado tolera `null`; eso no significa que el usuario conserve el mismo recibo.

Reutilizar [customerApprovalOutbox.service.ts](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/reservation/customerApprovalOutbox.service.ts): `FOR UPDATE SKIP LOCKED`, lote acotado, lease, incremento de attempts al reclamar y CAS al finalizar. **La entrega es al menos una vez**: el efecto de cada consumidor necesita clave única/operación idempotente propia, incluida la caída después de aplicar el efecto y antes del ACK del job.

La regla del repo exige `logAction` fuera de las transacciones. Un outbox o marcador financiero durable no es esa bitácora auxiliar. Hay un registro de conciliación `PAYMENT_WITHOUT_SHIFT` dentro de la lógica de dinero: si se cambia, debe preservarse su función durable, no eliminarse por tratarlo como un log prescindible.

Medición todavía necesaria para un refactor: aislar espera del pool y duración de la transacción de las validaciones previas, poner timers en los pasos sin marcadores y observar volumen suficiente con la ruta interna actual. Ya se separaron eventos HTTP, días y solicitudes con creación; el desglose histórico usa logs existentes y no sustituye timers completos por paso. No sumar latencias de sentencias ejecutadas en paralelo.

Antes de un refactor monetario: TDD estricto, Postgres real para caída antes/después del commit, recuperación de lease, entrega duplicada y consumidor que cae tras su efecto; aserciones de Payment, saldos, inventario, recibo y efectos sin duplicados. Suite del módulo y typecheck por `avq-verify`, seguidos de auditoría. **Nada de esto se reporta como ejecutado en esta investigación de sólo lectura.**

## Referencias y límites

- Memorias iniciales: `pax-registro-del-cobro-vs-timeout-10s.md` y `testarudo-terminales-trabadas-2026-09-08-diagnostico.md`, leídas como contexto y contrastadas con el estado observado.
- PostgreSQL de producción: Payment, Order, OrderItem, TerminalPaymentRequest y ProviderEventLog de Testarudo; extracciones acotadas hasta aproximadamente las 21:40 CDMX. La extracción completa de webhooks del día devolvió 107 filas, por debajo del límite de 200.
- Portal [Element de Blumon](https://element.blumonpay.net/transacciones): comprobación visual de las dos ventas de $319; no se obtuvo un corte de liquidación ni acceso al corte de AngelPay.
- Crashlytics: app Android de producción, issue DNS `dd82e1c1e0018d6889e7de453bd221c5`, muestras de PAX 2.8.7. Las muestras disponibles no equivalen a una traza exhaustiva de cada intento.
- Better Stack MCP reconectado y consultado directamente: source `1720702`, tabla lógica `t284025.render_log_stream`, retención de logs de 3 días. Extracciones históricas acotadas; no se crearon dashboards, alertas ni incidentes.
- PAX de laboratorio: A910S, serial 2841548417; paquete `com.jaac.avoqado_tpv.sandbox`, versión `2.8.7-sandbox`, versionCode 104, `DEBUGGABLE`. Se verificaron el APK instalado, hosts sandbox y cuentas A/B locales. Luego se ejecutaron cuatro ventas contactless sandbox, pérdida de respuesta, persistencia de cola tras muerte del proceso y bloqueo antes del SDK sin red. Las aserciones finales en Postgres local verificaron cuatro Payments, saldos correctos y un recibo por Payment. Son pruebas de Pago rápido, no del chip ni de `/orders/:id`; alcance completo en [resultados del laboratorio](./pax-sandbox-2026-09-08-resultados.md).
- [Stripe Terminal: collect payment](https://docs.stripe.com/terminal/payments/collect-card-payment?terminal-sdk-platform=android) distingue errores con resultado conocido y timeout de resultado desconocido; aconseja conservar la identidad del PaymentIntent al recuperar.
- [Adyen: POS timeouts](https://docs.adyen.com/point-of-sale/error-scenarios/pos-timeouts) distingue timeout de procesamiento de timeout de petición; en el segundo la terminal puede seguir procesando y corresponde consultar el estado. Sus garantías y tiempos no se transfieren automáticamente a Blumon o AngelPay.
- Evidencia local sanitizada y dumps de bytecode: `/tmp/codex-testarudo-20260908/`. No se guardaron credenciales, PAN completo, PIN, ARQC ni nombres de titulares en este informe.

La conclusión más urgente es conciliar $319 y reconstruir el resultado del primer intento en la terminal. Para las cuatro órdenes iniciales, hay evidencia fuerte de tres ventas rehechas, pero no justificación para declarar universalmente «no se cobró la tarjeta». Para el software, la prioridad es conservar y resolver estados inciertos. El POST ya muestra p95 menor a un segundo los días 7 y 8 en la ventana medida; un outbox sigue siendo una mejora de durabilidad y capacidad que requiere pruebas, pero no debe justificarse con un p95 antiguo como si describiera el incidente actual del día 8.
