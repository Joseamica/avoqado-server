# Auditoría de Codex — RONDA 3 (los arreglos de la ronda 2)

**Fecha:** 2026-09-19 · **Modelo:** gpt-6-astra, `model_reasoning_effort=max`

**Veredicto: TODAVÍA RECHAZADO — y 3 de los 5 P1 los introdujeron MIS ARREGLOS.**

| # | Origen |
|---|---|
| 1 · `probeResolvedAt` se sella antes de validar el resultado | 🔴 **nuevo, lo introduje yo** |
| 2 · la migración no traslada las marcas `ACTIVE` viejas | 🔴 **nuevo, lo introduje yo** |
| 3 · una marca de retorno inválida se acepta tras el vencimiento | residual de P1-8 |
| 4 · la tolerancia de 30 s vuelve «posterior» un latido anterior | 🔴 **nuevo, lo introduje yo** |
| 5 · el replay afirma `NOT_CHARGED` con `claimedSuccess` | residual de P1-10 |

🔴 **Y dos avisos sobre MIS PRUEBAS, que es lo más grave del informe:**

- La del latido «prueba menos de lo que afirma»: la tolerancia enmascara el arreglo, y sigue pasando aunque se deshaga.
- La de la sonda **consolidó el defecto 2**: exige que una marca antigua NO vete, sin haber migrado los datos.

## Lo que sí quedó confirmado

El alias `hay` del mock no mide otra cosa · la lista vacía en el CAS está bien manejada · no se pierde el índice · `sondaReportoActiva` no tiene llamadas comparando mal · una `UNKNOWN` con vencimiento lejano queda bloqueada, y eso es correcto (hay que corregir su procedencia, no confiar en una marca).

⚠️ **Límite declarado:** ni Jest ni PostgreSQL pudieron ejecutarse (`EPERM`). No verificó carreras reales ni planes.

---

1. **P1 · Nuevo: se levanta el veto de `ACTIVE` antes de validar o guardar la resolución.**  
   [terminal-payment.service.ts:6442](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:6442)

   **Entrada → salida:** fila vencida con `probeActiveAt`; llega `RESOLVED` sin `finalResult`. Primero se confirma `probeResolvedAt`; después, la validación devuelve `false`. La siguiente declaración encuentra `probeResolvedAt > probeActiveAt` y escribe `FAILED/OPERATOR_RECONCILED_NO_CHARGE`.

   Reproducido: **respuesta rechazada por el manejador → veto levantado → declaración aceptada**.

   También se sella antes de tratar un `NOT_FOUND` con ACK previo: esa rama registra una contradicción y conserva el estado, pero ya quitó el veto.

   **Hay además un camino sobre un cobro ocurrido:** llega `RESOLVED/success` válido, se confirma la marca y, antes de que `closeRow` guarde el pago o `claimedSuccess`, otra instancia acepta la declaración. La marca retiró la protección antes de incorporar la información que la sustituye.

   **Arreglo mínimo:** validar primero; persistir el resultado y sus señales positivas antes de levantar el veto, bajo la misma exclusión/transacción. Un `NOT_FOUND` considerado contradictorio no debe sellarse como resolución acreditada.

2. **P1 · Nuevo: la migración pierde las observaciones `ACTIVE` existentes.**  
   [migration.sql:5](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/prisma/migrations/20260919010000_probe_active_observation/migration.sql:5) y [sondaActiva.ts:29](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/sondaActiva.ts:29)

   **Entrada → salida:** una fila contiene `resultJson.probeActiveAt` de hace un minuto, escrito por la versión anterior. La migración añade ambas columnas como `NULL`, sin trasladar la observación. El lector nuevo ignora el JSON y devuelve `false` → permite declarar sin ninguna respuesta posterior.

   Reproduje la aceptación con ese estado. El problema aplica cuando existen marcas del formato anterior; no comprobé si producción contiene alguna.

   **Arreglo mínimo:** migrar conservadoramente las marcas existentes y mantener compatibilidad de lectura mientras puedan coexistir escritores anteriores. Los valores antiguos ilegibles deben conservar el veto.

