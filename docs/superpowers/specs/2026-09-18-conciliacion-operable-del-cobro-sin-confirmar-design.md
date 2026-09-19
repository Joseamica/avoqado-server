# Conciliación operable del cobro sin confirmar

**Fecha:** 2026-09-18 · **Repos:** avoqado-server · MCP · (etapa 2: avoqado-android · avoqado-ios)
**Origen:** incidente de Testarudo del 18-sep — 26 minutos sin poder cobrar.
**Auditoría previa:** Codex gpt-6-astra xhigh, `AUTORIZADO CON CAMBIOS`
(`~/.claude-avoqado/jobs/9bb6b8e8/tmp/codex-diseno-veredicto.md`).

## El problema, medido

El 18-sep a las 16:23:34Z la Nexgo de Testarudo acusó un cobro de $65.00 + $9.75 y once segundos
después su app se reinició —AngelPay estaba desplegando la 2.10.0 en horario de venta, confirmado
por Norman—. La terminal volvió sin decir qué había pasado, el servidor dejó la solicitud en
`UNKNOWN` y **la cerca protegió la venta**: nadie pudo cobrarla dos veces. Eso funcionó.

Lo que no existía era la salida. El POS mostró «Cobro anterior sin confirmar» con dos botones que no
sacaban de ahí, la ranura de la terminal siguió ocupada, y **hubo que cerrar la fila a mano en
Postgres de producción**. 26 minutos parados (10:20 → 10:46 CDMX), cero pesos perdidos.

🔑 **La distinción que ordena todo el diseño:** el sistema sabe proteger el dinero y no sabe
devolverle la operación al cajero. Esto último es lo que se construye aquí, sin tocar lo primero.

## Decisión del founder (18-sep)

- **Comunicar el riesgo al cajero, pero nunca impedirle cobrar.** Es la misma regla que ya rige
  `AvisoDeCobrosPendientes` («decírselo, no impedírselo»).
- **Quien declara es el cajero**, no un gerente: en un mostrador a las 10 de la mañana puede no
  haber gerente, y esperar a uno es volver a estar parado.
- **Prioridad: que el negocio siga operando.** Si el cliente ya se fue, esa venta se cancela por el
  camino de cancelación que ya existe.
- **Miedo declarado, y es el correcto:** que esto rompa lo que hoy funciona en producción. De ahí
  las dos etapas y el carácter aditivo de todo el cambio.

## Alcance: UN botón, no tres

El diseño inicial tenía tres salidas (seguir cobrando · verifiqué que no se cobró · cancelar). Se
recorta a **una**, porque Codex demostró que las otras dos cuestan mucho y aportan poco:

- **«Seguir cobrando» por separado se descarta.** Salir del POS **no libera la terminal**: la fila
  `UNKNOWN` sigue ocupando la ranura hasta el destrabe de 20 minutos
  (`terminal-payment.service.ts:5221`, más el índice único que incluye `UNKNOWN`). El cajero podría
  atender otras ventas, pero no con esa terminal — que es justo lo que necesitaba. Además exigiría
  guardar varios pendientes a la vez, y hoy ambos POS admiten **uno solo**
  (`SecureStorage.kt:255`, `TerminalPaymentService.swift:388`).
- **«Cancelar esta venta» se descarta como botón nuevo:** ya existe el camino de cancelación, y
  Codex advierte que no puede afirmar «cerrada sin cobro» mientras el desenlace sea desconocido.

**La declaración libera las dos cosas de golpe** —la venta y la ranura—, que es exactamente lo que
hizo a mano el `UPDATE` del incidente. Con eso el cajero cobra a ese cliente si sigue ahí, o atiende
al siguiente con la misma terminal.

## Etapas

| | Qué entra | Quién la usa | Riesgo para producción |
|---|---|---|---|
| **1** | Servicio de conciliación en el servidor + el tool del MCP | Sólo el founder y yo | **Ninguno**: nada en la calle lo llama |
| **2** | El botón en el POS Android e iOS | El cajero | Llega con el siguiente APK, ya con la etapa 1 rodada |

