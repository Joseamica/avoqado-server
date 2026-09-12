# Diseño: recuperación A (identidad de bandeja), respaldo B (conciliación), pendientes del §8 y Nexgo — 11-sep-2026

Estado: **v3** (11-sep, noche): v2 + el veredicto del auditor independiente (sección I, que MANDA sobre lo anterior
cuando se contradicen). Antes: **BORRADOR v2** (11-sep, tarde) — v1 más las correcciones de la sección H, que salen de la auditoría parcial de
Codex (se quedó sin créditos) y de su verificación por otra sesión y por mí. Nada de A ni de B implementado. Sin commit,
push ni deploy.

Decisión del founder (11-sep), literal en lo esencial:
> «Elijo A como recuperación automática y B como respaldo; descarta C.» A: el servidor guarda el identificador de la
> bandeja antes de enviar, ligado a terminal y solicitud; sobrevive reinicios normales; pérdida o restauración (también
> de una copia antigua con el mismo identificador) invalida la identidad; NOT_FOUND libera sólo con continuidad
> acreditada de esa misma bandeja, y la terminal guarda durablemente que esa solicitud ya no se ejecutará antes de
> responder; identificador cambiado, información faltante o solicitud histórica ⇒ no se libera; A no resuelve
> intentos de APK antiguos. B: conciliación documentada y confirmación de que el intento ya no puede autorizar; la
> ausencia en el portal, sola, no basta. Pruebas: ACK perdido, reinicio, borrado de datos, restauración de copia
> antigua, entrega retrasada y respuestas duplicadas, con Postgres real y PAX/Nexgo. Continuar el §8.

Fuentes de este diseño (mapas de solo lectura del 11-sep, 7 frentes): `tpv-identidad`, `server-a-b`,
`server-contrato`, `server-rutas`, `tpv-n3`, `android-cancel`, `ios-cancel` (en el scratchpad de la sesión), el
informe del agente de Nexgo (T26) y la evidencia de la sesión hermana `error_terminal_atascada`.

---

## 0. Datos medidos que condicionan el diseño

| Dato | Valor | Fuente |
|---|---|---|
| Filas de producción que el servidor del árbol bloquearía el día del despliegue | **375**: CANCELLED sin disposición 343, FAILED TPV_ERROR 30, TIMED_OUT 2 | `TerminalPaymentRequest` en producción, sólo lectura, 11-sep |
| COMPLETED en producción | 1 046, todas con `paymentId` | idem |
| Borrado de filas de la bandeja de la TPV | **Ninguno** en el DAO. Sólo `FACTORY_RESET` borra la base entera (`CommandExecutor.kt:1070`) | árbol TPV |
| Carpeta `noBackupFilesDir` tras `FACTORY_RESET` | **Sobrevive** (el comando borra bases, caché y prefs, no esa carpeta) | idem |
| Room ante una versión anterior (downgrade) | **Destructivo**: `DatabaseModule.kt:162` configura `fallbackToDestructiveMigrationOnDowngrade()`. Un downgrade (p. ej. `INSTALL_VERSION` a un APK viejo) borra la base entera: bandeja, libreta, `pending_payments` y `pending_refunds`. (v1 decía lo contrario: mi búsqueda falló por la sintaxis de zsh; lo corrigió Codex) | árbol TPV |
| Llave de terminal en el servidor | `TerminalPaymentRequest.terminalId` = serial en minúsculas sin `AVQD-` | `schema.prisma:5040` |

---

## A. Identidad de bandeja (recuperación automática)

### A.1 La idea en una frase

Cada bandeja durable de una TPV tiene un **identificador** y un **contador** que sube en cada escritura. La terminal
guarda una copia del contador **fuera** de la base, en una carpeta que ninguna copia de seguridad restaura. Si la base
vuelve atrás (restauración, pérdida), las dos cifras no cuadran y la terminal **estrena identidad**. El servidor
anota a qué identidad entregó cada solicitud y sólo acepta un «no la tengo» de **esa misma identidad**, sin retroceso.

### A.2 TPV: dónde vive la identidad

- **Fila centinela** dentro de `remote_payment_requests` (`request_id = "__avoqado_inbox_identity__"`,
  `status = "INBOX_IDENTITY"`), con `{inboxId, counter}` en `final_result_json`.
  - Por qué en la MISMA tabla y no en una propia: el downgrade YA es destructivo (`DatabaseModule.kt:162`) y Room
    borra las tablas que conoce la versión vieja; una tabla de identidad nueva sobreviviría y fingiría continuidad sobre
    una bandeja vacía. Dentro de la tabla de solicitudes, se va con ellas y el arranque rota («M sin S»).
  - Toda consulta de la bandeja debe excluir el centinela: `receive`, `probe`, `cancel`, conteos de obligaciones,
    barridos. El `requestId` reservado se rechaza en `receive` y nunca se contesta en `probe`.
- **Contador**: `Long`, sube en **cada** mutación de la tabla (recibir, reclamar, resolver, lápida, cancel CAS,
  cuarentena), dentro de la **misma** transacción Room que la mutación. `RemotePaymentInbox` es el único escritor.
- **Espejo** en `context.noBackupFilesDir/remote_payment_inbox_identity.json`: `{v:1, inboxId, counter, sha256}`.
  Escritura atómica (temporal + `fsync` + `rename`), bajo `Mutex`, **sólo hacia arriba** (nunca baja el contador de la
  misma identidad).
- **Orden obligatorio**: commit de Room → `fsync` del espejo → efecto visible (ACK, respuesta de sonda, disposición de
  cancel, emisión de resultado, arranque del SDK). Si el espejo falla, no hay efecto visible positivo:
  - al recibir: `accepted:false` (el servidor ya trata eso como ACK_REJECTED ⇒ UNKNOWN);
  - en la sonda NOT_FOUND: no se contesta (el servidor conserva la reserva);
  - al reclamar: no se abre el SDK; la fila queda PROCESSING y contesta ACTIVE (conciliación B, rarísimo).

### A.3 TPV: verificación al arrancar (antes de conectar el socket)

S = centinela en Room, M = espejo.

| Caso | Decisión |
|---|---|
| S y M presentes, mismo `inboxId`, S.counter ≥ M.counter | **Continua**. Si S > M (se cayó entre commit y espejo), se sube M |
| Ni S ni M | **Crear** identidad (instalación nueva o primera corrida de este APK) |
| S sin M | **Rotar** (base restaurada en instalación nueva, o carpeta noBackup perdida) |
| M sin S | **Rotar** (base borrada: FACTORY_RESET, borrado de la base) |
| `inboxId` distinto | **Rotar** |
| Mismo `inboxId`, S.counter < M.counter | **Rotar** (se restauró una copia más vieja; también detecta un corte de luz que perdió transacciones) |
| Espejo ilegible o con checksum inválido | **Rotar** (lado conservador) |