3. **P1-8 · Residual: una marca de retorno inválida sigue saltándose la validación.**  
   [uncharged-reconciliation.service.ts:157](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:157)

   **Entrada → salida:** el [barrido](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5201) recibe un heartbeat adelantado una hora y sella `terminalReturnedAt` antes del vencimiento real. La terminal desaparece. Una vez vencida la solicitud, la declaración retorna `true` por aquella marca, sin consultar el heartbeat ni comprobar que hubo retorno posterior al vencimiento.

   El caso original **antes de vencer sí está cerrado**. El sello inválido sigue siendo aceptado después.

   **Arreglo mínimo:** aplicar la validación temporal también a la rama con marca; no considerar suficiente su mera existencia. Las marcas producidas a partir de un heartbeat inválido necesitan revalidación.

4. **P1 · Nuevo: los 30 segundos pueden convertir un heartbeat anterior al vencimiento en uno posterior.**  
   [uncharged-reconciliation.service.ts:178](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:178)

   **Entrada → salida, con reloj adelantado exactamente 30 segundos:**

   - Vencimiento: `12:00:00`.
   - Último heartbeat recibido realmente: `11:59:45`; el aparato escribe `12:00:15`.
   - La terminal pierde conexión.
   - Declaración: `12:00:05`.

   La edad calculada es `−10 s`, dentro de la tolerancia, y `12:00:15 > expiresAt`. Se acepta aunque **no hubo ningún heartbeat después del vencimiento**. Reproducido.

   Los 30 segundos **no eluden el vencimiento contra el reloj servidor**; el hueco está en acreditar el retorno.

   **Arreglo mínimo:** usar la hora de recepción observada por servidor para esta condición. Si se mantiene una tolerancia de reloj, comprobar la posterioridad con su extremo conservador —por ejemplo, `latido − 30 s > expiresAt`—, además de validar ambas ramas del retorno.

5. **P1 · Replay: la respuesta todavía puede afirmar “no cobrado” con evidencia positiva.**  
   [terminal-payment.service.ts:5464](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5464) y [línea 5489](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5489)

   Encontré dos variantes:

   **Nueva contradicción:** declaración aceptada → `claimedSuccess` durable → replay. Ahora devuelve correctamente `released:false`, pero `desenlaceCanonico` clasifica por el código anterior y responde:

   ```json
   {
     "released": false,
     "status": "FAILED",
     "outcome": "NOT_CHARGED",
     "outcomeEvidence": "OPERATOR_RECONCILED"
   }
   ```

   Reproducido con `claimedSuccess.authorizationCode = "103520"`.

   **Residual del replay:** declaración aceptada → se confirma un webhook aprobado del intento, pendiente de procesamiento/retención → replay mientras la solicitud conserva `FAILED/OPERATOR_RECONCILED_NO_CHARGE`. La devolución histórica [sale antes de los vetos](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:290), y el wrapper sólo consulta la solicitud. Responde `released:true`; no consulta los eventos positivos actuales. Reproduje que esas consultas no se ejecutan.

   **Arreglo mínimo:** conservar la resolución histórica, pero calcular conjuntamente `released`, `outcome` y `outcomeEvidence` desde la evidencia actual. Con afirmación positiva sin pago acreditado, devolver pendiente de confirmar; incluir los eventos/pagos cuya retención todavía no se refleja en la solicitud.

**Sobre las pruebas:**

- **El alias `hay` está bien encaminado.** En [unchargedReconciliation.test.ts:280](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/tpv/unchargedReconciliation.test.ts:280), comprobé que la orden devuelve su fila y la consulta de procedencia recibe `{hay:true}`. El rechazo es `POSITIVE_EVIDENCE_EXISTS`, no un fallo previo de pertenencia.
- **Ese test no demuestra el arreglo del CAS.** Rechaza antes del `UPDATE`; `$executeRaw` está simulado. Falta enfrentar una aprobación que aparece entre la lectura y la escritura.
- **P2 · El test del heartbeat prueba menos de lo que afirma.** En [línea 350](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/tpv/unchargedReconciliation.test.ts:350), introduce directamente un heartbeat 50 ms futuro. Reproduje que sigue pasando al sustituir la segunda lectura del reloj por `ahora`: la tolerancia lo enmascara. **Arreglo mínimo:** controlar el reloj durante la consulta y añadir una prueba que falle al reutilizar la hora anterior, junto con los límites de tolerancia.
- **Sí se perdió una garantía de compatibilidad:** [sondaActiva.test.ts:23](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/tpv/sondaActiva.test.ts:23) ahora exige que una marca antigua del JSON no vete. Sin migración de datos, consolida el defecto del punto 2.
- El test nuevo del controlador entrega `outcome` mediante un mock; comprueba que se copia, no que el wrapper lo calcule correctamente.