## El servicio de conciliación (etapa 1)

Una sola operación, compartida por las dos puertas (POS y MCP). El MCP **no** implementa su propio
`UPDATE`: llama a la misma función, como ya hace con `releaseUnknownRequest`.

**Dónde vive:** se despacha dentro de `releaseUnknownRequest`, después de localizar la solicitud y
**antes** del filtro exclusivo de `UNKNOWN` (`terminal-payment.service.ts:5396`), delegando en un
servicio común. La comprobación definitiva va **dentro de la transacción**, inmediatamente antes del
`UPDATE`, y el veto se revalida en el propio `UPDATE`.

**Contrato:** una variante explícita de `/mobile/venues/:venueId/terminal-payment/:requestId/release`.
Las llamadas actuales, sin declaración, conservan su comportamiento exacto. 🔴 `reason` y
`confirm: true` **no** se interpretan como declaración implícita.

**Nombre propio:** la declaración es «verifiqué que no se cobró», con su propia versión inmutable.
**No** se reutiliza `NO_INSTRUMENT_PRESENTED` (`no-instrument-resolution.service.ts:36`), que
significa «no se presentó tarjeta» — otra cosa.

### Lo que el servidor comprueba antes de aceptar

1. **Identidad y pertenencia:** la solicitud exacta, el venue autorizado, la terminal normalizada y
   la orden del mismo venue. Intentos vinculados coherentes; **nunca fabricar un `attemptId`** para
   una solicitud antigua que no lo tiene.
2. **Quién declara:** cajero autenticado y activo en ese venue, con un permiso efectivo concedido al
   rol cajero. Hoy `/release` exige `tpv:update` y el permiso de declaración vive en gerencia
   (`permissions.ts:1003`): ambos se ajustan para esta operación.
3. **Veto positivo COMPLETO** — si hay cualquiera de estas señales, la declaración se rechaza y se
   explica: `Payment` por puntero, por solicitud, por etiqueta legacy o por llave de intento;
   webhook aprobado aunque no exista `Payment`; `processorEvidence = APPROVED`; señales de
   aprobación en `resultJson`/`claimedSuccess`; retenciones y contradicciones de procedencia. Se
   revisan **todos** los intentos relacionados, no uno elegido arbitrariamente.
4. **Atomicidad e idempotencia:** misma transacción y jerarquía de candados que el registro;
   `resolutionId` estable; declaración inmutable; un asiento de auditoría con staff, solicitud,
   orden, terminal, fuente (POS o MCP) y estado previo.

### 🔴 La tensión que este diseño asume a propósito

Codex exige además **prueba de cese de ejecución**: que conste que el intento ya no sigue corriendo
en la terminal, y que `ACTIVE`, la ausencia de `Payment`, un reinicio, un latido o el tiempo
transcurrido **no bastan** (`terminal-payment.service.ts:6321`). Tiene razón, y hoy el APK instalado
**no sabe emitir esa prueba**.

La decisión es explícita: **la declaración del operador ocupa el lugar de esa prueba, y por eso es
evidencia de clase `OPERATOR` y no `TERMINAL` ni `SERVER`.** Un humano miró la pantalla del aparato.
Eso es más débil que una prueba técnica y por eso queda auditado con su nombre, se veta ante
cualquier señal positiva, y **exige además que la terminal haya vuelto** (`terminalReturnedAt` no
nulo) para no declarar sobre un cobro que sigue en curso.

Lo que NO se hace: aceptar la declaración de una solicitud cuyo intento la terminal reporta `ACTIVE`
en la sonda. Ahí se responde que el cobro sigue corriendo y se pide reintentar en unos segundos.

## Lo que la declaración escribe, exactamente