**Rotar** = `inboxId` nuevo (UUID aleatorio), contador desde 0, y **cuarentena**:
- filas `RECEIVED` ⇒ `RECEIVED_PRE_ROTATION`: nunca se reclaman; la sonda contesta **ACTIVE** (su destino es
  desconocido: pudieron ejecutarse después de la copia); una reentrega contesta ACK sin ejecutar;
- `PROCESSING` sigue contestando ACTIVE (como hoy);
- `RESOLVED` reproduce su resultado (es un hecho; el servidor valida con `closeRow`);
- lápidas se conservan (sólo bloquean).
La rotación se reporta: no fatal a Crashlytics con el motivo y el identificador viejo, y el servidor la ve en el handshake.

Límite declarado: una copia **completa** del directorio de datos, espejo incluido, hecha con root, es indetectable para
la terminal. La marca de agua del servidor (A.5) la detecta si el servidor vio un contador mayor después de la copia.

### A.4 TPV: qué viaja

- Handshake: `terminalPaymentInboxVersion: '1'`, `terminalPaymentInboxId`, `terminalPaymentInboxCounter`. Sólo después
  de la verificación del arranque; si falló, no se anuncia identidad. En reconexiones automáticas el valor queda
  congelado: el servidor lo trata como **cota inferior**.
- ACK de `terminal:payment_request`: `inboxId`, `inboxCounter` (el valor tras persistir).
- Respuesta de la sonda: `inboxId`, `inboxCounter` y `tombstone: true` cuando contestó NOT_FOUND tras escribir la lápida.
- Disposición de cancel: `inboxId`, `inboxCounter`.

### A.5 Servidor: tabla y observación de identidad

Tabla nueva `TerminalPaymentInbox`: `id`, `terminalKey` (misma normalización que `TerminalPaymentRequest.terminalId`),
`inboxId`, `inboxVersion Int`, `status` (`ACTIVE` | `DISCONTINUED`), `maxCounterObserved BigInt`, `firstSeenAt`,
`lastSeenAt`, `lastVenueId`, `discontinuedAt?`, `discontinuedReason?` (`SUPERSEDED` | `COUNTER_REGRESSION` |
`OPERATOR`), `supersededByInboxId?`. `@@unique([terminalKey, inboxId])`, índice único parcial «un ACTIVE por
terminalKey». Migración a mano, idempotente, con `SCHEMA_MAP` regenerado.

`observeInboxIdentity` al conectar, bajo `pg_advisory_xact_lock(hashtextextended('tpr-inbox:'||terminalKey,0))` (prefijo
propio, distinto del de la admisión):
- identidad nueva ⇒ se crea ACTIVE; la ACTIVE anterior pasa a DISCONTINUED(SUPERSEDED) con `ActivityLog`;
- identidad conocida DISCONTINUED ⇒ sigue DISCONTINUED (**nunca se reactiva**) y el socket queda **no confiable**;
- identidad ACTIVE con contador < `maxCounterObserved` ⇒ DISCONTINUED(COUNTER_REGRESSION), 🚨, `ActivityLog`,
  alerta a ops, socket no confiable;
- identidad ACTIVE sin retroceso ⇒ sube la marca (`updateMany` con `lt`) y el socket queda **confiable**.
Sólo se acepta identidad de un handshake con serial acreditado. En el arranque del socket el orden pasa a ser
secuencial: observar identidad → replay → sonda (hoy replay y sonda corren en paralelo).

`terminalRegistry.register` pasa a recibir un objeto de opciones (hoy 8 posicionales con 3 llamadores de aridades
distintas) con los campos de identidad y `inboxTrusted`.

### A.6 Servidor: qué se guarda por entrega

Cada entrada de `deliveryProvenance.deliveries[]` (escrita ANTES del emit, como hoy) agrega `inboxVersion`, `inboxId`,
`inboxTrusted` y `inboxCounterAtDelivery` (la marca del servidor en ese instante). `leerProcedencia` acepta entradas
viejas sin esos campos; tipos equivocados ⇒ procedencia desconocida (`null`), igual que hoy.

### A.7 Servidor: posesión («la terminal ya la tenía»)

Columna nueva `TerminalPaymentRequest.terminalHeldAt DateTime?`. Se marca con: ACK (normal y de replay), cualquier
disposición de cancel, cualquier resultado de pago, y sonda RESOLVED / ACTIVE / RECEIVED_CANCELLED. Sin esta columna,
una bandeja que contestó ACTIVE, o que mandó un resultado sin evidencia, podría contestar NOT_FOUND después y liberarse.

### A.8 Servidor: la regla de liberación por continuidad

En `handleProbeResultFromSocket`, rama NOT_FOUND, **antes** de la rama «no acreditable». Aplica sólo si TODO se cumple:
1. la procedencia existe y tiene ≥ 1 entrega;
2. todas las entregas son DURABLE, con `inboxVersion ≥ 1`, `inboxTrusted`, y el **mismo** `inboxId` = X;
3. el socket que contesta es confiable y su `inboxId` = X, y el evento trae `inboxId` = X;
4. el evento trae `tombstone === true` y `inboxCounter` entero;
5. en una transacción: `SELECT … FOR UPDATE` de la fila X de `TerminalPaymentInbox`; exige ACTIVE y
   `maxCounterObserved ≤ inboxCounter` del evento (si no, la pasa a DISCONTINUED y no libera); sube la marca;
6. CAS sobre `TerminalPaymentRequest`: `id`, `acknowledgedAt IS NULL`, `lastDeliveredAt IS NULL`,
   `terminalHeldAt IS NULL`, fuera de vuelo y dentro de `SIN_DESENLACE_ACREDITADO` ⇒ `FAILED`,
   `failureCode = 'TPV_INBOX_NOT_FOUND'`, evidencia `NOT_FOUND_CONTINUOUS_INBOX`.
Cualquier otro NOT_FOUND ⇒ sin cambio y auditoría única con el motivo (`OTHER_INBOX`, `INBOX_DISCONTINUED`,
`COUNTER_REGRESSION`, `NO_TOMBSTONE`, `POSSESSION`, `LEGACY_OR_UNKNOWN_PROVENANCE`).

Consecuencias que exige el founder:
- identificador cambiado ⇒ regla 2/3 falla ⇒ no libera;
- información faltante ⇒ reglas 1/4 fallan ⇒ no libera;
- solicitud histórica o de APK antiguo (entregas sin `inboxId`) ⇒ regla 2 falla ⇒ no libera. A no es retroactivo.

### A.9 Servidor: replay restringido a la misma bandeja

