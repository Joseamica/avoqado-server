# Auditoría de Codex — RONDA 2 (los arreglos)

**Fecha:** 2026-09-19 · **Modelo:** gpt-6-astra, `model_reasoning_effort=max` · **HEAD auditado:** `b932af34`

**Veredicto: TODAVÍA RECHAZADO.** Queda un camino que permite declarar «no cobrado» con un aprobado durable ya guardado.

🔴 **Error mío que Codex corrigió: la primera auditoría tenía SIETE P1, no seis.** El P1-9 (`ACTIVE` caduca por tiempo sin que nadie lo desmienta) nunca entró en mi lista de cierres.

## Lo que SÍ quedó cerrado (confirmado)

P1-1 `claimedSuccess` en la declaración inicial · P1-2 pagos por intento · P1-4 candados (sin inversión ni abrazo mortal) · P2-7 pertenencia de la orden · P2-6 importe del aviso · P3-16 correo · P2-15 emisión en vivo.

🔑 **Y una comprobación que pedí expresamente:** «No encontré una prueba debilitada para hacer pasar estos cambios». Verificó la del 17-sep que actualicé y confirmó que conserva sus garantías.

⚠️ **Límite declarado:** tampoco esta vez pudo correr Jest (`EPERM`), así que no validó carreras contra PostgreSQL real.

---

**Veredicto: todavía RECHAZADO. Sí queda un camino que permite escribir la declaración cuando ya existe un aprobado durable del mismo intento.**

Revisé el estado final de `develop`, HEAD `b932af34f`. El informe anterior tiene un error de conteo: enumera **siete P1**, incluido el P1-9 que falta en tu lista de cierres.

| Hallazgo anterior | Resultado |
|---|---|
| P1-1 · `claimedSuccess` | **Cerrado para la declaración inicial.** Se comprueba después de bloquear y releer la fila; otro escritor no puede modificar ese sobre entre lectura y CAS. |
| P1-2 · Payment por intento | **Cerrado en los registradores actuales.** Consulta todos los intentos sin filtrar estado y comparte sus candados con el registrador. |
| P1-3 · Procedencia | **Parcial:** lectura ampliada, CAS todavía insuficiente. |
| P1-4 · Candados | **Cerrado para el ingreso normal.** No encontré la inversión sugerida. El fallback sin candados sigue siendo relevante para P1-3. |
| P1-8 · Estados y retorno | **Parcial:** estados corregidos; `terminalReturnedAt` permite eludir las comprobaciones temporales. |
| P1-9 · `ACTIVE` | **Abierto; no cambió.** |
| P1-10 · Replay | **Parcial:** corrige `COMPLETED` y retenciones ya escritas, pero conserva otro falso `released:true`. |

Los hallazgos que impiden cerrar la revisión son:

1. **P1-3 · El aprobado contradictorio puede entrar después del veto y pasar el CAS.**  
   [uncharged-reconciliation.service.ts:355](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:355)

   **Entrada → salida:** solicitud `Q` del venue A, intento ligado `I`, sin evidencia al ejecutar `contradiccionDeProcedencia`. Un webhook aprobado de `I`, recibido por el venue B, ya agotó ambos tiempos de espera y entra por el [INSERT sin ningún candado](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/angelpay-webhook.service.ts:957). Confirma su evento antes del CAS.

   La lectura nueva habría vetado ese evento, pero el [predicado del CAS](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/evidenciaPositivaSql.ts:39) exige `e.venueId = A`; ignora el aprobado de B. El UPDATE puede escribir `FAILED/OPERATOR_RECONCILED_NO_CHARGE`. El toque posterior de `updatedAt` no lo evita: espera el bloqueo de fila y tampoco forma parte de este CAS.

   **Arreglo mínimo:** añadir al CAS de este servicio el mismo veto completo de procedencia que usa la lectura, sobre los vínculos actuales. Puede hacerse dentro del servicio nuevo, sin modificar el precedente.

   **Ésta responde directamente tu pregunta principal:** puede existir el aprobado durable **antes del UPDATE que declara “no cobrado”**.

2. **P1-8 · Una marca de retorno evita comprobar vencimiento y latido futuro.**  
   [uncharged-reconciliation.service.ts:142](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:142)

   **Entrada → salida:** entrega con ACK perdido → `UNKNOWN/ACK_TIMEOUT` a los cinco segundos, aunque `expiresAt` siga varios minutos adelante. El aparato reporta un heartbeat adelantado una hora. El [barrido](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5201) sólo compara ese heartbeat contra `expiresAt` y sella `terminalReturnedAt`.

   La declaración encuentra esa marca, retorna `true` inmediatamente y nunca ejecuta la validación nueva del heartbeat. Como `UNKNOWN` está admitido, puede declarar antes de vencer.

   Reproduje en memoria: **`UNKNOWN` + vencimiento futuro + retorno sellado → declaración aceptada**.

   **Arreglo mínimo:** comprobar el vencimiento siempre, antes del retorno anticipado, y aplicar la validación del retorno también a la rama con marca; una marca producida a partir de un heartbeat inválido no debe saltarse el control.