`status = FAILED`, `failureCode = OPERATOR_RECONCILED_NO_CHARGE`. **Confirmado por Codex contra los
predicados reales**, no por el precedente del incidente: esa pareja sale del bloqueo heredado
(`terminal-payment.service.ts:549`), del estricto —porque `OPERATOR_RECONCILED_NO_CHARGE` **está** en
`CODIGOS_SIN_COBRO`, así que la rama de `FAILED` no entra (`:428`, `:474`, `:590`)— y del índice único,
que sólo cubre `PENDING/SENT/CANCEL_REQUESTED/UNKNOWN`
(`20260713161534_add_terminal_payment_request/migration.sql:41`). La proyección devuelve `NOT_CHARGED`,
evidencia `OPERATOR_RECONCILED`, clase `OPERATOR` (`:822`).

🔴 **No basta con tocar esas dos columnas:** hay que escribir un sobre de respuesta coherente y limpiar
`cancelDisposition`, como hace el precedente (`no-instrument-resolution.service.ts:271`,
`terminal-payment.service.ts:1070`). Si no, queda una respuesta vieja en `resultJson` contradiciendo el
desenlace.

## La excepción a «nunca impedirle cobrar», reconocida

El recorte resuelve el caso normal, **no todos**. Caso concreto que Codex identificó: se declara A,
el cajero cobra B, y después llega una aprobación tardía de A sin `Payment` registrable. El servidor
devuelve A a `TIMED_OUT/BANK_APPROVED_AWAITING_PAYMENT` —o `PAYMENT_UNBOUND_AWAITING_REVIEW` si hay
pago que no puede ligar— y **ambos vuelven a bloquear la terminal en los dos regímenes**
(`terminal-payment.service.ts:4420`, `:523`, `:4622`).

Se declara en vez de prometer lo contrario: la declaración destraba lo que se sabe hoy; si mañana
aparece dinero de esa venta, la terminal vuelve a pedir conciliación. Y una declaración sobre A no
resuelve otras solicitudes que bloqueen la misma orden (`:1678`).

## El veto por `ACTIVE`, y por qué hoy no basta

El spec rechaza la declaración si la sonda dice que el cobro sigue corriendo. 🔴 **Hoy eso no se puede
consultar:** `ACTIVE` sólo se escribe en el log y la función retorna, sin dejar dato durable
(`terminal-payment.service.ts:6321`). Hay que persistir esa respuesta autenticada para que la
declaración la lea, y **no depender del barrido de las primeras 25 filas** (`:6243`), que además
arrastra el problema de inanición ya conocido.

## Elegibilidad: `terminalReturnedAt` no cubre todos los estados

Hoy sólo se estampa sobre filas `UNKNOWN` (`terminal-payment.service.ts:5189`). Una `TIMED_OUT`
todavía incierta puede quedar **inelegible para siempre** aunque la terminal esté conectada. Hay que
definir cómo se observa el retorno para todos los estados admitidos, o la conciliación no alcanzará a
las filas legacy — que son justo las que hoy hay que limpiar.

⚠️ Y `terminalReturnedAt` **no prueba el cese**: se escribe al ver un latido posterior al vencimiento,
o sea acredita conectividad, no que el SDK terminó (`:5184`, `schema.prisma:5093`). Es parte de la
tensión asumida arriba.

## Persistencia de la declaración con solicitudes legacy

La declaración inmutable vive hoy en `TerminalPaymentAttemptLink` y el servicio **exige que exista el
vínculo** (`schema.prisma:5135`, `no-instrument-resolution.service.ts:176`). Para solicitudes sin
intento ligado hace falta guardarla y consultarla **por solicitud y `resolutionId`**, fuera del sobre
mutable, sin fabricar vínculos.

## Sin red

| | Sin conexión al servidor |
|---|---|
| Declarar «verifiqué que no se cobró» | **Online-only a propósito.** La pantalla lo dice: «Necesitas conexión para confirmar esta declaración». **No** libera en local ni encola la declaración para aceptarla sola después |
| Seguir cobrando otras ventas | 🔴 **Hoy NO se puede prometer.** El pendiente local intercepta el flujo **antes** de elegir medio de pago en ambos POS (`PaymentFlowViewModel.kt:840`, `PaymentFlowViewModel.swift:246`), así que con un pendiente vivo el mismo aparato tampoco cobra en efectivo sin red. Es una limitación anterior a este trabajo, no introducida por el online-only, y queda declarada en vez de tapada |