`replayPendingForTerminal` reentrega una fila en vuelo sólo si todas sus entregas previas son DURABLE y tienen el mismo
`inboxId` que el socket actual confiable. Saltos nuevos auditados una vez: `OTHER_INBOX`, `INBOX_IDENTITY_CHANGED`,
`NO_INBOX_IDENTITY` (entregas con identidad y socket sin ella, o al revés).

Excepción declarada: si NI las entregas NI el socket tienen identidad (APK 2.9.x), se conserva el replay del plan D.
Riesgo residual: un 2.9.x borrado y reconectado dentro de la vigencia de 5 min podría reejecutar. En la práctica un
borrado también quita la activación y la reactivación tarda más que la vigencia. Se cierra al instalar el APK nuevo.

### A.10 Pruebas de A (exigidas por el founder)

Integración contra PostgreSQL real (`codex_testarudo_test_20260909`), en `terminalPaymentRecovery.integration.test.ts`:

| Escenario | Qué se comprueba |
|---|---|
| ACK perdido | Entrega DURABLE a X sin ACK ⇒ sonda NOT_FOUND de X con lápida y contador ≥ marca ⇒ FAILED/TPV_INBOX_NOT_FOUND. Con ACK registrado ⇒ contradicción, sin cambio |
| Reinicio | El socket vuelve con la misma X y contador mayor ⇒ confiable ⇒ libera igual |
| Borrado de datos | El socket vuelve con Y ⇒ X pasa a SUPERSEDED ⇒ NOT_FOUND de Y no libera; replay a Y no reentrega |
| Copia antigua, mismo id | Handshake de X con contador < marca ⇒ COUNTER_REGRESSION ⇒ no libera, nunca se reactiva |
| Entrega retrasada | Tras la liberación, un ACK o un resultado tardío no reabren silenciosamente (🚨 por los caminos existentes) |
| Respuestas duplicadas | Dos NOT_FOUND idénticos ⇒ una sola transición y una sola auditoría |
| Carrera | Handshake que descontinúa X contra la respuesta de la sonda de X (candado sobre la fila de X) |
| Posesión previa | ACTIVE o disposición previa ⇒ NOT_FOUND posterior no libera |
| Dos bandejas en la misma fila | Entregas a X y a Y ⇒ no libera |

TPV (unitarias con Room de Robolectric y el espejo en un directorio temporal): la tabla del arranque completa; el
contador sube en cada mutación dentro de la transacción; el espejo nunca baja; el efecto visible no ocurre si el espejo
falla; cuarentena al rotar; lápida + espejo antes de contestar NOT_FOUND.

Físicas (PAX y Nexgo, sin tarjeta salvo que se diga): reinicio de la app; copia de la base con `run-as` y
restauración posterior (rota: S < M); `FACTORY_RESET` (rota: M sin S); ACK perdido con el servidor soltando el ACK a
propósito en una rama de QA; entrega tardía emitida desde el servidor tras la lápida. El borrado sólo en una terminal
de QA con inventario previo de bandeja, libreta y colas.

---

## B. Liberación manual con conciliación documentada (respaldo)

### B.1 Qué exige

Una fila sin desenlace acreditado (fuera de vuelo) se libera por B sólo con **dos** partes, las dos obligatorias:

1. **Revisión del procesador**: proveedor (`BLUMON_TPV` | `ANGELPAY`), cuándo se revisó, ventana buscada, por qué se
   buscó (posId o serial), importe buscado, resultado (`NO_OPERATION` | `DECLINED` | `REVERSED` | `VOIDED`), referencia
   de operación si existe, y referencia de la evidencia (texto o archivo privado).
2. **Base de que el intento ya no puede autorizar** (al menos una):
   - `TERMINAL_FINAL_ANSWER` — el servidor tiene registrada una respuesta no ACTIVE de la terminal para esa solicitud
     (sonda RESOLVED / RECEIVED_CANCELLED / NOT_FOUND, o disposición ACCEPTED / ALREADY_RESOLVED), posterior a la última
     entrega. **La verifica el servidor**, no el operador. Requiere guardar en la fila la última respuesta:
     `lastProbeDisposition`, `lastProbeAt`, `lastProbeInboxId`.
   - `DEVICE_DECOMMISSIONED` — `FACTORY_RESET` después de la entrega **y** el servidor vio después, en esa terminal,
     una identidad de bandeja DISTINTA a la de la entrega (prueba de que la base se fue y el proceso se reinició). El
     «completed» del comando NO basta: la TPV lo manda ANTES de borrar (`CommandExecutor.kt:1055`), y el borrado va en
     un try/catch que se traga el fallo (`:1070`). Ver H.2.
   - `DEVICE_INSPECTED` — alguien revisó el aparato: no está en pantalla de cobro y la bandeja o la libreta muestran el
     intento cerrado. Declaración con texto obligatorio y evidencia opcional.
   - `LEGACY_NO_RESUME` — sólo para entregas LEGACY o de procedencia desconocida: el servidor nunca las reentrega
     (hecho de código) y la app se reinició después (declarado con evidencia, p. ej. inicio de sesión en Crashlytics).
   `INBOX_SUPERSEDED` **no basta sola**: dos variantes de la app en el mismo serial se turnan la identidad sin perder su
   bandeja.

Si existe un `Payment` para ese `requestId`, no hay B: se concilia a COMPLETED como hoy.
El servidor muestra los **candidatos**: pagos con tarjeta de la orden posteriores a la solicitud, y pagos del mismo
serial con el mismo importe en la ventana (aunque no traigan `requestId`). El operador tiene que descartar cada
candidato explícitamente o B se rechaza.

### B.2 Dónde queda

Tabla nueva, sólo se agregan filas: `TerminalPaymentConciliation` con la solicitud, el actor (staff, rol, origen:
`MOBILE` | `DASHBOARD` | `SUPERADMIN` | `MCP`), la foto previa de la fila, la revisión del procesador, la base, los
candidatos descartados y la fecha. Se escribe **en la misma transacción** que libera. La evidencia nunca va a
`resultJson` (ese sale a las tablets).

Estado final: `FAILED`, `failureCode = 'OPERATOR_RECONCILED_NO_CHARGE'`, evidencia `OPERATOR_RECONCILED`
(desenlace canónico NOT_CHARGED, clase OPERATOR). Después del commit: `ActivityLog`
`TERMINAL_PAYMENT_MANUAL_RELEASE` con `conciliationId`, 🚨 y alerta a ops.

### B.3 Servicio, rutas y permiso

