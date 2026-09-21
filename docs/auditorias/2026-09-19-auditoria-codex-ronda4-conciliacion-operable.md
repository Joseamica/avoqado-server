# Auditoría de Codex — RONDA 4 (tras quitar la elegibilidad por reloj)

**Fecha:** 2026-09-19 · **Modelo:** gpt-6-astra, `model_reasoning_effort=max`

## 🔴 El veredicto sobre la DECISIÓN de quitar `terminalVolvio()`

> Quitar `terminalVolvio()` sí abrió caminos. En seguridad del cobro, mi juicio es que **aumentó el riesgo**; redujo los bloqueos operativos y la complejidad.

Y la precisión que corrige su propio razonamiento de la ronda 1:

> **que el latido no pruebe el cese no significa que quitar todas esas condiciones conserve las mismas barreras.**

**El caso concreto que se abrió:** una solicitud cuyo ACK se pierde pasa a `UNKNOWN/ACK_TIMEOUT` a los **5 segundos**, con el cobro posiblemente todavía corriendo y minutos por delante hasta vencer. En la ronda 3 se rechazaba (`TERMINAL_NOT_BACK`); ahora se acepta.

**Su propuesta para conservar seguridad SIN relojes:**

> acreditar que esa solicitud quedó detenida y no puede continuar ejecutándose —por cierre o cancelación durable en la terminal— antes de liberar. La inspección visual no revoca una ejecución ni un mensaje en tránsito.

⚠️ **Límite declarado, y vale para las cuatro rondas:** Codex NUNCA pudo ejecutar nada (`EPERM` en Jest y en PostgreSQL). Todas sus reproducciones son en memoria sobre el código real, no ejecuciones.

---

**Veredicto: todavía no lo daría por cerrado. Quitar `terminalVolvio()` sí abrió caminos. En seguridad del cobro, mi juicio es que aumentó el riesgo; redujo los bloqueos operativos y la complejidad.**

Audité `develop`, HEAD `0269a7fd`, contra `61a567f3`. Reproduje los casos indicados abajo con código real y dobles de base de datos.

**Primero, la decisión de diseño — P1.**  
[uncharged-reconciliation.service.ts:260](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:260)

Mi razonamiento anterior necesitaba una precisión: **que el latido no pruebe el cese no significa que quitar todas esas condiciones conserve las mismas barreras.**

**Entrada → salida:** la terminal recibe una solicitud; se pierde su ACK. A los cinco segundos el servidor escribe `UNKNOWN/ACK_TIMEOUT`, aunque el cobro pueda continuar y falten minutos para vencer. No ha llegado `ACTIVE`, Payment ni aprobación bancaria. Ahora una declaración puede escribir `FAILED/OPERATOR_RECONCILED_NO_CHARGE` inmediatamente.

Comparé exactamente esa entrada:

- **Ronda 3:** rechazada con `TERMINAL_NOT_BACK`.
- **Ronda 4:** aceptada y alcanza el UPDATE de declaración.

La transición real a `UNKNOWN` está en [terminal-payment.service.ts:1998](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:1998). El veto positivo sólo conoce lo que **ya llegó al servidor**. Una terminal que se reinició y muestra inicio tampoco demuestra que el banco no haya cobrado.

**Juicio:** quitar el latido como pretendida prueba de cese es correcto. Eliminar también toda restricción sobre esa ejecución incierta aumenta la dependencia del testimonio humano, especialmente durante los primeros segundos. Los fallos anteriores del reloj desaparecieron porque desapareció la condición; eso no constituye una mejora equivalente de seguridad.

**Arreglo para conservar la seguridad sin relojes:** acreditar que esa solicitud quedó detenida y no puede continuar ejecutándose —por cierre o cancelación durable en la terminal— antes de liberar. La inspección visual no revoca una ejecución ni un mensaje en tránsito. Si se conserva el diseño actual, ese riesgo adicional queda asumido.

Los tres cierres anunciados quedan así:

| Cierre | Resultado |
|---|---|
| **P1-1: sello después de `closeRow`** | **Parcial.** Corrige la validación y `NOT_FOUND`; siguen dos caminos incorrectos. |
| **P1-2: migración y respaldo antiguo** | **Parcial.** La marca antigua sin resolución vuelve a vetar; la comparación del respaldo falla. |
| **P1-5: replay con `claimedSuccess`** | **Cerrado ese caso concreto del wrapper.** La variante bancaria sigue abierta y apareció una regresión con `COMPLETED`. |

1. **P1 · Residual: retornar de `closeRow()` no significa haber persistido.**  
   [terminal-payment.service.ts:6509](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:6509), [captura del error:2635](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:2635)

   **Entrada → salida:** hay `probeActiveAt`; llega `RESOLVED/success` con `authorizationCode`. Falla la escritura de `claimedSuccess`. `escribirSuccessDegradado()` absorbe la excepción y devuelve `timeout`; `closeRow()` termina normalmente. El manejador escribe `probeResolvedAt`, levanta el veto y la siguiente declaración pasa.

   **Reproducido:** escritura positiva fallida → sello exitoso → sin `claimedSuccess` durable → declaración aceptada.

   **Arreglo mínimo:** obtener una confirmación explícita de persistencia antes de sellar; una devolución de transporte como `timeout` no sirve como confirmación. Idealmente, persistencia y levantamiento del veto deben pertenecer a la misma transacción.

   **Lo que sí está bien:** si la excepción realmente se propaga, no se alcanza el sello. Si el proceso muere después de persistir y antes de sellar, conserva el veto: puede quedar bloqueo pendiente, pero esa interrupción no libera indebidamente. También confirmé que `RESOLVED` sin resultado y `NOT_FOUND` con ACK ya no sellan.

2. **P1 · Nuevo: un `RESOLVED` en procesamiento puede levantar un `ACTIVE` recibido entretanto.**  
   [terminal-payment.service.ts:6519](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:6519)

   **Entrada → salida:** comienza a procesarse `RESOLVED`; mientras espera `closeRow`, otro manejador persiste `ACTIVE`. Después, el primer manejador sella con la hora actual, que resulta posterior a ese `ACTIVE`. El helper interpreta que la resolución desmintió la observación nueva.

   Reproduje la intercalación: `ACTIVE=12:00` → sello del manejador anterior `13:00` → veto desactivado → declaración aceptada.

   **Arreglo mínimo:** condicionar el sello a que la observación activa no haya cambiado durante el cierre, mediante una versión/CAS o exclusión compartida. La hora al terminar de procesar no identifica qué observación se resolvió.

3. **P1 · Respaldo antiguo: `new Date(0)` permite que una resolución anterior levante el veto.**  
   [sondaActiva.ts:38](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/sondaActiva.ts:38)

   **Entrada → salida:**

   ```text
   resultJson.probeActiveAt = 12:00
   probeActiveAt            = NULL
   probeResolvedAt          = 11:00
   ```

   El helper sustituye las 12:00 por **1970**; devuelve `false` y la declaración pasa. Reproduje lo mismo con una marca ilegible y una resolución existente.

   Hay otra variante: columna activa de las 10:00, resolución de las 11:00 y escritor antiguo que añade al JSON una observación de las 12:00. El `??` ignora completamente esa observación nueva.

   **Arreglo mínimo:** considerar ambas fuentes; comparar la fecha antigua real cuando sea válida y conservar el veto cuando sea ilegible. Una columna poblada no debe ocultar una observación antigua más reciente.

4. **P1 · Residual: el replay sigue ignorando evidencia bancaria externa a la solicitud.**  
   [uncharged-reconciliation.service.ts:247](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:247), [terminal-payment.service.ts:5446](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5446)

   **Entrada → salida:** declaración aceptada → aprobación bancaria durable, pendiente de retención → replay. La solicitud conserva el código de declaración; se devuelve:

   ```json
   {"released":true,"outcome":"NOT_CHARGED","outcomeEvidence":"OPERATOR_RECONCILED"}
   ```

   Confirmé que el replay no ejecuta las consultas de evidencia positiva. **Era la segunda variante de P1-5 de ronda 3; sigue abierta.**

   Además, sobre una fila con `claimedSuccess`, el wrapper corregido dice `UNRESOLVED`, pero el [GET de estado:3334](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:3334) todavía devuelve `FAILED/NOT_CHARGED/OPERATOR_RECONCILED`. También lo reproduje. Esto es residual, no introducido ahora.

   **Arreglo mínimo:** conservar la declaración histórica y proyectar el estado actual con los mismos vetos en replay y GET, incluyendo señales pendientes de retención.