3. **P1-9 · `ACTIVE` sigue caducando sin una respuesta que lo desmienta.**  
   [sondaActiva.ts:41](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/sondaActiva.ts:41)

   **Entrada → salida:** `TIMED_OUT` recibe `ACTIVE`; transcurren 16 minutos sin otra respuesta, con terminal conectada → `sondaReportoActiva()` devuelve `false` y la declaración pasa. Lo reproduje en memoria.

   Además, la marca sigue en [resultJson](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:6403), que otros resultados reemplazan. El barrido periódico continúa partiendo de `UNKNOWN`; no garantiza renovar la observación de esa `TIMED_OUT`.

   **Arreglo mínimo:** conservar la observación fuera del sobre reemplazable y mantener el veto hasta una respuesta posterior que resuelva ese intento. Si hace falta refrescarlo, sondear esa solicitud específicamente; el transcurso de 15 minutos no basta.

4. **P1-10 · El replay todavía anuncia liberación con una afirmación de cobro durable.**  
   [terminal-payment.service.ts:5444](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5444)

   **Entrada → salida:** declaración aceptada → llega un `success` tardío sin Payment acreditable → [se persiste `claimedSuccess` sin cambiar todavía el estado](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:2583). Antes de la retención —o si ésta se difiere— llega el replay.

   La declaración histórica se devuelve correctamente, pero la lectura fresca sólo selecciona `status`, `failureCode` y `paymentId`. La fila aún es `FAILED/OPERATOR_RECONCILED_NO_CHARGE`, sin puntero, y responde **`released:true` pese a `claimedSuccess`**. Reproducido en memoria.

   Los dos casos originales, `COMPLETED` y `TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT`, **sí quedaron corregidos**.

   **Arreglo mínimo:** mantener el replay histórico, pero comprobar por separado la evidencia actual antes de anunciar liberación, incluida la afirmación del sobre y las señales todavía pendientes de retención.

5. **P2 nuevo · Un heartbeat válido recibido durante la consulta parece venir del futuro.**  
   [uncharged-reconciliation.service.ts:157](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:157)

   **Entrada → salida:** `terminalReturnedAt = null`; se captura `ahora = T0`; mientras se consulta la terminal, otro request guarda un heartbeat con hora servidor `T0 + 50 ms`; la consulta termina en `T0 + 100 ms`.

   El heartbeat ya ocurrió, pero se compara contra `T0`: `edadMs = -50` → `TERMINAL_NOT_BACK`. Reproduje este rechazo. Es un caso legítimo excluido por el arreglo, sin necesitar un reloj adelantado en el aparato.

   **Arreglo mínimo:** tomar la hora de comparación después de leer el heartbeat.

6. **P2-12 residual · Se arregló la entrada HTTP, pero no la respuesta documentada.**  
   [terminal-payment.mobile.controller.ts:409](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/controllers/mobile/terminal-payment.mobile.controller.ts:409)

   **Entrada → salida:** el cuerpo documentado, sin `requestId`, ahora llega correctamente al servicio usando la identidad de la ruta. Sin embargo, la respuesta sigue omitiendo `requestId`, `outcome` y `outcomeEvidence`, exigidos por el [contrato de Task 5](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/superpowers/plans/2026-09-18-conciliacion-operable-del-cobro-sin-confirmar.md:712).

   **Arreglo mínimo:** devolver esos campos desde la proyección actual. Es un residuo anterior, no un defecto nuevo.

Sobre las otras comprobaciones:

- **Candados:** la declaración toma consultivo de solicitud → intentos ordenados → orden → fila de solicitud. El registrador toma intento → orden → **fila** de solicitud, pero no solicita después el consultivo de solicitud. Son candados distintos; no aparece ese ciclo.
- **Intentos nuevos:** el único publicador encontrado en `src` toma [candadoDeSolicitud antes del INSERT](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5908). No puede publicar otro vínculo durante la enumeración de esta transacción.
- **Lectura frente a CAS:** siguen siendo diferentes. En `claimedSuccess`, el bloqueo de fila protege la lectura; en pagos por intento, lo hacen los candados compartidos con los registradores. En eventos existe un escritor explícitamente sin candados: ahí la diferencia sí produce el P1-3.
- **P2-7, pertenencia de orden: cerrado.** Se comprueba el resultado del bloqueo. Una solicitud legítima con `orderId = null` sigue aceptándose; lo reproduje.
- **P2-6, importe: cerrado.** Lee el Payment por ID y venue y suma importe más propina.
- **P3-16, correo: cerrado en `avisarAprobacionTardiaTrasVentana`.** El texto común evita atribuir «no se presentó tarjeta».
- **P2-15:** el aviso ahora se emite mediante `broadcastNewNotification`, además de guardarse.

**No encontré una prueba debilitada para hacer pasar estos cambios.** En [terminal-payment.pagoSinLigar.test.ts:795](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/terminal-payment.pagoSinLigar.test.ts:795), se conserva el asunto exacto, las identidades del pago y solicitud y el conteo de otros cobros. Se sustituye la atribución incorrecta y se añade una aserción que la prohíbe. Ejecuté en memoria las tres variantes del correo y cumplen esas garantías.

La cobertura nueva sí tiene límites: la integración enfrenta dos declaraciones, no declaración contra webhook; su caso con Payment existente rechaza antes del CAS. No demuestra las intercalaciones anteriores.

Ejecuté reproducciones en memoria con el código real y dobles de base de datos. **No validé carreras contra PostgreSQL real:** Jest falló antes de ejecutar el archivo por `EPERM` al escribir su caché, incluso con `--no-cache`. Los P2-5, P2-11, P2-13 y P2-14 quedan fuera del recuento nuevo, como pediste.

Los arreglos cierran varios huecos, pero todavía puede declararse “no cobrado” con un aprobado ya guardado.  
Para destrabar ventas reales, faltan los cierres anteriores.  
No modifiqué archivos y no necesito ninguna decisión tuya para sustentar esta revisión.