- `releaseByConciliation` sustituye a `releaseUnknownRequest` (que queda como envoltura). Elegibles: toda fila fuera de
  vuelo con desenlace UNRESOLVED (no sólo UNKNOWN). Rechaza: en vuelo, última sonda ACTIVE, candidatos sin descartar,
  base no verificable. Todo en una transacción: candado de terminal, `FOR UPDATE` de la orden si hay, `FOR UPDATE` de
  la fila, relectura de `findReconcilablePayment`.
- **Modo lote**: N filas con una misma revisión del procesador (un exporte del portal para una ventana) y una base por
  fila. Es lo que necesitan las 375 filas históricas.
- Permiso nuevo `terminal-payments:reconcile`: OWNER y ADMIN (SUPERADMIN por `system:manage`). **No** MANAGER: el
  permiso de piso `tpv:update` no gobierna una acción administrativa. La ruta móvil actual (`tpv:update`) conserva sólo
  la conciliación a COMPLETED cuando hay `Payment`.
- Rutas: superadmin y móvil con Zod; tool MCP `release_terminal_payment` con vista previa, candidatos y confirmación en
  dos pasos (`requireWriteScopeAlways`); `TPR_ACTIVE` del MCP sustituido por el predicado exportado del servicio.
- Vigilancia de dinero tardío: incluye `OPERATOR_RECONCILED_NO_CHARGE` y `TPV_INBOX_NOT_FOUND` durante 72 h, y avisa
  (sin cerrar nada) de pagos sin `requestId` del mismo serial, importe y ventana.

Pendiente de UI: ningún cliente llama hoy a la liberación. API + MCP primero; la pantalla la decide el founder.

---

## C. §8 — Contrato GET / POST cancel

### C.1 Desenlace canónico (una sola función, lista blanca)

`desenlaceCanonico(row)` exportada del servicio. Nombres acordados para servidor, Android e iOS:

| Campo nuevo (todos opcionales) | Valores |
|---|---|
| `outcome` | `CHARGED` · `NOT_CHARGED` · `UNRESOLVED` |
| `outcomeEvidence` | `PAYMENT_RECORDED` · `PROCESSOR_DECLINED` · `PRE_AUTHORIZATION` · `CANCEL_ACCEPTED` · `NEVER_DELIVERED` · `NOT_FOUND_CONTINUOUS_INBOX` · `OPERATOR_RECONCILED` · `null` |
| `evidenceClass` | `TERMINAL` · `SERVER` · `OPERATOR` · `null` |
| `failureCode` | crudo, sólo diagnóstico (las apps no deciden con él) |
| `reconciliationRequired` | booleano, p. ej. COMPLETED con `CONTRACT_MISMATCH` |

Reglas por lista blanca: COMPLETED con `paymentId` ⇒ CHARGED; FAILED con un código de la lista blanca y su evidencia
⇒ NOT_CHARGED; CANCELLED con `cancelDisposition = ACCEPTED` ⇒ NOT_CHARGED; **todo lo demás ⇒ UNRESOLVED**, incluidos
códigos desconocidos o nulos. El implementador enumera TODOS los escritores de `failureCode` del árbol y clasifica cada uno.

- `status` se sigue devolviendo con sus valores de siempre; FAILED o CANCELLED con `outcome = UNRESOLVED` se traducen a
  `UNKNOWN` (protege a las apps publicadas, que leen FAILED/CANCELLED como «no se cobró»).
- `cancelDisposition` se proyecta `null` cuando `outcome ≠ UNRESOLVED` (hoy una fila rechazada por el banco tras un
  cancel ACTIVE deja a las apps del árbol en «sigue activo» para siempre).
- El predicado de bloqueo (`UNRESOLVED_FINANCIAL_OUTCOME`) queda **equivalente** a «fuera de vuelo y outcome UNRESOLVED»,
  con una prueba de tabla que falla si divergen. En producción no cambia nada: sólo existen TPV_ERROR, TIMED_OUT y
  CANCELLED sin disposición.
- `resultFromRow` (réplica del POST) y el MCP usan la misma función.

### C.2 POST /terminal-payment/cancel

HTTP 200 como hoy. Se conservan `success` y `message`; se agregan `requestId`, `cancelIntent`
(`RECORDED` · `ALREADY_FINAL` · `NOT_FOUND` · `MISSING_REQUEST_ID`), `cancelEmitted` (emitido a un socket del registro:
**no** prueba recepción) y `payment` (la misma proyección del GET, releída tras el CAS). El texto de `message` se precisa
por caso.

### C.3 Códigos antes de crear la fila

- El 400 `ORDER_CANCELLED_NO_NEW_CHARGE` sale del controlador con `code` y `details.requestId` (hoy se pierden en
  `terminal-payment.mobile.controller.ts:179-184`).
- Se busca la fila del mismo `requestId` **antes** de comprobar el registro de la terminal: si existe, réplica; si no
  existe y la terminal no está conectada ⇒ 404 `TERMINAL_NOT_CONNECTED` con `details.requestId`, que ahora sí prueba
  «no se creó». Cierra el P1-3 de la auditoría (llave irresoluble en el POS).

### C.4 Cancelación durable en Android e iOS (cambiados juntos)

Semántica única de «Cancelar» en «Cobrar en terminal»: **cancelar el cobro y, sólo cuando conste que no se cobró,
cancelar la orden si la creó este mismo flujo**. Nunca la cuenta de una mesa ni la de un split existente.
Hoy Android borra la orden en paralelo (origen del 409 de producción) e iOS la deja abierta.

- Dominio puro espejo `CancelacionDeCobro` (Android) / `OrderCancelDecision` (iOS): NOT_CHARGED acreditado sólo con
  `outcome = NOT_CHARGED`, o con CANCELLED + ACCEPTED contra un servidor sin `outcome`. FAILED sin evidencia, CANCELLED
  por gracia, TIMED_OUT, UNKNOWN, 404 e inalcanzable ⇒ **pendiente**.
- Intención durable guardada **antes** de tocar la red (Android: SharedPreferences con `commit`, sin migración de Room;
  iOS: tabla GRDB aditiva `v16_pendingOrderCancel`). Si no se guarda, no sale ninguna petición y la pantalla lo dice.
- Coordinador singleton con scope propio, una corrida por intención, disparado al reconectar (2 s de estabilización) y
  con temporizador mientras haya pendientes. Pasos: pedir cancel (se reenvía con el MISMO `requestId` mientras el GET
  diga PENDING/SENT/CANCEL_REQUESTED, porque el cancel puede llegar antes que la fila) → esperar desenlace → borrar la
  orden (sólo si la creó el flujo) → cerrada. Salidas: «se cobró» (se aplica como cobro) y «revisión».
- Estados de pantalla: «Cancelando el cobro…» y «Cancelación pendiente» (ámbar, nunca rojo) con «Volver a consultar».
  En «Cobro sin confirmar» se separan «Salir (queda pendiente)», sin borrar nada, y «Cancelar la venta», que crea la
  intención. Mismos textos en español, palabra por palabra, en las dos apps.
