# Auditoría FINAL de Codex (gpt-6-astra, max) — 2026-09-20

**Veredicto: RECHAZADO** · 5 P1 · 1 P2
**Respuesta a la pregunta directa:** SÍ — `1fae9a74` reabre la posibilidad de liberar un cobro que
todavía puede enviarse a la terminal. El caso simple (`DURABLE`/`ackVersion 1`/sin ACK) sigue
bloqueado; la regresión entra **por la rama legacy** que introduje.

**Método del auditor:** lectura del código, reproducciones en memoria ejecutando las funciones
REALES con Prisma/socket simulados, y ejecución del binario instalado de OkHttp 4.12.0. No corrió
Gradle/Xcode ni integración contra Postgres (entorno de sólo lectura).

## Cuáles son míos

| # | Hallazgo | ¿Mío? |
|---|---|---|
| 1 | El cobro puede SALIR después de aceptar la declaración | 🔴 **regresión mía de `1fae9a74`** — con el commit padre daba `TERMINAL_NEVER_ANSWERED` |
| 2 | Un sobre escrito por el SERVIDOR cuenta como respuesta de la TERMINAL | residual, anterior a mi commit |
| 3 | El replay de la declaración omite el veto por contradicción de venue | residual |
| 4 | iOS puede descartar un éxito tardío y devolver «no se cobró» | 🔴 **introducido por mi cierre del P2-4** — tapa dinero |
| 5 | Android todavía reenvía la declaración (OkHttp reintenta 408 y 503 `Retry-After: 0`) | 🔴 **mi arreglo era incompleto**: el header sólo lo lee el Authenticator |
| 6 | Android rearma la llave por `rearmUnresolvedCharge`, que no consulta `declaradosSinCobro` | 🔴 mío — **y mi prueba llamaba a la ruta equivocada** (`armarLlaveSiLibre`, que sí tiene la guarda) |

🔑 **Y confirma la sospecha del registro, reproducida:** `anunciado: 1 → almacenado: 0`. Una terminal
capaz SÍ puede quedar con `ackVersion: 0` cuando el JWT no acredita el serial — «cero» no demuestra
incapacidad, que es justo lo que mi barrera asumió.

---

**Sí: `1fae9a74` reabre la posibilidad de liberar un cobro que todavía puede enviarse a la terminal.** El caso simple `DURABLE / ackVersion: 1 / sin ACK` sigue bloqueado; encontré una regresión por la rama legacy y otros defectos verificables.

1. **P1 — Se puede emitir el cobro DESPUÉS de aceptar la declaración.**  
   [uncharged-reconciliation.service.ts:300](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:300), [terminal-payment.service.ts:1956](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:1956).

   **ENTRADA → SALIDA:** `recordDelivery` guarda una entrega legacy **antes del `emit`**; su respuesta al emisor se retrasa. Entretanto vence la solicitud, el watchdog la pasa a `UNKNOWN` y el cajero declara. La rama nueva acepta y libera. Cuando continúa el emisor, ejecuta `terminal:payment_request` sin comprobar nuevamente el estado: **envía sobre una fila ya `FAILED / OPERATOR_RECONCILED_NO_CHARGE`**.

   Reproduje ese intercalado ejecutando las funciones reales con Prisma/socket simulados. Con el padre de `1fae9a74`, la declaración devuelve `TERMINAL_NEVER_ANSWERED`; con el commit, se acepta y después ocurre el envío.

   **Arreglo mínimo:** serializar la emisión pendiente y la declaración por `requestId`, comprobando el estado vigente dentro de esa exclusión. La declaración debe impedir que continúe un emisor pendiente; el registro previo al envío no acredita un envío terminado.

2. **P1 — Un sobre escrito por el SERVIDOR cuenta como respuesta de la TERMINAL. Residual anterior al commit.**  
   [uncharged-reconciliation.service.ts:294](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:294), [terminal-payment.service.ts:2176](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:2176).

   **ENTRADA → SALIDA:** el envío original conserva el socket A; la terminal reconecta por B y recibe un replay durable cuyo ACK se pierde. El envío original encuentra desaparecido A y llama a `failUndelivered`. Ese método escribe `UNKNOWN / SOCKET_NOT_FOUND` y un `resultJson` sintético. La declaración interpreta ese objeto como «la terminal contestó» y **acepta aunque todas las entregas sean `DURABLE / ackVersion: 1`, sin ACK ni respuesta del aparato**.

   También reproduje la aceptación usando `failUndelivered` y `reconcileUncharged` reales.

   **Arreglo mínimo:** acreditar explícitamente el origen del resultado. Un timeout generado por el servidor nunca debe satisfacer `sobreConRespuesta`.

