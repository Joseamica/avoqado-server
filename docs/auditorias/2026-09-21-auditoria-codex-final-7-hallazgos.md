**RECHAZADO para commitear.** El candado cierra la carrera ordinaria que señalaste, pero introduce una pérdida de procedencia ante rollback. También quedan caminos que silencian evidencia positiva. Distingo abajo las regresiones nuevas de los cierres incompletos.

**1. P1 — NUEVO: puede emitirse el cobro y perderse después toda constancia de entrega.**

Evidencia: [terminal-payment.service.ts:2171](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:2171), [recordDelivery:2130](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:2130) y [liberación por sonda:6732](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:6732).

**ENTRADA → SALIDA:** solicitud `PENDING`, procedencia `[]` → la transacción añade la entrega → `emitir()` manda el paquete → falla el commit o vence la transacción → PostgreSQL revierte procedencia y `lastDeliveredAt`, pero el paquete sigue fuera. Tras pasar a `UNKNOWN`, un `NOT_FOUND` puede acreditar falsamente `TPV_NEVER_RECEIVED` y liberar. Una entrega legacy cuyo registro desapareció tampoco conserva el veto contra replay después de actualizar la terminal.

Es falsa la afirmación del comentario de que rollback implica «no hubo entrega». Además, el catch de la línea 2026 registra *“Delivery aborted before emit”* incluso cuando falló **después** de emitir.

**Arreglo mínimo:** conservar una marca durable y conservadora de posible entrega **antes** del efecto externo; después, mantener la exclusión por solicitud y comprobar nuevamente el estado vigente antes de emitir. Esa marca no debe desaparecer si falla la transacción que rodea al envío. Mover simplemente el emit fuera de la transacción reabriría la carrera anterior.

**2. P1 — INCOMPLETO: el replay rechaza la liberación, pero GET y admisión siguen tratando la solicitud como liberada.**

Evidencia: [revalidación:5543](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5543), [webhook:454](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/angelpay-webhook.service.ts:454), [GET:3400](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:3400) y [admisión de la venta:1694](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:1694).

**ENTRADA → SALIDA:** A queda `FAILED/OPERATOR_RECONCILED_NO_CHARGE` → llega un aprobado de su intento por otro venue → el webhook guarda `LINK_VENUE_MISMATCH` y termina sin retener A → replay responde correctamente `released:false, outcome:UNRESOLVED` → el cajero vuelve a consultar → GET proyecta la misma fila como `NOT_CHARGED/OPERATOR_RECONCILED`.

La admisión también excluye ese código del conjunto de pendientes. Si la orden continúa impaga, puede admitir otro cobro. No requiere ganar una carrera: la contradicción persiste mientras la fila permanece liberada.

**Arreglo mínimo:** hacer que esa evidencia contradictoria retenga durablemente la solicitud y bloquee la venta; aplicar el mismo criterio en la recuperación. No debe crear un `Payment` atribuido al venue equivocado, pero sí impedir otra autorización. Cambiar únicamente la respuesta del replay no alcanza.

**3. P1 — RESIDUAL: `failUndelivered` todavía puede borrar una afirmación positiva ya persistida.**

Evidencia: [reemplazo completo del sobre:2221](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:2221), [primera escritura del éxito degradado:2648](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:2648) y [segunda escritura:2674](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:2674).

**ENTRADA → SALIDA:** A sigue `PENDING`; un resultado positivo todavía no acreditable como `Payment` guarda `claimedSuccess.transactionId` → entre las dos escrituras entra `failUndelivered`, por ejemplo desde el envío original cuyo socket desapareció mientras otro socket recibió el replay → reemplaza `resultJson` completo → la segunda escritura del éxito degradado conserva únicamente el `claimedSuccess` que encuentre actualmente, que ya desapareció.

Resultado: `UNKNOWN`, `failureCode:null`, sobre `timeout` sin `claimedSuccess` ni `origin:SERVER`. La declaración puede tomarlo como respuesta del aparato y aceptar sin encontrar la señal positiva perdida.

**Arreglo mínimo:** impedir que `failUndelivered` borre evidencia positiva: fusionar atómicamente el sobre conservándola, o vetar esa escritura cuando exista. La segunda fase tampoco debe asumir que ningún escritor pudo eliminar la afirmación.

**4. P1 — INCOMPLETO EN ANDROID: una caché anterior a `staleOutcome` sigue convirtiendo un éxito real en error.**

Evidencia: [TerminalPaymentService.kt:444](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/data/TerminalPaymentService.kt:444), [recuperación:687](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/data/TerminalPaymentService.kt:687) y [almacenamiento del negativo:706](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/data/TerminalPaymentService.kt:706).

**ENTRADA → SALIDA:** POST A sigue vivo → una declaración aceptada, incluso desde otro POS, hace que una consulta concurrente observe `FAILED/OPERATOR_RECONCILED` → esa recuperación guarda `Error` en `recoveredPosts[A]` → llega el POST original con `success + paymentId` → la línea 444 devuelve el error cacheado **antes de decodificar el éxito**.