- La intención no bloquea cerrar sesión ni cambiar de sucursal (sobrevive a ambos, como la llave del cobro) y se ve
  fuera del flujo: banner ámbar en Cobrar y sección en la hoja de pendientes.
- Se leen los códigos nuevos: `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` en mesas y anular cuenta (mensaje propio, sin
  intención), `ORDER_CANCELLED_NO_NEW_CHARGE` y `TERMINAL_NOT_CONNECTED` correlacionados por `details.requestId`.
- Carrera de «Procesando pago…»: si se cancela mientras se crea la orden, no se envía el cobro y sólo se registra la
  cancelación de esa orden.
- Sin red: la intención se guarda y se muestra «Sin conexión: la cancelación se enviará sola»; al volver la red va
  primero el cancel y después el borrado (el borrado es barrera: nunca antes del desenlace).

### C.5 TPV: cancelación segura tras reclamar (N3)

- CAS en una transacción Room: `PREPARANDO → DESCARTADA` de la libreta correlacionada, sin filas bloqueadoras
  (`KERNEL_ACTIVO` en adelante). Con `PROCESSING` sin fila de libreta, sólo con **prueba de propiedad** en este proceso
  (el `requestId` fue reclamado por este proceso y no arrancó efectivo ni cripto). Si no gana ⇒ ACTIVE.
- **Cerca durable** en `reserveTerminal`: ningún intento nuevo de una solicitud con lápida o con cancel aceptado.
  Migración Room v34: `cancel_accepted_at` y `execution_started_at` en `remote_payment_requests`.
- Efectivo y cripto de un cobro remoto: CAS `execution_started_at` antes de registrar; si el cancel ya ganó ⇒ «el POS
  canceló». Ocultarlos sigue siendo decisión de producto aparte.
- Aviso en pantalla: el evento local lleva la disposición; Blumon (las dos variantes, mismos hunks) detiene la lectura
  y muestra «El POS canceló este cobro. No se cobró.»; AngelPay pasa a Cancelado (con Toast si su app ocupa la pantalla).
  Filtrado por `requestId` del cobro en curso (el flujo de eventos tiene `replay = 1`).
- `terminalPaymentCancelDispositionVersion` sube a `'2'`.
- Verificación pendiente dentro del trabajo: si `StartEmvTrans` de Blumon puede aprobar sin host (TC offline). Si sí,
  barrera `KERNEL_ACTIVO` también antes del kernel de chip.

### C.6 Rutas que cancelan órdenes

Un helper compartido `assertOrderCancellableUnderLock(tx, {venueId, orderId})` (candado de `Order`, relectura, 400 si
PAID/PARTIAL, 409 `ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE` con `details.requestId`), usado por:

| Ruta | Cambio |
|---|---|
| `cancelOrder` móvil | ya lo hace; pasa a usar el helper |
| DELETE del dashboard | todo dentro de la transacción; cuenta pagos con `type` nulo |
| PUT del dashboard con status CANCELLED/DELETED | pasa por la misma cancelación protegida |
| Anular artículos (TPV) | candado al inicio, relectura con CAS de versión; bloquea **toda** anulación con un cobro vivo (una parcial deja un sobrepago); anular todo en PARTIAL se rechaza; se quita el `paymentStatus: 'PENDING'` a ciegas |
| Fusión | candado de las dos órdenes ordenado por id en una sentencia; bloquea el ORIGEN; el destino no (agregar a una cuenta no crea sobrepago) |
| Checkout de vales (`cancelAreaTicketCheckout`) | mismo helper, respetando sesión → tickets → Order |
| DELETE de POS-sync | es verdad externa: no se rechaza; 🚨 + `ActivityLog` si había cobro vivo |

Nunca se toma el candado advisory de terminal en estas rutas, y los efectos (`onOrderCancelled`, referidos, sockets)
van después del commit. Las rutas `/tpv` devuelven `code` y `details` de forma aditiva. El dashboard web muestra el
motivo real (`apiErrorDescription`) y un texto propio para el código nuevo en es/en/fr. En la cola offline, un
CANCEL_ORDER o MERGE_ORDERS bloqueado va a cuarentena con un aviso específico.

---

## D. Nexgo / AngelPay: la terminal no cobra tras arrancar sin red (T26)

Verificado por código (informe del agente, 11-sep): la auth sólo corre al crear Home; sin red falla una vez y nada la
reintenta; la espera pasiva de 8 s del comercio corre **antes** de la única línea que autentica; el error de red se
muestra como «faltan credenciales» y además hace fallback a la cuenta primaria; `app_terminal_serial` lleva el serial
de comercio por defecto.

1. `recoverIfStuck(trigger)`: sólo si el estado es un error recuperable o no autenticado, el SDK no tiene sesión y no hay
   cobro en curso; una corrida a la vez (candado sobre el núcleo privado, no sobre los métodos públicos, que se anidan);
   enfriamiento ≥ 30 s; nunca `switchAccount` ni logout de una sesión viva. Disparadores: red recuperada,
   `fetchConfig` exitoso, `hasServer` que sube a `true`, y un botón «Reintentar» en el banner.
2. Auth **antes** de la espera del comercio: `ensureAuthenticatedAs(cuenta del comercio elegido)` y, si hace falta,
   completar la selección o cambiar el comercio activo. Estado visible «Conectando con AngelPay…». Se conservan los
   candados de alineación de Amaena.
3. Tres errores distintos: `SIN_RED` (sin fallback a la primaria), `CUENTA_NO_EN_CONFIG`, `SIN_CREDENCIALES`. La causa
   de red se conserva en `TerminalConfigRepositoryImpl`. Textos en español cortos.
4. Reporte: excepción tipada a Crashlytics con una sola llave nueva; al recuperarse, aviso al servidor.
5. `app_terminal_serial` con el serial del aparato, escrito donde ya se calcula.
6. Cobro remoto: si la auth falla antes de abrir la libreta y el SDK, se emite `failed + PRE_AUTHORIZATION` (acreditado:
   ninguna ejecución capaz de autorizar empezó). Hoy no se emite nada y el POS termina en UNKNOWN.