Las otras comprobaciones concretas quedaron así:

- **SQL e índices:** no encontré una pérdida necesaria del índice. El filtro conserva `attemptId IN (...)`, con [índice existente](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/prisma/schema.prisma:6068); las expresiones JSON no envuelven esa columna. `EXISTS` no necesita el antiguo `LIMIT 1`. **No medí el plan con `EXPLAIN`.**
- **Lista vacía:** correctamente manejada. Retorna `FALSE` antes de llamar a `Prisma.join`; comprobé el CAS generado con `AND NOT FALSE`.
- **`sondaReportoActiva`:** no encontré llamadas productivas comparando todavía contra `ahora`. El parámetro opcional restante se ignora. Una resolución anterior o igual mantiene el veto.
- **`UNKNOWN` con vencimiento muy lejano:** queda bloqueada hasta esa fecha. Los escritores actuales crean/renuevan vencimientos de cinco minutos; no encontré un flujo legítimo que necesite saltarse esa condición. Una fecha anómala requiere corregir su procedencia, no confiar en una marca inválida.

Ejecuté reproducciones en memoria con el código real y dobles de base de datos. **Jest no llegó a ejecutar las pruebas por `EPERM`; PostgreSQL también rechazó la conexión por permisos del entorno.** No doy por verificadas carreras reales ni planes de ejecución. No modifiqué archivos ni propongo reescribir `no-instrument-resolution.service.ts`. P2-5, P2-11, P2-13 y P2-14 quedan fuera del recuento.