🔴 **El recorte NO elimina la navegación de salida existente.** «Un solo botón» describe la
conciliación, no la pantalla: quitar la salida actual empeoraría el caso sin red
(`PaymentResultScreen.kt:677`, `PaymentResultViews.swift:1417`).

🔴 **Por qué no se encola:** una declaración reproducida tarde podría caer sobre una venta que
entretanto sí se cobró. Se persiste el `resolutionId` **antes** del POST para poder recuperar el
desenlace si la app muere; al reconectar se consulta qué se aceptó. Una declaración que nunca llegó
a aceptarse **exige que el cajero la confirme de nuevo**.

## Aprobación tardía

Si después de la declaración llega dinero de esa solicitud: la declaración **se conserva** (es lo que
el cajero afirmó, y su valor es justamente ése), el resultado se actualiza, se avisa al cajero sobre
esa venta y queda 🚨 para conciliar. Ya existe tratamiento de aprobaciones posteriores a una
declaración (`terminal-payment.service.ts:1439`); su texto presupone «no se presentó tarjeta» y se
amplía.

## Detalles de implementación que Codex exige concretar

- **El veto no es una consulta ya hecha:** `sinEvidenciaPositivaSql` cubre aprobaciones vinculadas y
  pagos con tarjeta `COMPLETED`, pero **no** todas las contradicciones ni los pagos `PENDING` de
  conciliación (`evidenciaPositivaSql.ts:64`, `:128`, `:149`). El veto completo del spec hay que
  construirlo.
- **Candados en orden:** solicitud → intentos enumerados dentro y ordenados → orden/fila. No basta
  copiar el candado de un único intento (`candadoDeIntento.ts:26`, `terminal-payment.service.ts:3893`).
- **El MCP tiene su propio filtro de `UNKNOWN`** antes de llamar al servicio (`mcp/tools/terminals.ts:496`,
  `:521`): hay que despachar allí la variante, conservando vista previa y confirmación humana.
- **El permiso del cajero habilita esta operación concreta**, sin concederle `tpv:update` global
  (`mobile.routes.ts:1704`).
- **El aviso al cajero no existe:** el tratamiento de aprobación tardía manda `sendOpsAlert`, que es
  correo a operaciones, no un aviso durable en el aparato (`terminal-payment.service.ts:1448`).
- **Textos que mienten en etapa 2:** ambos POS tienen hardcodeado «no se presentó tarjeta» para
  `OPERATOR_RECONCILED` (`CardChargeOutcome.kt:279`, `CardChargeOutcome.swift:379`).

## Lo que NO se toca

El camino del cobro, la libreta de intentos, la ventana de confirmación, el clasificador del SDK
1.0.19 y la cerca contra recobros (`UNRESOLVED_FINANCIAL_OUTCOME`). Todo eso es lo que el 18-sep
evitó el cobro doble.

## Declarado fuera de alcance

- **Las tres puertas de recobro que Codex encontró** (rehacer la cuenta desde el carrito, Pago rápido
  sin orden, y `payCashOrder`, que no consulta `UNRESOLVED_FINANCIAL_OUTCOME`,
  `order.mobile.service.ts:2438`). Son anteriores a este trabajo y merecen el suyo.
- La paginación de la sonda, hoy fija en las 25 filas más antiguas (`terminal-payment.service.ts:6243`).
- El candado del downgrade destructivo (`DatabaseModule.kt:150`), que va aparte y antes.
- Varios pendientes a la vez en el POS.
- Impedir que se instale un APK con un cobro en vuelo.

## Pruebas

TDD, con la prueba en rojo primero. Mínimo: cada señal del veto positivo rechaza la declaración ·
una solicitud de otro venue no se acepta · dos declaraciones de la misma solicitud son idempotentes ·
una aprobación tardía no borra la declaración ni se pierde · las llamadas antiguas de `/release`
conservan su comportamiento · la terminal que no ha vuelto no se puede declarar. Más sabotajes, cada
uno roto a propósito, y auditoría de Codex antes de commitear.