7. **Sospecha de dinero a verificar** (evidencia de la sesión hermana): el aviso «Result not emitted» de 27d380e9
   salió 7 min después de su cancel y con el contexto de otro cobro ($286, orden `cmtx4jnp…`, intento `2dca91b9`). Hay
   que comprobar en la 2.9.2 y en el árbol si un `_socketRequestId` nuevo puede quedar pegado al contexto de pago de
   otra solicitud, y si «Reintentar» puede cobrar un contexto con el id de otra solicitud o marcar como remoto un cobro
   local. Y qué hace el servidor con ese `Payment` (el importe no coincide con la fila).
   Datos de producción (sesión hermana, sólo lectura, 11-sep): 77ca56fb es la orden `cmtx4jnp…` ($286) y 27d380e9 es
   OTRA orden, `cmtx4pqps…` ($313.50); las dos CANCELLED, `paymentStatus` PENDING y 0 pagos; ningún `Payment` del venue
   menciona esos `requestId`, y AngelPay no registra ninguna transacción de la N86 entre 00:02 y 18:12. El «Reintentar»
   de las 15:53:50 **no llegó a cobrar**. Los dos clientes pagaron en la PAX con órdenes nuevas ($260 y $285, sin la
   propina del 10 % que traían las solicitudes). Hoy no hubo daño; el defecto de código sigue por verificar.

Todo en `main/…/angelpay` y en los disparadores de Home. Nada en `PaymentViewModel` de sandbox ni production.

---

## E. Orden de trabajo

1. Servidor, en serie sobre `terminal-payment.service.ts`: contrato (C.1–C.3) → A (A.5–A.9) → B. En paralelo, porque
   son otros archivos: rutas que cancelan órdenes (C.6) y el dashboard web.
2. TPV, en serie: identidad (A.2–A.4) → N3 (C.5) → Nexgo (D).
3. Android e iOS en paralelo, con el contrato de C.1–C.3 como fijo (C.4).
4. Auditoría independiente por frente, rondas de arreglo, y re-auditoría.
5. Pruebas físicas: PAX y Nexgo con los APK del árbol, tablet Android e iPad, sin red y con tarjeta.

Método en todos: TDD, Postgres real, sabotaje sólo en copias aisladas (worktree + rsync), `avq-verify` para lo pesado,
leer el cuerpo de la salida y no el código de salida.

---

## F. Qué falta para desplegar (no es sólo esta elección)

1. **Conciliar las 375 filas históricas** con B en modo lote (exportes del portal de Blumon y de AngelPay por ventana)
   **antes** del servidor nuevo; si no, bloquean sus terminales y sus órdenes desde el primer minuto.
2. **APK nuevos primero**: PAX por firma de Blumon (3–5 días) y Nexgo por AngelPay. Son compatibles con el servidor
   actual (los campos nuevos se ignoran). Después el servidor. Después las apps POS, que funcionan con los dos
   servidores (sin `outcome` conservan su lógica).
3. **Pruebas físicas** con tarjeta y sin red en las dos marcas, y en la tablet Android y el iPad.
4. **Exención de Doze** en las PAX (causa medida del «terminal desconectada»).
5. **Limpieza de las 21 + 3 órdenes huérfanas**, con aprobación del founder, por el DELETE protegido tras conciliar.
6. Seguimiento de alertas: 🚨 de dinero tardío y rotaciones de identidad en Better Stack y Crashlytics.

---

## G. Decisiones tomadas por defecto (se pueden revertir)

| # | Decisión | Por qué |
|---|---|---|
| G1 | Semántica única de «Cancelar»: cobro primero; orden sólo si la creó el flujo y consta que no se cobró | Evita huérfanas sin borrar cuentas ajenas; paridad Android/iOS |
| G2 | Anular artículos bloqueado con cualquier cobro vivo en la orden | Una anulación parcial bajo un cobro produce sobrepago |
| G3 | Fusión: bloquea el origen, no el destino | Sumar a una cuenta no mueve dinero de más |
| G4 | B sólo OWNER/ADMIN (+SUPERADMIN) con permiso nuevo | Dinero; regla del repo sobre permisos de piso |
| G5 | Vigilancia tardía de 72 h | El README mide registros de hasta 3 h; margen amplio |
| G6 | Intención de cancelar no bloquea logout ni cambio de sucursal | Con TPV viejas puede quedar pendiente indefinidamente |
| G7 | ~~Sin lápida en el servidor antes de crear la fila~~ **REVOCADA** (H.5): todo rechazo que afirme «no se creó» deja una fila lápida por `requestId` | Una copia tardía del mismo POST podía crear el cobro que la tablet ya soltó |
| G8 | Replay del plan D se conserva para APK sin identidad | No degradar 2.9.x; riesgo residual declarado en A.9 |
| G9 | No se cambian las reglas de copia de seguridad de Android | La rotación ya vuelve segura una restauración |

---

## H. Correcciones v2 (11-sep, tarde): auditoría parcial de Codex + verificación

Codex (máximo esfuerzo, sólo lectura) se quedó sin créditos a los 10 minutos, sin veredicto. Alcanzó a señalar cinco
puntos. Otra sesión los verificó contra el código y yo los volví a verificar; los cinco se sostienen, y apareció un
sexto por extensión.

| # | Hallazgo | Evidencia | Severidad |
|---|---|---|---|
| H.1 | El downgrade de Room es destructivo; §0 de v1 decía lo contrario | `DatabaseModule.kt:162` | P2 (A sobrevive: rota; pero el downgrade borra libreta y colas, riesgo de dinero previo y ajeno a A) |
| H.2 | `FACTORY_RESET` confirma «completed» ANTES de borrar, y el borrado se traga su fallo | `CommandExecutor.kt:1055` (ACK) → `:1070` (`deleteDatabase` en try/catch) | P1 para B: `DEVICE_DECOMMISSIONED` liberaría con la bandeja viva |
| H.3 | En la Nexgo, un rechazo del banco emite `failed + PROCESSOR_DECLINED` FINAL y deja «Reintentar» con la MISMA solicitud | `AngelPayPaymentViewModel.kt` (~1942-1953 emite; ~471-476 el id sobrevive al emit; `retryAfterError` ~3307) | P1: con el servidor del árbol el POS suelta la llave y el reintento en la terminal puede aprobar sobre una solicitud «no cobrada» |
| H.4 | Faltan rutas que cancelan órdenes en C.6 | `cancelDeliveryOrder.service.ts:51`, Uber (~89, ~302), Rappi (~86); limpieza de promoción fallida `order.mobile.service.ts:1041-1047` | P2 |
| H.5 | C.3: un 404 «no se creó» sin escribir nada deja pasar una copia posterior del mismo POST | registro revisado ANTES del candado (`terminal-payment.service.ts:~497-507`) y rechazo sin fila | P1 |
| H.6 | **Extensión mía de H.5**: el 409 `TERMINAL_BUSY` correlacionado de T15 (ya programado en Android e iOS) tiene el mismo hueco: se lanza dentro de la transacción de admisión sin escribir nada, y el POS suelta la llave | `terminal-payment.service.ts:~536-548` (busy de terminal) y `~588-597` (busy de orden) | P1 (latente: exige una copia tardía del POST) |