Todavía puede aceptarse una declaración después de retirar prematuramente una protección sobre un cobro.  
Eso impide dar estos arreglos por seguros para destrabar ventas reales.  
No necesito ninguna decisión tuya para sustentar los hallazgos.
[1mhook:[0m [2mStop[0m
[1mhook:[0m [2mStop[0m
[1mhook:[0m [2mStop[0m Completed
[1mhook:[0m [2mStop[0m Completed
[2mtokens used[0m
188,172
**Veredicto: sigue RECHAZADO.** Audité el estado final de `develop`, HEAD `61a567f3`, contra `b932af34`.

| Cierre anunciado | Resultado |
|---|---|
| P1-3 · Procedencia también en el CAS | **Cerrado el escenario de ronda 2.** Lectura y escritura usan el mismo predicado. |
| P1-8 · Vencimiento antes de la marca de retorno | **Parcial.** Impide declarar antes de vencer, pero todavía acepta marcas de retorno inválidas. |
| P1-9 · `ACTIVE` durable y sin caducidad | **Parcial.** El helper está corregido; la migración y el momento de levantar el veto tienen defectos. |
| P1-10 · Replay con `claimedSuccess` | **Corregido ese `released:true` concreto.** Quedan otra respuesta contradictoria y señales externas sin consultar. |
| P2 · Heartbeat recibido durante la consulta | **Corregido en el código.** La tolerancia añadida abre otro caso y el test no demuestra la segunda lectura del reloj. |
| P2-12 · Campos de respuesta | **Cerrada la omisión.** Los campos aparecen; su contenido puede contradecir la evidencia actual. |

1. **P1 · Nuevo: se levanta el veto de `ACTIVE` antes de validar o guardar la resolución.**  
   [terminal-payment.service.ts:6442](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:6442)

   **Entrada → salida:** fila vencida con `probeActiveAt`; llega `RESOLVED` sin `finalResult`. Primero se confirma `probeResolvedAt`; después, la validación devuelve `false`. La siguiente declaración encuentra `probeResolvedAt > probeActiveAt` y escribe `FAILED/OPERATOR_RECONCILED_NO_CHARGE`.

   Reproducido: **respuesta rechazada por el manejador → veto levantado → declaración aceptada**.

   También se sella antes de tratar un `NOT_FOUND` con ACK previo: esa rama registra una contradicción y conserva el estado, pero ya quitó el veto.

   **Hay además un camino sobre un cobro ocurrido:** llega `RESOLVED/success` válido, se confirma la marca y, antes de que `closeRow` guarde el pago o `claimedSuccess`, otra instancia acepta la declaración. La marca retiró la protección antes de incorporar la información que la sustituye.

   **Arreglo mínimo:** validar primero; persistir el resultado y sus señales positivas antes de levantar el veto, bajo la misma exclusión/transacción. Un `NOT_FOUND` considerado contradictorio no debe sellarse como resolución acreditada.

2. **P1 · Nuevo: la migración pierde las observaciones `ACTIVE` existentes.**  
   [migration.sql:5](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/prisma/migrations/20260919010000_probe_active_observation/migration.sql:5) y [sondaActiva.ts:29](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/sondaActiva.ts:29)

   **Entrada → salida:** una fila contiene `resultJson.probeActiveAt` de hace un minuto, escrito por la versión anterior. La migración añade ambas columnas como `NULL`, sin trasladar la observación. El lector nuevo ignora el JSON y devuelve `false` → permite declarar sin ninguna respuesta posterior.

   Reproduje la aceptación con ese estado. El problema aplica cuando existen marcas del formato anterior; no comprobé si producción contiene alguna.

   **Arreglo mínimo:** migrar conservadoramente las marcas existentes y mantener compatibilidad de lectura mientras puedan coexistir escritores anteriores. Los valores antiguos ilegibles deben conservar el veto.

3. **P1-8 · Residual: una marca de retorno inválida sigue saltándose la validación.**  
   [uncharged-reconciliation.service.ts:157](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:157)

   **Entrada → salida:** el [barrido](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5201) recibe un heartbeat adelantado una hora y sella `terminalReturnedAt` antes del vencimiento real. La terminal desaparece. Una vez vencida la solicitud, la declaración retorna `true` por aquella marca, sin consultar el heartbeat ni comprobar que hubo retorno posterior al vencimiento.

   El caso original **antes de vencer sí está cerrado**. El sello inválido sigue siendo aceptado después.

   **Arreglo mínimo:** aplicar la validación temporal también a la rama con marca; no considerar suficiente su mera existencia. Las marcas producidas a partir de un heartbeat inválido necesitan revalidación.

4. **P1 · Nuevo: los 30 segundos pueden convertir un heartbeat anterior al vencimiento en uno posterior.**  
   [uncharged-reconciliation.service.ts:178](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:178)

   **Entrada → salida, con reloj adelantado exactamente 30 segundos:**

   - Vencimiento: `12:00:00`.
   - Último heartbeat recibido realmente: `11:59:45`; el aparato escribe `12:00:15`.
   - La terminal pierde conexión.
   - Declaración: `12:00:05`.

   La edad calculada es `−10 s`, dentro de la tolerancia, y `12:00:15 > expiresAt`. Se acepta aunque **no hubo ningún heartbeat después del vencimiento**. Reproducido.

   Los 30 segundos **no eluden el vencimiento contra el reloj servidor**; el hueco está en acreditar el retorno.

   **Arreglo mínimo:** usar la hora de recepción observada por servidor para esta condición. Si se mantiene una tolerancia de reloj, comprobar la posterioridad con su extremo conservador —por ejemplo, `latido − 30 s > expiresAt`—, además de validar ambas ramas del retorno.

5. **P1 · Replay: la respuesta todavía puede afirmar “no cobrado” con evidencia positiva.**  
   [terminal-payment.service.ts:5464](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5464) y [línea 5489](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:5489)

   Encontré dos variantes:

   **Nueva contradicción:** declaración aceptada → `claimedSuccess` durable → replay. Ahora devuelve correctamente `released:false`, pero `desenlaceCanonico` clasifica por el código anterior y responde:

   ```json
   {
     "released": false,
     "status": "FAILED",
     "outcome": "NOT_CHARGED",
     "outcomeEvidence": "OPERATOR_RECONCILED"
   }
   ```

   Reproducido con `claimedSuccess.authorizationCode = "103520"`.

   **Residual del replay:** declaración aceptada → se confirma un webhook aprobado del intento, pendiente de procesamiento/retención → replay mientras la solicitud conserva `FAILED/OPERATOR_RECONCILED_NO_CHARGE`. La devolución histórica [sale antes de los vetos](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/uncharged-reconciliation.service.ts:290), y el wrapper sólo consulta la solicitud. Responde `released:true`; no consulta los eventos positivos actuales. Reproduje que esas consultas no se ejecutan.

   **Arreglo mínimo:** conservar la resolución histórica, pero calcular conjuntamente `released`, `outcome` y `outcomeEvidence` desde la evidencia actual. Con afirmación positiva sin pago acreditado, devolver pendiente de confirmar; incluir los eventos/pagos cuya retención todavía no se refleja en la solicitud.

**Sobre las pruebas:**

- **El alias `hay` está bien encaminado.** En [unchargedReconciliation.test.ts:280](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/tpv/unchargedReconciliation.test.ts:280), comprobé que la orden devuelve su fila y la consulta de procedencia recibe `{hay:true}`. El rechazo es `POSITIVE_EVIDENCE_EXISTS`, no un fallo previo de pertenencia.
- **Ese test no demuestra el arreglo del CAS.** Rechaza antes del `UPDATE`; `$executeRaw` está simulado. Falta enfrentar una aprobación que aparece entre la lectura y la escritura.
- **P2 · El test del heartbeat prueba menos de lo que afirma.** En [línea 350](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/tpv/unchargedReconciliation.test.ts:350), introduce directamente un heartbeat 50 ms futuro. Reproduje que sigue pasando al sustituir la segunda lectura del reloj por `ahora`: la tolerancia lo enmascara. **Arreglo mínimo:** controlar el reloj durante la consulta y añadir una prueba que falle al reutilizar la hora anterior, junto con los límites de tolerancia.
- **Sí se perdió una garantía de compatibilidad:** [sondaActiva.test.ts:23](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/tests/unit/services/tpv/sondaActiva.test.ts:23) ahora exige que una marca antigua del JSON no vete. Sin migración de datos, consolida el defecto del punto 2.
- El test nuevo del controlador entrega `outcome` mediante un mock; comprueba que se copia, no que el wrapper lo calcule correctamente.

Las otras comprobaciones concretas quedaron así:

- **SQL e índices:** no encontré una pérdida necesaria del índice. El filtro conserva `attemptId IN (...)`, con [índice existente](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/prisma/schema.prisma:6068); las expresiones JSON no envuelven esa columna. `EXISTS` no necesita el antiguo `LIMIT 1`. **No medí el plan con `EXPLAIN`.**
- **Lista vacía:** correctamente manejada. Retorna `FALSE` antes de llamar a `Prisma.join`; comprobé el CAS generado con `AND NOT FALSE`.
- **`sondaReportoActiva`:** no encontré llamadas productivas comparando todavía contra `ahora`. El parámetro opcional restante se ignora. Una resolución anterior o igual mantiene el veto.
- **`UNKNOWN` con vencimiento muy lejano:** queda bloqueada hasta esa fecha. Los escritores actuales crean/renuevan vencimientos de cinco minutos; no encontré un flujo legítimo que necesite saltarse esa condición. Una fecha anómala requiere corregir su procedencia, no confiar en una marca inválida.

Ejecuté reproducciones en memoria con el código real y dobles de base de datos. **Jest no llegó a ejecutar las pruebas por `EPERM`; PostgreSQL también rechazó la conexión por permisos del entorno.** No doy por verificadas carreras reales ni planes de ejecución. No modifiqué archivos ni propongo reescribir `no-instrument-resolution.service.ts`. P2-5, P2-11, P2-13 y P2-14 quedan fuera del recuento.

Todavía puede aceptarse una declaración después de retirar prematuramente una protección sobre un cobro.  
Eso impide dar estos arreglos por seguros para destrabar ventas reales.  
No necesito ninguna decisión tuya para sustentar los hallazgos.