`staleOutcome` recibe un negativo; el dinero ya fue descartado antes de llegar al arreglo. La línea 687 permite lo mismo cuando una nueva consulta acaba de obtener `Charged`.

**Arreglo mínimo:** aplicar la precedencia de evidencia positiva en ambas entradas del servicio Android: respuesta del POST y resultado de recuperación. Conservar la deduplicación cuando el ganador cacheado sea el mismo pago positivo.

**5. P1 — INCOMPLETO EN iOS: devuelve `.charged`, pero la marca negativa impide conservarlo para el flujo siguiente.**

Evidencia: [marca negativa:1041](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Services/TerminalPaymentService.swift:1041), [veto del setter:223](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Services/TerminalPaymentService.swift:223) y [consumidor obsoleto:2527](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Payment/PaymentFlowViewModel.swift:2527).

**ENTRADA → SALIDA:** POST A vivo → el cajero abandona el flujo y declara A → `provenNotCharged` contiene A y se limpia la llave → llega `success + paymentId` → el servicio devuelve correctamente `.charged` → el ViewModel antiguo intenta rearmar A para que el siguiente flujo informe del cargo → el setter rechaza la escritura porque A sigue en `provenNotCharged`.

El ViewModel retorna sin aplicar el cobro a la pantalla ni conservar la llave. El éxito dejó de perderse en el servicio, pero todavía se pierde en su consumidor.

También falta revocar esa marca cuando el éxito llega por `result(from:)`.

**Arreglo mínimo:** permitir el rearmado respaldado por evidencia positiva de **esa misma solicitud** y revocar su marca negativa. Debe conservarse la protección de cualquier otra llave armada.

**6. P1 — INCOMPLETO PARA FILAS EXISTENTES: los sobres sintéticos anteriores siguen contando como respuesta de terminal.**

Evidencia: [barrera:328](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:328) y [nuevo escritor:2229](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:2229).

**ENTRADA → SALIDA:** fila persistida por la versión anterior con `UNKNOWN/SOCKET_NOT_FOUND`, entregas durable, ningún ACK y sobre sintético sin `origin` → entra el código nuevo → `origin !== 'SERVER'` resulta verdadero → se acredita que la terminal contestó y puede aceptarse la declaración.

El cambio etiqueta las escrituras nuevas; no distingue las anteriores. No afirmo que hoy exista una fila así en producción: el defecto aplica al formato persistido que el código anterior sí escribía.

**Arreglo mínimo:** reconocer conservadoramente los sobres sintéticos históricos mediante su procedencia/código, o normalizarlos antes de habilitar esta lectura. Añadir el caso sin `origin` y con `failureCode:SOCKET_NOT_FOUND`.

**7. P2 — NUEVO EN iOS: se pierde `alreadyRecovered` cuando el éxito tardío ya había sido atendido.**

Evidencia: [marcado del ganador cacheado:180](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Services/TerminalPaymentService.swift:180), [nuevo retorno directo:500](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Services/TerminalPaymentService.swift:500) y [guarda del consumidor:2507](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Payment/PaymentFlowViewModel.swift:2507).

**ENTRADA → SALIDA:** una recuperación confirma y comunica el pago A; queda cacheado `.charged` y la llave está limpia → llega el POST original con el mismo éxito → ahora devuelve el objeto recién decodificado, cuyo `alreadyRecovered` es `nil` → el ViewModel obsoleto vuelve a armar A.

Antes, `recoveredPost` devolvía ese ganador con `alreadyRecovered:true`. Se reintroduce un pendiente ya resuelto; según el consumidor, también puede repetirse la aplicación del éxito.

**Arreglo mínimo:** distinguir ganador negativo de ganador positivo del **mismo pago**. El éxito debe sustituir al negativo, pero conservar la información de que ese pago positivo ya fue atendido.

Respecto de las preguntas donde **no encontré otro defecto**:

- **Deadlock con ACK/webhook:** no encontré un ciclo nuevo. `socket.emit` no espera al ACK; los callbacks lanzan sus escrituras sin que la transacción las espere. El ACK puede esperar el bloqueo de fila, pero el commit no espera al ACK. El ingreso normal del webhook toma el candado del intento; su fallback toma el de solicitud después de terminar la transacción anterior.
- **Duración y `timeout:10_000`:** no hay una espera de red del ACK dentro del callback, pero sí adquisición de candados, escritura y commit. Los 8 segundos de `lock_timeout` no garantizan terminar todo dentro de 10. Prisma puede cancelar y revertir la transacción al vencer; eso no revierte el socket. Aumentar el timeout no corrige el hallazgo 1. [Documentación de Prisma](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions).
- **Suplantación de `origin`:** no encontré una ruta entrante que permita inyectarlo en ese nivel del sobre. El socket reconstruye los campos admitidos en [socketManager.ts:448](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/communication/sockets/managers/socketManager.ts:448), y la sonda también reconstruye su resultado. No encontré colisión con un campo terminal actualmente conservado.
- **Errores de las consultas nuevas del replay:** fallan cerrado. El catch establece `evidenciaActual=true`; si falla la lectura fresca anterior, se propaga el error. El hallazgo 2 es una contradicción entre respuestas y estado durable, no una excepción que responda `released:true`.
- **iOS devolviendo un falso `.charged`:** no encontré ese nuevo camino. El POST exige `success`, identidad coincidente y `paymentId` no vacío; la recuperación exige estado acreditado. Dar precedencia a ese dinero sobre la declaración es correcto. Los defectos están en conservarlo y evitar atenderlo dos veces.
- **401 y refresh:** no encontré una regresión nueva por `isOneShot()`. El autenticador refresca y guarda los tokens antes de decidir no reenviar la declaración en [TokenRefreshAuthenticator.kt:208](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/core/data/network/TokenRefreshAuthenticator.kt:208). El cliente especial sólo se usa para declarar.

**Sí es falsa la afirmación de que ninguna bandera desactiva el reenvío del 408.** OkHttp 4.12 consulta `retryOnConnectionFailure` en esa rama y devuelve sin reenviar cuando está apagado. Para **503 con `Retry-After:0`**, el cuerpo de un solo envío sí aporta la protección que falta. [Código oficial de OkHttp 4.12](https://github.com/square/okhttp/blob/parent-4.12.0/okhttp/src/main/kotlin/okhttp3/internal/http/RetryAndFollowUpInterceptor.kt#L229-L267).

Sobre **los dos defectos que encontraste tú**:

- El indulto por identidad está bien cerrado en [PaymentFlowViewModel.kt:1903](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/presentation/PaymentFlowViewModel.kt:1903): un éxito de A no concede el bypass a B. El test con éxito tardío y otra llave armada comprueba precisamente `aunSiFueDeclarado=false`.
- La precedencia dentro de `staleOutcome` también está bien: `Charged` vence a `NoSeCobro`, conservando la excepción del cobro ya aplicado. **El cierre completo sigue incompleto por el hallazgo 4**, anterior a esa función.

Sobre **las pruebas agregadas**:

- [Entrega bajo candado:371](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/integration/tpv/unchargedReconciliation.integration.test.ts:371): tiene un control positivo válido, pero sólo prueba ejecución secuencial. Una implementación que consultara/escribiera y emitiera **sin mantener el candado** también pasaría. Falta intercalar declaración y entrega, y probar fallo posterior al emit.
- [Replay contradictorio:336](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/integration/tpv/unchargedReconciliation.integration.test.ts:336): **puede pasar por el motivo equivocado** si la consulta nueva lanza una excepción. El control de la línea 415 no tiene vínculos y evita esa consulta. Falta un control con vínculo presente y sin contradicción; además, comprobar GET y bloqueo de una nueva autorización después del rechazo.
- [Sobre sintético:391](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/tpv/unchargedReconciliation.test.ts:391): prueba correctamente la marca suministrada por el fixture. No comprueba que el escritor real la produzca ni cubre el formato histórico. El control tampoco conserva el mismo `failureCode`.
- [Éxito tardío iOS:267](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-iosTests/DeclaracionNoCobradoTests.swift:267): sí detecta el descarte anterior dentro del servicio. Termina antes del ViewModel y del rearmado durable. Faltan el consumidor obsoleto y el control de éxito ya recuperado.
- [Cuatro pruebas de `staleOutcome`:522](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/test/java/com/avoqado/pos/payment/CardChargeDecisionTest.kt:522): prueban sus cuatro decisiones; no vi que pasaran accidentalmente. Falta la secuencia HTTP/recuperación que pierde el éxito antes de invocarlas.
- [HTTP Android:597](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/test/java/com/avoqado/pos/payment/TerminalPaymentServiceHttpTest.kt:597): quitar `unSoloEnvio` manteniendo las banderas **no tumbaría el test del 408**. El 503 sí cubre esa protección. El test del 401 usa un `OkHttpClient()` sin autenticador: acredita el mapeo del resultado, no que se haya renovado la sesión.

Verificación: reproduje en memoria, con métodos extraídos del árbol y dobles de transacción/SQL, la emisión seguida de rollback, la pérdida de `claimedSuccess` y la aceptación del sobre sintético histórico, con controles correspondientes. No equivalen a integración contra PostgreSQL. Jest no llegó a ejecutar pruebas: falló con `EPERM` al crear su caché en este entorno de sólo lectura. No cuento las suites como aprobadas.

**Veredicto final: RECHAZADO para commitear este conjunto.** No modifiqué código ni hice commits, push o despliegues.