Dato de producción para H.3 (sólo lectura, 11-sep): **6 filas `COMPLETED` con `failureCode = TPV_ERROR`** entre el
31-ago y el 10-sep, todas en las Nexgo de Amaena (`n860w173570`) y Testarudo (`n860w173400`): son rechazos seguidos de
un reintento aprobado en la terminal. **Las 6 órdenes tienen un solo pago**: el patrón ocurre de verdad y todavía no ha
causado un cobro doble.

### H.2 — B y el reset

`DEVICE_DECOMMISSIONED` exige, además del comando, que el servidor haya observado DESPUÉS una identidad de bandeja
distinta en esa terminal. Aparte, y fuera de A/B: el orden ACK → borrado de `executeFactoryReset` queda anotado como
defecto (la TPV afirma algo que todavía no hizo); moverlo exige otro canal de confirmación porque el ACK necesita el
token que el propio reset destruye.

### H.3 — Un rechazo del banco no es un desenlace final mientras se pueda reintentar

Regla nueva, tomada de Square Terminal (un checkout sólo termina COMPLETED o CANCELED; un rechazo no lo cierra —
[doc](https://developer.squareup.com/docs/terminal-api/square-terminal-payments),
[foro 2020](https://developer.squareup.com/forums/t/keep-checkout-in-progress-instead-of-cancel-after-a-swipe-failure-for-customer-to-retry/215)):

- **Una solicitud remota tiene a lo más UN desenlace final emitido. Desde que se emite, la terminal ya no la ejecuta.**
- Un rechazo del banco en un cobro remoto **no se emite como final** mientras la terminal ofrezca «Reintentar» esa
  misma solicitud. Se retiene, igual que hoy se retiene el aviso EMV recuperable (`programarCierreDeCobroAbandonado`).
- El final (`failed + PROCESSOR_DECLINED`) sale cuando el cajero cancela o sale del cobro, o cuando vence el reloj de
  abandono. En ese instante la solicitud queda **cercada** en la bandeja (misma cerca de C.5: `reserveTerminal` rechaza
  cualquier intento nuevo de esa solicitud).
- Si el reintento aprueba, se emite `success` y no hubo final negativo.
- Mientras tanto el POS sigue esperando (o pasa a «sin confirmar» con su llave) y el cancel desde la tablet sigue
  funcionando por N3.
- Blumon: verificar el mismo patrón en `PaymentViewModel` (sandbox y production, `Error canRetry = true` conserva
  `_socketRequestId`) y aplicar la misma regla.
- Servidor: sin cambio de regla. `failed + PROCESSOR_DECLINED` sigue siendo NOT_CHARGED, porque con esta regla la
  terminal sólo lo emite cuando ya no puede reautorizar. Los APK viejos (2.9.2) mandan `failed` sin evidencia ⇒ el
  servidor del árbol lo deja UNRESOLVED, que es lo conservador.

### H.4 — Rutas que faltaban

Cancelación de delivery (Uber, Rappi, `cancelDeliveryOrder`): es verdad externa, igual que POS-sync; no se rechaza, y
si había un cobro vivo se registra 🚨 + `ActivityLog` para conciliar. La limpieza de una orden cuya promoción falló
se documenta como exenta (no hay cobro posible sobre esa orden) con su prueba.

### H.5 y H.6 — Todo «no se creó» deja lápida

Todo rechazo de admisión que el POS pueda leer como «este cobro no se creó» (`TERMINAL_NOT_CONNECTED`,
`TERMINAL_BUSY` correlacionado, `ORDER_CANCELLED_NO_NEW_CHARGE`) se decide **bajo el candado** y **deja una fila
lápida** para ese `requestId`:

- `status = FAILED`, `failureCode` propio por motivo (`REJECTED_TERMINAL_NOT_CONNECTED`, `REJECTED_TERMINAL_BUSY`,
  `REJECTED_ORDER_CANCELLED`), procedencia `{deliveries: []}`, la respuesta original en `resultJson` (código, mensaje y
  `details`) para reproducirla idéntica;
- la unicidad de `requestId` hace de candado: si dos copias compiten, la segunda encuentra la lápida (o choca con P2002
  y relee) y **reproduce el mismo rechazo**; nunca crea;
- no ocupa la ranura de la terminal (FAILED no está en el índice parcial) ni bloquea la orden;
- el GET la proyecta como `outcome = NOT_CHARGED`, evidencia `REJECTED_AT_ADMISSION`, de modo que el POS puede resolver
  por GET cualquier duda.
- Consecuencia para el POS (ya es así en T15): tras un rechazo correlacionado, el siguiente intento lleva un
  `requestId` NUEVO. Reusar el mismo id reproduciría el rechazo.
- Restructura necesaria: la transacción de admisión hoy LANZA dentro (y el throw revierte todo); pasa a devolver el
  rechazo, escribir la lápida en la misma transacción y lanzar después del commit.

### Lo que la auditoría de Codex NO alcanzó a ver (sigue abierto)

Carreras sonda/replay/handshake; la garantía commit → fsync → efecto en cada efecto visible; la centinela contra cada
consulta de la bandeja; el modo lote de B para las 375 filas; la lista blanca contra todos los escritores de
`failureCode`; G1/G2/G3; D.7; las combinaciones de despliegue. Blumon con el patrón de H.3 tampoco se revisó.

---

## I. v3 — Veredicto del auditor independiente (Fable 5.1, en lugar de Codex por falta de créditos)

Informe completo con archivo:línea: `auditoria-fable-diseno-A-B-s8-2026-09-11.md` (misma carpeta). Cruza sus hallazgos con
`investigado-11-sep-diseno-A-B-s8.md`. **Esta sección manda sobre las anteriores cuando se contradicen.**

| Sección | Veredicto |
|---|---|
| A | APROBADO CON CAMBIOS — el mecanismo identidad + contador + espejo se queda |
| B | RECHAZADO hasta reescribir sus bases |
| C.1 | APROBADO CON CAMBIOS |
| C.3 | APROBADO CON CAMBIOS vía H.5/H.6 (lápida) |
| D | APROBADO CON CAMBIOS (coordinar con el WIP de T26) |
| F | RECHAZADO; se sustituye por I.6 |

### I.1 Cambios a A
- El contador del handshake debe ser el ACTUAL en cada reconexión (o la regresión se juzga sólo contra el último
  handshake de ese socket). Una identidad DISCONTINUED por regresión se reactiva cuando su contador vuelve a ser ≥ su
  propia marca (no por sucesión de otra identidad).
- Espejo: `fsync` del directorio después del `rename`; y `PRAGMA synchronous = FULL` en `avoqado_database` (hoy WAL sin
  `synchronous` explícito, `DatabaseModule.kt:166`).
- En modo estricto, no se admite un cobro sobre un socket NO confiable: rechazo con lápida pre-fila (H.5) en vez de
  entregar con `inboxTrusted = false`.
- Room puede borrar y recrear la base en caliente ante corrupción: la verificación de identidad no puede ser sólo al
  arrancar (se revalida la centinela antes de cada efecto visible).

### I.2 Reescritura de B (bases)
- `TERMINAL_FINAL_ANSWER`: sólo respuestas NEGATIVAS con evidencia (nunca un NOT_FOUND de otra identidad, nunca un
  RESOLVED de éxito ni un «cobré en efectivo»). Exige guardar en la fila `lastProbeDisposition`, `lastProbeAt`,
  `lastProbeInboxId` (hoy vive en memoria, `terminal-payment.service.ts:449`).
- `DEVICE_DECOMMISSIONED`: exige un handshake POSTERIOR con identidad de bandeja distinta. No existe `TerminalCommand`;
  `deviceReboundAfter` (`terminals.superadmin.service.ts:96-101`) no prueba el borrado; el ACK sale antes de
  `deleteDatabase` (`CommandExecutor.kt:1055/1070`).
- `LEGACY_NO_RESUME`: sólo para 2.8.x. Las Nexgo 2.9.x SÍ reanudan la bandeja tras reiniciar
  (`RemotePaymentCoordinator.kt:114-132`, sin comprobar edad); 65 de las 375 filas son suyas. Esas se resuelven con la
  sonda DESPUÉS de instalar el APK nuevo conservando Room.
- Filas `PROCESSING` sin intento de libreta (contestan ACTIVE para siempre) y filas en cuarentena tras rotar
  (`RECEIVED_PRE_ROTATION`): base explícita = inspección del aparato + portal sin operación + la solicitud cercada en la
  bandeja (`cancel_accepted_at` de C.5). Nunca automática.
- Modo lote: la revisión del procesador va POR TERMINAL, con una ventana que el servidor comprueba que cubra
  `[min createdAt, max createdAt + 72 h]` de las filas de esa terminal.
- La vigilancia de dinero tardío de 72 h necesita un escritor vivo: el barrido actual busca `TIMED_OUT/AUTO_RELEASED`,
  que nadie escribe en el árbol.

### I.3 Cambios a C.1
- Lista blanca por `(status, failureCode)` incluyendo lo que HEAD ya escribió en producción: `AUTO_RELEASED`,
  `MANUAL_RELEASE`, `MANUAL_RECONCILE` ⇒ UNRESOLVED.
- `cancelDisposition`: se CONSERVA `ACCEPTED` siempre que la evidencia sea `CANCEL_ACCEPTED`; `null` sólo sustituye a
  `ACTIVE` cuando el desenlace ya es final por otra vía. (Anular `ACCEPTED` dejaría sin salida la llave de Android 2.18.3
  y del iOS del árbol.)
- El predicado de bloqueo sigue incluyendo las filas EN VUELO (la «equivalencia» de v1 las sacaba: error).
- Regla H.3 incorporada. Blumon hoy ni siquiera emite el rechazo reintentable (`PaymentViewModel.kt:1457-1460`).

### I.4 C.3
H.5/H.6 cierra el P1-3 si la decisión va dentro del `pg_advisory_xact_lock`, la lápida se escribe en la misma
transacción y se lanza después del commit, y **todos** los rechazos pre-fila del servicio (404, 422, 403, 400) dejan
lápida. Las apps publicadas se destraban solas: leen `status` y sueltan la llave con FAILED.

### I.5 D (Nexgo) y D.7
- La recuperación de fondo NO produce cobro por otra afiliación (guardas existentes: `AngelPayAuthRepository.kt:127-144`,
  `:516-522`; alineación fail-closed en `AngelPayPaymentViewModel.kt:1660` y `:2628`, bajo un Mutex). Queda P2: evaluar
  la alineación contra la sesión que el SDK va a usar dentro del mismo candado, y abstenerse con
  `isChargeAttemptActive`, no sólo con `isCharging`.
- D.7 se sostiene. Camino 1: `AngelPayPaymentScreen.kt:192-195` re-etiqueta en cada recomposición; la pantalla vieja se
  lleva el id nuevo y su cierre por abandono emite un `cancelled + PRE_AUTHORIZATION` falso. Camino 2 (atrás del sistema
  deja los argumentos y el siguiente cobro LOCAL nace remoto) aplica igual a Blumon (`PaymentScreen.kt:233-236`).
  Arreglo, EN EL VM y no en la pantalla: `setSocketPaymentSource` rechaza cambiar a un tag distinto mientras haya un
  intento sin cerrar (y lo registra); la pantalla lee sus argumentos UNA vez de su propio `backStackEntry`;
  `clearPaymentArgs` corre al salir por cualquier vía, incluido atrás del sistema.

### I.6 Orden de despliegue que sustituye a F
1. **Servidor #1**: B, procedencia, lápida de admisión y la migración acotada por fecha, con el **predicado estricto
   detrás de un flag POR VENUE, apagado**: nada nuevo bloquea.
2. **Conciliar las 375 filas con B**, por terminal, contra ese servidor.
3. **APK por terminal**, sólo con esa terminal sin filas en vuelo ni UNKNOWN, y **conservando Room** (HEAD reproduce
   filas en vuelo con vigencia de 5 min a una bandeja que no las tiene).
4. Con el **100 %** de las terminales del venue en el APK nuevo, **encender el predicado** para ese venue.
5. **Apps POS al final**; iOS con `releaseType = MANUAL` (el POS del árbol contra el servidor viejo nunca cierra su
   cancelación durable).
Además: la libreta SHADOW que dejaron las 2.9.2 exige un paso de migración en el primer arranque del APK nuevo que
reclasifique esas filas, probado en aparato con Room conservado (no verificado por el auditor; plausible).

**Definición que tomo por defecto para el flag (reversible):** con el flag APAGADO, bloquean sólo las filas en vuelo y
las `UNKNOWN` (lo que hoy bloquea producción, sin la liberación por tiempo que el founder no autorizó); las históricas
`CANCELLED` sin disposición, `TIMED_OUT` y `FAILED/TPV_ERROR` no bloquean. Con el flag ENCENDIDO rige la lista blanca
estricta, y las filas anteriores a la fecha de encendido de ese venue se evalúan con el predicado viejo (la «migración
acotada por fecha»); su verdad se concilia con B.

### I.7 No verificado por el auditor
Producción (las 375), HEAD 2.9.2 de la TPV, el cuerpo de `AngelPayChargeVerifier`, la libreta SHADOW y carreras reales
sobre Room: todo fue lectura de código, no ejecución.