3. **P1 — El replay de la declaración omite el veto por contradicción de venue. Residual.**  
   [terminal-payment.service.ts:5490](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5490), [evidenciaPositivaSql.ts:37](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/evidenciaPositivaSql.ts:37).

   **ENTRADA → SALIDA:** declaración aceptada en A → llega un webhook aprobado del mismo intento recibido en B → el webhook conserva `LINK_VENUE_MISMATCH` sin crear `Payment` → se repite la declaración. `reconcileUncharged` devuelve la declaración guardada antes de los vetos; la comprobación posterior busca aprobaciones únicamente en A. **Responde `released: true` pese a la contradicción durable que habría vetado una declaración nueva.**

   El escritor de ese escenario existe en [angelpay-webhook.service.ts:454](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/angelpay-webhook.service.ts:454).

   **Arreglo mínimo:** aplicar al replay el mismo veto completo de evidencia y procedencia que a la declaración inicial.

4. **P1 — iOS puede descartar un éxito tardío y devolver «no se cobró». Introducido por el cierre.**  
   [TerminalPaymentService.swift:899](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Services/TerminalPaymentService.swift:899).

   **ENTRADA → SALIDA:** el POST original sigue vivo → la declaración se acepta → `acknowledgeCancelVerdict` guarda `.notCharged` en `recoveredPosts` → llega el POST original con `success` y `paymentId`. En la línea 486 se devuelve el resultado guardado **antes de decodificar la respuesta positiva**. La recuperación por GET tiene la misma precedencia en la línea 675.

   **Arreglo mínimo:** la marca de declaración sólo debe suprimir resultados indeterminados obsoletos. Decodificar y dar prioridad a cualquier éxito acreditado; una declaración humana no puede convertirse en un negativo que tape dinero posterior.

5. **P1 — Android todavía reenvía automáticamente la declaración por otros caminos de OkHttp.**  
   [TerminalPaymentService.kt:791](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/data/TerminalPaymentService.kt:791).

   **ENTRADA → SALIDA:** `/release` responde **408**, o **503 con `Retry-After: 0`** → OkHttp repite el mismo POST sin otra confirmación del cajero. `X-No-Auto-Retry` sólo lo interpreta vuestro autenticador; el mecanismo interno de reintentos no lo consulta.

   Lo comprobé ejecutando el interceptor del **binario instalado de OkHttp 4.12.0**: ambos casos devuelven el mismo POST como siguiente petición, aun llevando el header.

   **Arreglo mínimo:** usar para esta declaración un cuerpo de un solo envío y deshabilitar recuperación automática y redirecciones. Probar esos casos además del 401.

6. **P2 — Android aún rearma la llave con un resultado indeterminado viejo. El cierre está incompleto.**  
   [PaymentFlowViewModel.kt:1894](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/presentation/PaymentFlowViewModel.kt:1894), [TerminalPaymentService.kt:254](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/data/TerminalPaymentService.kt:254).

   **ENTRADA → SALIDA:** flujo A queda vivo → otro flujo declara A y libera su llave → llega `Undetermined(A)` al flujo viejo → `handleStaleCardResult` llama a `rearmUnresolvedCharge(A)` → ese método escribe directamente la llave, sin consultar `declaradosSinCobro`. **La siguiente venta vuelve a mostrar el pendiente liberado.**

   La prueba nueva llama a `armarLlaveSiLibre`, que sí tiene la guarda, pero ésa no es la ruta del callback obsoleto.

   **Arreglo mínimo:** aplicar la protección en la ruta real de rearmado, distinguiendo `Undetermined` de un éxito tardío para conservar este último.

Respecto a tus preguntas específicas:

- **`every([])`:** correctamente protegido por `length > 0`.
- **Entregas mezcladas:** con una entrega `ackVersion >= 1`, sin ACK ni sobre, se bloquea.
- **¿Una terminal capaz puede quedar con `ackVersion: 0`? Sí.** [terminal-registry.ts:89](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/communication/sockets/terminal-registry.ts:89) elimina la capacidad anunciada cuando el JWT no acredita el serial; `recordDelivery` convierte ese dato ausente en cero. Reproduje `anunciado: 1 → almacenado: 0`. Por tanto, cero tampoco demuestra incapacidad.
- **Reconexión:** el replay descarta procedencia legacy/desconocida y una fila ya liberada no admite otra entrega. Eso no detiene un envío cuya escritura ya terminó y cuya continuación sigue pendiente: hallazgo 1.

La verificación fue mediante lectura del código, reproducciones en memoria y ejecución del binario de OkHttp. No ejecuté suites Gradle/Xcode ni integración contra Postgres en este entorno de sólo lectura. **Sin verificar:** la frecuencia de estas carreras en hardware y la presencia actual de JWT sin serial en producción.

**VEREDICTO: RECHAZADO — puede salir un cobro después de liberarlo, ocultarse un éxito tardío y repetirse una declaración sin nueva confirmación.**