5. **P2 · Nuevo: un cobro confirmado también pasa a responder `UNRESOLVED`.**  
   [terminal-payment.service.ts:5499](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5499)

   **Entrada → salida:** declaración → Payment acreditado → solicitud `COMPLETED` → replay. Ahora responde simultáneamente:

   ```json
   {"released":false,"status":"COMPLETED","paymentId":"pay-1","outcome":"UNRESOLVED","outcomeEvidence":null}
   ```

   **Arreglo mínimo:** preservar `CHARGED/PAYMENT_RECORDED` cuando existe el cobro acreditado. Reservar `UNRESOLVED` para evidencia positiva todavía sin desenlace acreditado.

   **Clientes:** no encontré una pantalla actual que invoque esta variante de `/release`; MCP decide por `released/status`. Por tanto, no afirmo una regresión visual directa. Sí comprobé que los lectores actuales de [Android:273](/Users/amieva/Documents/Programming/Avoqado/avoqado-android/app/src/main/java/com/avoqado/pos/payment/domain/CardChargeOutcome.kt:273) e [iOS:373](/Users/amieva/Documents/Programming/Avoqado/avoqado-ios/avoqado-ios/Payment/CardChargeOutcome.swift:373) interpretan `FAILED` como no cobrado: añadir `UNRESOLVED` sin alinear el estado no protege esos lectores.

6. **P2 · Nuevo: la migración comprueba un prefijo, no una fecha válida.**  
   [migration.sql:10](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/prisma/migrations/20260919020000_probe_active_backfill/migration.sql:10)

   **Entrada → salida:** un valor como `2026-99-99Tbasura` satisface la expresión regular y llega al cast `::timestamp`, que aborta la migración. No se conserva simplemente como dato ilegible, como afirma el comentario.

   **Arreglo mínimo:** validar la conversión de forma segura antes del cast; conservar el veto para valores no convertibles. Es un hallazgo condicionado a datos malformados: no comprobé que existan en producción ni ejecuté la migración.

**Sobre las pruebas:** la prueba antigua que consolidaba la pérdida del JSON **sí quedó corregida**. Pero sus casos no combinan ese JSON con `probeResolvedAt`, por eso no detectan el punto 3.

La nueva [prueba de aceptación:316](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/tpv/unchargedReconciliation.test.ts:316) exige aceptar incluso con vencimiento futuro y sin retorno. **Consolida el camino temprano del hallazgo de diseño**: documenta la decisión, pero no demuestra que el cobro terminó.

La [prueba del controlador:103](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/controllers/terminalPaymentRelease.contrato.test.ts:103) entrega `UNRESOLVED` mediante un mock. Comprueba que se copia; no detectaría revertir el cálculo del wrapper ni la regresión con `COMPLETED`.

**Respuesta a “¿puede escribirse encima de un cobro ocurrido?”: sí.** El caso del punto 1 permite aceptar después de recibir un `success` cuya persistencia falló. La eliminación temporal también permite declarar antes de que llegue evidencia de una ejecución real.

Jest quedó bloqueado por `EPERM` al escribir su caché; la conexión PostgreSQL configurada también recibió `EPERM`. Las reproducciones fueron en memoria: **no validé carreras contra PostgreSQL real**. No modifiqué archivos. P2-5, P2-11, P2-13 y P2-14 permanecen fuera del recuento.

Los arreglos mejoraron varios casos, pero todavía pueden permitir declarar un cobro como no realizado.  
Para ti significa que el destrabe es más accesible, aunque aún no conserva todas las protecciones prometidas.  
No necesito ninguna decisión adicional tuya para sustentar estos hallazgos.
