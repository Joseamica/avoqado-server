# Checkpoint de huellas — 2026-09-09 19:40 CDMX

**Por qué existe:** el founder dio prioridad a otra sesión de LLM que trabaja en `avoqado-tpv`.
Este archivo congela el estado EXACTO de mi trabajo para poder detectar, cuando esa sesión
termine, qué cambió y qué hay que revalidar. **No contiene ningún cambio de código.**

Instrucción vigente del founder: **no commit, no push, no deploy.** Sigue en pie.

---

## 1. 🔴 Hallazgo del momento: el sabotaje está PUESTO en el disco

La otra sesión está haciendo pruebas de sabotaje deliberado sobre
`app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/ContactlessKernelResult.kt`,
un archivo del árbol COMPARTIDO. A las 19:40 el archivo en disco está saboteado:

```diff
@@ CtlssDenied @@
-  userMessage = "El lector no aceptó esta tarjeta por contactless$codigo.\n\n$motivo$INSERTAR\n\n" +
+  userMessage = "El lector no aceptó esta tarjeta por contactless$codigo.\n\n$INSERTAR\n\n" +

@@ confirmarEnElTelefono @@
-  outcome = ContactlessOutcome.SEE_PHONE,
+  outcome = ContactlessOutcome.OTHER,
```

md5 en disco ahora: `0062dcd87eecd128d8b4127d6d1ef7c4`
md5 del original:   `604bf13a15328e69998f96624ec9a72d` (= `/tmp/avq-sabotaje/ORIGINAL.kt`)

### 🔴 Por qué ESE sabotaje concreto me afecta a mí

`SEE_PHONE` es uno de los seis miembros de `KERNEL_REFUSALS_WITHOUT_CHARGE`, la lista que yo
introduje para decidir cuándo se libera el lock de la terminal sin haber tocado dinero.
Cambiarlo a `OTHER` lo saca de esa lista ⇒ con el sabotaje puesto, un «confirma en tu teléfono»
**deja la terminal retenida**. Es decir: el sabotaje de la otra sesión cae DENTRO del
comportamiento que yo construí hoy.

⚠️ **Consecuencia medible:** a las 19:37 arrancó `run-avoqado-tpv.Lo0WBl`, que tomó el snapshot
con el sabotaje ya puesto. **Cualquier resultado de TPV de esta ventana es sospechoso.**

### ✅ Riesgo descartado con evidencia: su restauración NO borra mi trabajo

`/tmp/avq-sabotaje/ORIGINAL.kt` **contiene** `KERNEL_REFUSALS_WITHOUT_CHARGE` (grep = 1), o sea
que su respaldo se tomó DESPUÉS de mi edición. Cuando restauren, mi constante vuelve intacta.
(Éste era el peor escenario que había anotado; queda cerrado.)

---

## 2. Huellas de mi trabajo — TPV (`avoqado-tpv`, rama `main`, HEAD `aea0169`)

Marcadores presentes (conteo en `main/` + `sandbox/` + `production/`):

| Marcador | Usos | Qué prueba |
|---|---|---|
| `reserveTerminal` | 2 | reserva atómica `INSERT…SELECT…WHERE NOT EXISTS` |
| `findUnresolvedCharge` | 2 | la pregunta «¿pudo haberse movido dinero?» |
| `findTerminalHold` | 3 | la pregunta «¿la terminal está retenida?» |
| `markKernelEntered` | 6 | traza durable antes de entrar al kernel |
| `markKernelRefused` | 6 | liberación acotada sólo con rechazo explícito |
| `cobroSinResolver` | 3 | consulta del ledger desde AngelPay |
| `STATE_KERNEL_ACTIVO` | 8 | estado nuevo + su inclusión en `OPEN_STATES` |
| `KERNEL_REFUSALS_WITHOUT_CHARGE` | 5 | 1 definición + 4 usos |
| `quarantineStaleKernel` | 2 | KERNEL_ACTIVO → INDETERMINADO (nunca DESCARTADA) |
| `discardStalePreparing` | 2 | única liberación por tiempo |
| `"se adopta el intento pendiente"` | 1 | el fix de AngelPay SIN VERIFICAR |
| `refundKernelAttemptId` | 10 | reembolso contactless en ambas variantes |
| `showUnresolvedAuthorization` | 32 | incertidumbre en vez de `Success` falso |

SHA-256 (primeros 16) y mtime:

```
6cd27b1155717ae1  09-09 16:28  PaymentAttemptEntity.kt
d71a58df7748d277  09-09 17:34  PaymentAttemptDao.kt
4015441d929d9220  09-09 18:23  PaymentAttemptLedger.kt
edec161da6b1e550  09-09 19:36  ContactlessKernelResult.kt   ← SABOTEADO por la otra sesión
f7c673fca7708a5f  09-09 19:23  AngelPayPaymentViewModel.kt
1ac70f3268f1eb9b  09-09 18:22  PaymentViewModel.kt (sandbox)
2526eca2febf2924  09-09 18:22  PaymentViewModel.kt (production)
0e0fcf14df222913  09-09 16:34  PaymentAttemptRoomTest.kt
9d2b7a93296e3c08  09-09 17:37  PaymentViewModelKernelDurabilityTest.kt
a954a56d984048d9  09-09 19:17  AngelPayPaymentReviewRoomTest.kt
```

## 3. Huellas de mi trabajo — Server (`avoqado-server`, `develop`, HEAD `5e6b80d5`)

| Marcador | Usos | Hallazgo que cierra |
|---|---|---|
| `inciertoPorSocketPerdido` | 2 | #3 socket perdido ⇒ resultado incierto, no HTTP 400 |
| `retenerIncierto` | 2 | idem, retención antes de resolver |
| `"Recovery refused a Payment attributed to another terminal"` | 1 | #2 atribución física en la recuperación |
| `entry.socketId === socketId` | 1 | #1 identidad de socket desplazada |
| `void venueId` | 2 | #5 el picker no filtra por venue (la reserva es FÍSICA) |

```
355b2c0a32dadb1c  09-09 18:57  src/services/terminal-payment.service.ts
a38acc3200de0bb4  09-09 18:55  src/communication/sockets/terminal-registry.ts
35213118b83a2666  09-09 18:58  tests/unit/services/terminal-payment.service.test.ts
38acdc9399eb35e0  09-09 18:59  tests/unit/services/terminal-payment.autoRelease.test.ts
d92794e0b24b222b  09-09 18:55  tests/unit/communication/sockets/terminalRegistry.identidadDesplazada.test.ts
```

---

## 4. Cómo se comprueba después (una sola orden)

Al retomar, correr los mismos conteos y hashes de arriba. **Cualquier número que baje** significa
que se perdió trabajo mío; **cualquier hash que cambie** en un archivo cuyo marcador sigue intacto
significa que alguien lo editó y hay que leer el diff antes de seguir.

Comprobación mínima del archivo compartido:

    md5 -q app/src/main/java/com/jaac/avoqado_tpv/features/payment/presentation/ContactlessKernelResult.kt
    # 604bf13a15328e69998f96624ec9a72d  ⇒ limpio (restaurado)
    # cualquier otro                     ⇒ sabotaje puesto: NO correr avq-verify de TPV

---

## 5. Lo que queda en duda por la concurrencia (NO dar por bueno)

1. **El reembolso contactless** — «50 tests, 0 fallos» se midió en una ventana en la que el
   archivo compartido pudo estar saboteado. **Revalidar con el árbol quieto.**
2. **La sonda de AngelPay** — el fix «se adopta el intento pendiente» (línea única, `main/`)
   NUNCA se verificó: su corrida quedó huérfana al terminar la sesión anterior.

## 6. Pendientes que NO dependen del TPV (se pueden hacer sin chocar)

- Hallazgo #4 del servidor: el sobre `CONTRACT_MISMATCH` nunca se construye en el cierre por
  recuperación (`terminal-payment.service.ts:1241`, retorno temprano en `:896`).
- Verificar los cambios del servidor contra **PostgreSQL real** (base `codex_testarudo_test_20260909`).
- Picker: demostrar **por comportamiento** que una terminal reservada no se ofrece tras cambiar de
  venue (no basta comprobar que la consulta omite `venueId`).
- Task5 (outbox `PaymentEffect`): revisar la implementación PARCIAL ya existente. Punto de entrada
  medido: los 63 fallos vienen de `tx.paymentEffect` indefinido en
  `src/services/tpv/paymentEffects.service.ts:28` — falta el modelo nuevo en los mocks.
- Auditoría independiente de Codex y pruebas físicas PAX/Nexgo (siguen pendientes: **el doble cobro
  NO se puede declarar imposible**).

---

# ACTUALIZACIÓN — 2026-09-09, sesión reanudada

La otra sesión cedió la prioridad y **restauró el archivo compartido**: `ContactlessKernelResult.kt`
volvió a `604bf13a15328e69998f96624ec9a72d` (el md5 limpio) a las 19:40:54. Verificado por mí, no
aceptado de palabra. Los 12 marcadores y los 7 SHA de mi trabajo siguen idénticos.

## 1. 🟢 AngelPay — el montaje estaba roto, no producción. DEMOSTRADO

El test de recreación llevaba en rojo sin decir nada útil. Se instrumentó con **controles
negativos** y una **sonda de bisección**, y el resultado fue inequívoco:

```
inicio=true · trasRoom=true · trasCrearVM=true · trasInitPayment=true
· trasSocketSource=true · abrioLibreta=true
· trasAbrirLibreta=FALSE ← aquí muere
· trasOnIntentLaunched=false · trasCancelDelOriginal=false · trasRecrearVM=false
```

🔑 **Causa raíz medida:** `PaymentAttemptLedger` salta a `Dispatchers.IO` en **12 sitios**
(`openAttempt:48`, `markAuthorizing:116`…). El **reloj VIRTUAL** de `runTest` no sobrevive a ese
salto: tras la primera escritura en la libreta, el scheduler del test deja de ejecutar
**cualquier** corrutina — incluida una trivial (`controlTest=false` con `controlScopeVivo=true`).
Con el reloj muerto, el ViewModel recreado nunca ejecutaba NADA y su `Idle` final no era evidencia
de nada.

Hipótesis descartadas por el camino, cada una con medición y no con opinión: que `_socketRequestId`
no sobreviviera (sí sobrevive, vive en el `SavedStateHandle`), que faltara `Dispatchers.setMain`
(está puesto), que fuera el looper de Robolectric, que el culpable fuera
`original.viewModelScope.cancel()` (`controlPre=false` lo descarta) y que Room con
`setQueryExecutor(testDispatcher.asExecutor())` lo arreglara (no lo arregla).

**Corrección del montaje:** reloj REAL (`runBlocking`) y sincronización **por CONDICIÓN**
(`first { … }` bajo `withTimeout`), nunca por tiempo fijo — un `sleep` sí sería una carrera
disfrazada; esperar el evento con tope no lo es. **Resultado: 4 de 4 en verde.**

### 🔴 Y lo que el verde NO guarda — dicho antes de que nadie lo dé por bueno

Se rompió a propósito el bloque «se adopta el intento pendiente» y **el test siguió en verde**.
O sea: en el escenario del callback vacío, el guard anterior (`cobroSinResolver` antes de degradar
a `Cancelled`) ya bastaba, y mi bloque no está protegido por esa prueba.

Se añadió el test que sí lo distingue: **una DECLINACIÓN tras recrear el ViewModel**.
`markHostResponded` se llama sólo con `currentPaymentAttemptId`, sin fallback a la libreta ⇒ sin
la adopción, la fila queda `AUTORIZANDO` para siempre y **la terminal se queda retenida**.

## 2. 🟢 Servidor, hallazgo #4 — CERRADO con TDD y sabotaje

**El defecto era real y de dinero:** la recuperación cerraba la fila con
`{status, paymentId, lateResult}` y **sin comparar un solo importe**. Si la terminal cobró distinto
de lo que pidió el POS (pedido $100, cobrado $150), la orden quedaba «pagada» y los $50 no
aparecían en ningún lado — mientras la otra ruta (`closeRowFromPaymentTx`) sí lo cazaba.

🔑 La regla ya no vive dos veces: se extrajo a `contratoDescuadrado()` (pura) y **las dos rutas la
llaman**. Devuelve `null` cuando no hay importes comparables: afirmar un descuadre desde un dato
ausente sería inventarlo.

- 2 pruebas nuevas (la del descuadre y la de que el camino normal NO cambia).
- **90/90 en verde** en las dos suites de terminal-payment.
- **Sabotaje verificado:** desactivar la marca tumba EXACTAMENTE la prueba que la guarda.
- 5 fixtures completados con importes reales — un `Payment` sin `amount` es un estado imposible.

## 3. 🟢 Picker — ahora se prueba por COMPORTAMIENTO

La prueba anterior pasaba por el motivo equivocado: su mock devolvía la fila **pasara lo que
pasara con el `where`**, así que sólo la aserción de forma guardaba algo. Ahora el mock **simula la
base** (la reserva viva vive en `venue-viejo`) y sólo devuelve la fila si la consulta la alcanzaría.

**Verificado como pidió el founder:** con el filtro por venue reintroducido en producción **y la
aserción de forma desactivada**, la prueba falla igual (`busy.has()` → `false`). El comportamiento
guarda solo.

## 4. 🟡 Task5 (outbox de efectos) — revisado, NO empezado de cero

Lo que ya existía y está bien: modelo `PaymentEffect` con `@@unique(venueId, dedupeKey)`,
`claimToken`, `leaseUntil`, `attempts` y `nextAttemptAt` — el patrón outbox endurecido del kiosco,
correcto. 4 archivos de servicio/job/MCP y 5 suites de integración ya escritas.

**Estado medido:** 14 suites y **106 pruebas** en rojo (no 63; el número creció con el alcance).
Es una CASCADA de mocks, no un defecto único: al sembrar `paymentEffect` en el mock global el
error avanzó de `Cannot read … 'createMany'` → `pending is not iterable` → `originalCalcs is not
iterable`.

🔴 **HALLAZGO QUE MERECE DECISIÓN, no sólo arreglo de fixtures:** Task5 encola **dentro de la
transacción del dinero** y puede **lanzar**:

- `enqueuePaymentEffect` hace `throw new Error('PAYMENT_EFFECT_SOURCE_MISMATCH')` si no encuentra
  el pago fuente COMPLETED (`paymentEffects.service.ts:27`).
- `enqueueRefundPaymentEffectsInTx` usa `findUniqueOrThrow` sobre el pago del reembolso.

En un outbox transaccional escribir en la misma transacción es lo CORRECTO (es lo que impide
perder el efecto). Pero significa que **un fallo del outbox tumba el cobro o el reembolso**. Hoy
eso no está verificado contra PostgreSQL real, y es exactamente el tipo de riesgo que sólo se ve
ahí.

## Pendientes, con su porqué

1. **Revalidar el reembolso contactless** — su «50 tests, 0 fallos» se midió en la ventana sucia.
2. **Terminar los 14 fixtures de Task5** (mecánico, en cascada) y **verificar contra PostgreSQL
   real** que el outbox no puede tumbar un cobro ni un reembolso legítimos.
3. **Auditoría independiente de Codex.**
4. **Pruebas físicas PAX y Nexgo.** 🔴 Mientras falten, **el doble cobro NO se puede declarar
   imposible** y el circuito completo NO está validado.

---

# ACTUALIZACIÓN 2 — Task5 (outbox), sesión en solitario

El founder confirmó que la sesión del SDK de Blumon queda parada 2-4 días esperando respuesta del
proveedor, y me pidió terminar. Retomé Task5.

## Progreso medido

| | Antes | Ahora |
|---|---|---|
| Suites en rojo | 14 | **8** |
| Pruebas en rojo | 106 | **31** |

**En verde del todo:** `refund.cashDrawer`, `refund.idempotencia`, `refund.turnoDelNegocio`,
`refund.acumuladoBajoCandado`, `refund.acumuladoConPropina` (74 pruebas) y `payment.fastOrderTurno`.
Y lo mío del servidor sigue intacto: **90/90** en las dos suites de `terminal-payment`.

## Qué se arregló, y por qué NO se debilitó ninguna prueba

Todos los arreglos van en la misma dirección: **el fixture pasa a describir un estado REAL**, nunca
a esquivar una comprobación.

- **Mock global** (`tests/__helpers__/setup.ts`): `paymentEffect` y `commissionCalculation` como
  modelos, sus defaults (`findMany` → `[]`, que es «no hay efectos previos»), y `$executeRawUnsafe`
  para el SAVEPOINT de la comisión. Es la tercera vez que este patrón muerde: el propio archivo ya
  lo documentaba para `session` y `refreshGrant`.
- **Un `Payment` sin `venueId`, `orderId`, `amount` o `tipAmount` es un estado IMPOSIBLE.** Varios
  fixtures creaban pagos así, y el outbox —que relee su pago fuente para comprobar que pertenece a
  la misma orden— lanzaba y tumbaba la transacción entera.
- **El pago releído es EL MISMO que se creó** (se delega en el propio `create` o en el array del
  fixture) en vez de inventar otro que no cuadraría.
- **El mock refleja la consulta del outbox** en vez de responder a ciegas.

🔴 **Y una prueba que estuve a punto de romper y NO rompí:** en `payment.turnoDelNegocio` hay un
`tx` **deliberadamente incompleto** —comprueba que un `tx` sin `payment.count` reviente nombrando
la dependencia—. Al heredarlo del mock le quité el defecto que ese test vigila. Revertido y
marcado en el código para que nadie lo «arregle» otra vez.

## Lo que queda de Task5, agrupado por síntoma

| Suite | Fallos | Síntoma |
|---|---|---|
| `payment.inventory-post-commit` | 12 | el resultado llega `undefined` (`reading 'issues'`) |
| `payment.cash-duplicado` | 5 | `PAYMENT_EFFECT_SOURCE_MISMATCH` en 2 de sus 3 fixtures |
| `payment.inventory-rollback` | 4 | igual que post-commit |
| `payment.posting-atomicity` | 3 | `DecimalError` — el pago del fixture sin importes |
| `payment.turnoDelNegocio` | 3 | `SOURCE_MISMATCH` |
| `fastPaymentCustomer` | 2 | aserciones (ya no revienta) |
| `payment.tpv.service` | 1 | `SOURCE_MISMATCH` en un caso concreto |
| `fastPaymentDelegation` | 1 | aserción |

Ninguno es ya un defecto de producción conocido: son fixtures que describen estados imposibles.
Pero **hay que terminarlos antes de dar Task5 por bueno**, porque mientras estén en rojo nadie
puede distinguir un fallo nuevo de este ruido.

## 🔴 BLOQUEO REAL: la verificación contra PostgreSQL no se puede hacer

Existen 6 suites de integración para esto (`tests/integration/payments/`), Postgres está vivo…
y **no puedo ejecutarlas**: exigen `TEST_DATABASE_URL`, `psql` pide contraseña, y el `.env` está
—correctamente— fuera de mi alcance.

**Lo que hace falta del founder**, una de dos:

```bash
export TEST_DATABASE_URL='postgresql://…/<base_de_pruebas>'
npx jest --selectProjects integration --testPathPattern "payments/" --ci
```

o autorizarme a leer la credencial local. Sin eso, el riesgo declarado —que un fallo del outbox
tumbe un cobro o un reembolso legítimos— **no se puede comprobar donde único se ve**.

---

# 🔴 HALLAZGO PRINCIPAL DE TASK5 — el outbox abre una ruta nueva hacia el doble cobro

No es una teoría: lo destapó un test que fallaba y lo confirma el comentario que ya vive en el
propio código de producción (`payment.tpv.service.ts:3490-3500`).

## El mecanismo, en orden

1. Un cobro de la terminal pertenece a una orden que YA existe ⇒ `recordFastPayment` **delega**
   en `recordOrderPayment`, que es el camino correcto.
2. `recordOrderPayment` encola los efectos del cobro **dentro de la transacción del dinero**, y
   ese encolado **puede lanzar** (`PAYMENT_EFFECT_SOURCE_MISMATCH`, `findUniqueOrThrow`,
   `paymentEffect` inaccesible…).
3. Si lanza, la delegación entera falla y se cae al plan B: **crear una venta rápida sintética**.
4. El propio código explica por qué se hace así, y la cita es exactamente el riesgo:

   > «Se cae a FAST igual, porque perder el cobro es peor: el POS le diría al cajero que la venta
   > sigue sin pagar y volvería a pasar la tarjeta — **un doble cobro REAL**.»

🔑 **La consecuencia:** el plan B protege el DINERO (no se pierde) pero deja la orden original
**sin pagar** y el registro duplicado. Antes de Task5 ese camino sólo se disparaba con un contrato
incumplido por la TPV; **ahora también puede dispararlo un fallo del outbox**, que es código nuevo
en el punto más caro del sistema.

## Qué NO se puede afirmar todavía

Que esto ocurra en producción **no está demostrado** — en los tests lo provocan fixtures
incompletos. Lo que sí está demostrado es que **la ruta existe y desemboca donde no debe**.

Distinguir «sólo pasa con fixtures rotos» de «puede pasar con datos reales» exige ejecutar las
6 suites de integración contra PostgreSQL, que es justo lo que está bloqueado por credenciales.
**Hasta entonces, el circuito completo NO está validado y el doble cobro NO se puede declarar
imposible** — con una razón concreta más, no sólo por las pruebas físicas pendientes.

## Progreso de esta tanda

| | Inicio | Ahora |
|---|---|---|
| Suites en rojo | 14 | **7** |
| Pruebas en rojo | 106 | **30** |

`fastPaymentDelegation` cerrado (24/24) tras descubrir que **parte de los fallos NO eran fixtures
sino cambios de comportamiento deliberados**: con el cobro COMPLETED, la reseña ya no se crea
suelta después del commit —donde un fallo la perdía en silencio— sino que se **encola dentro de la
misma transacción del dinero**. Eso es mejor que antes; el test comprobaba la verdad vieja y se
actualizó a la nueva (ahora exige que la calificación y su vendedor lleguen a la cola).

🔑 También se afinó el reflejo del outbox en los mocks para que reconozca **sólo** su consulta
(id + venueId + status COMPLETED + select de únicamente `orderId`). Un reflejo laxo intercepta
búsquedas legítimas del servicio y le cambia el comportamiento — peor que el fallo que evita.

---

# ✅ VERIFICACIÓN CONTRA PostgreSQL REAL — hecha (base `codex_testarudo_test_20260909`)

El founder autorizó el acceso. Las suites exigen —por un cortafuegos correcto— una base cuyo
nombre empiece por `codex_testarudo_test_`, para no tocar nunca la de desarrollo.

## 1. 🟢 Mi trabajo del servidor: **36/36** (`terminalPaymentRecovery.integration.test.ts`)

Incluye el hallazgo #4 (descuadre de importes en la recuperación) y la atribución física.

🔑 **Y de paso la corrida DEMOSTRÓ que la atribución física funciona**: el único test que fallaba
lo hacía porque su fixture creaba un `Payment` **sin procedencia** —sin `source: 'TPV'` y sin
terminal— y la recuperación, correctamente, se negaba a cerrar la petición con él. Un pago sin
aparato identificado no puede liberar el slot de una terminal concreta. Se completó el fixture
(cada cobro nace en SU terminal) y quedó en verde. El defecto estaba en el estado imposible que
describía la prueba, no en el código.

## 2. 🔴 Task5: **37/38**, y el que falla es un defecto de DINERO

`paymentEffectsReview.integration.test.ts` →
*«an earlier category plan in the same payment contributes to the later goal-based rate»*

**Esperado 20 % · obtenido 10 %.** La comisión se paga a la mitad.

**Mecanismo, verificado leyendo el código:** Task5 **difiere** la escritura de la comisión —ya no
se guarda al cobrar, se encola y el job la materializa después—. Existe
`committedAndPendingCommissionProgress` (`commission-utils.ts:805`), que precisamente une lo ya
comprometido con lo pendiente en la cola… pero **filtra por `configId`**.

La meta que activa el bonus es **del VENDEDOR**, no de una configuración concreta: la comisión que
ese vendedor generó por la categoría A tiene que contar para alcanzar la meta que sube la tasa de
la categoría B. Con el filtro por `configId`, no cuenta ⇒ la meta no se alcanza ⇒ se paga 10 % en
vez de 20 %.

⚠️ **No está arreglado.** Es la parte de Task5 que quedó a medias: el test es de la propia tanda y
está en rojo, o sea que describe la intención y falta implementarla. Tocar el reparto de comisiones
merece su propio trabajo con TDD, no un parche al final de otro.

## Estado del bloque de pruebas unitarias de Task5

De **106 → 30** fallos y de **14 → 7** suites. Todo lo cerrado, con fixtures que describen estados
posibles; nada debilitado.

---

# 🚩 Bandera `forzar-dual` del 2026-09-09 21:48 — investigada y RETIRADA

**Qué la plantó:** shard 3/4 de la suite unitaria — local 1 fallo, Alienware 0.

**Qué falló:** `catalogWorkbook.eventloop-budget.test.ts` →
*«freezes the 50 ms budget…»*, `Expected: < 50 · Received: 55.586`.

**Por qué NO es divergencia de código**, siguiendo la receta del CLAUDE.md:

1. Es una prueba de **presupuesto de tiempo**, no una aserción funcional — la familia que el
   propio CLAUDE.md documenta como flaky bajo `--maxWorkers=2` (medido el 2026-09-02).
2. **El archivo no lo tocó nadie**: `git status` limpio, sin cambios respecto a la base.
3. **Repetido el archivo EXACTO con `--runInBand` en DUAL: 4/4 en LOS DOS lados, COINCIDEN.**

Causa: contención de CPU/GC del proceso de Jest con dos workers. Bandera retirada con esta
evidencia; no se tocó una línea de lógica de negocio para maquillar el reloj.

---

# 🟢 LA COMISIÓN A LA MITAD — ARREGLADA Y VERIFICADA

## La causa, encontrada siguiendo el dato y descartando tres hipótesis propias

Se descartaron, midiendo y no opinando: (1) que el acumulado filtrara por `configId` —no lo hace,
`commission-calculation.service.ts:125` llama sin él—; (2) que el plan encolado no llevara
`calculatedAt` —sí lo lleva, `options.sink ? payment.createdAt : new Date()`—; (3) que el orden de
evaluación dejara al primer plan invisible —`orderBy: { priority: 'desc' }` lo pone antes—.

Dos sondas contra PostgreSQL dieron la respuesta:

```
SONDA-PROGRESO  total: 110   (90 comprometida + 20 pendiente en la cola)   ✔ el acumulado FUNCIONA
SONDA-GOAL      currentPeriodSales: 110 · goal: 100 · bonusRate: 0.2       ✔ la meta SE ALCANZA
```

El bonus se calculaba bien **y se tiraba después**, en `calculateFinalRate`
(`commission-utils.ts:306`):

```ts
if (config.calcType === CommissionCalcType.TIERED && tierRate !== null) return tierRate
```

🔑 **La meta como nivel (`useGoalAsTier`) es un mecanismo INDEPENDIENTE del `calcType`** — se
resuelve en su propia rama de `createCalcForConfig` (`if (useGoalAsTier && goalBonusRate) … else if
(calcType === TIERED)`). Al exigir TIERED, **el vendedor que alcanzaba su meta cobraba la tasa
BASE**: 10 % donde le tocaba 20 %.

## El arreglo, y por qué NO cambia la política vigente

```ts
const usaMetaComoNivel = Boolean(config.useGoalAsTier && config.goalBonusRate)
if (tierRate !== null && (config.calcType === CommissionCalcType.TIERED || usaMetaComoNivel)) …
```

- Config **TIERED**: condición idéntica ⇒ sin cambio.
- Config sin meta: `tierRate` es `null` ⇒ ni entra.
- Prioridades intactas: override > nivel/meta > rol > default.

## Verificación (lo que pidió Codex, medido)

| Qué | Resultado |
|---|---|
| Integración contra PostgreSQL (`payments/paymentEffects`) | **38/38** |
| Suite del módulo de comisiones | **169/169** |
| Sabotaje (quitar el arreglo) | tumba **exactamente 1**: el RED original |

**Jobs desordenados, repetidos y reembolsos:** cubierto por esas 38, que incluyen —comprobado por
nombre— lease expirado con reclamo por token nuevo, worker rancio que no puede repetir ni
sobrescribir, tope de lote con orden estable, encolado duplicado que conserva el payload original,
rollback tras ejecutar, reembolso antes de la entrega que revierte una sola vez incluso en replay,
reembolso total que anula el referido sin premiarlo, y la reconciliación bajo el candado de la
orden. 🔑 Y el arreglo es en el CÁLCULO, que ocurre al encolar dentro de la transacción del cobro:
la tasa queda **congelada en el payload**, así que el orden o el retraso del job no pueden moverla.

# Pruebas pendientes de Task5 — progreso y atribución

| | Inicio | Ahora |
|---|---|---|
| Suites en rojo (tpv/shared/inventory) | 14 | **5** |
| Pruebas en rojo | 106 | **23** |

Cerradas del todo, además de las 5 de reembolso: `payment.cash-duplicado` (16/16),
`payment.tpv.service` (10/10), `payment.fastOrderTurno` (8/8), `fastPaymentDelegation` (24/24),
`liveDemo.simFastPayment` (20/20), `referrals/regression` (5/5), y las dos de comisiones.

## 🔴 Dos errores MÍOS, cazados y corregidos

1. **Un mock que llamaba a otro mock inflaba su contador.** Mi `findUniqueOrThrow` invocaba
   `payment.create` para leer el pago ⇒ el test creía que se habían creado **3 cobros en vez de 1**.
   Corregido en 9 sitios: ahora se LEE el último resultado (`mock.results`), no se vuelve a llamar.
2. **Estuve a punto de desactivar el guard del bug de Mindform.** Di al agregado un default de
   «nada comisionado», y ese es justo el hecho que el test siembra para comprobar que un segundo
   cobro NO vuelve a facturar la misma venta. Ahora el agregado **deriva del `findMany` con el
   MISMO `where`**: un solo hecho alimenta las dos lecturas y no pueden contradecirse.

## Fallos restantes (23) — atribución

| Suite | Fallos | Síntoma medido |
|---|---|---|
| `payment.inventory-post-commit` | 12 | `result.inventoryWarning` llega `undefined` |
| `payment.inventory-rollback` | 3 | idem |
| `payment.posting-atomicity` | 3 | `createSalePostingInTx` no se llama |
| `payment.turnoDelNegocio` | 3 | `PAYMENT_EFFECT_SOURCE_MISMATCH` residual |
| `fastPaymentCustomer` | 2 | la delegación cae al plan B (venta sintética) |

⚠️ **Atribución honesta:** todos comparten familia con los ya cerrados (fixtures que describen
estados imposibles frente al contrato nuevo de Task5), pero **eso NO está demostrado para los 23**
— sólo para los que se cerraron. Ninguno se ha probado que sea un defecto de producción, y ninguno
se puede descartar como tal sin terminarlos.

🔴 **La corrida COMPLETA sigue en rojo.** Repetir el test de tiempo resolvió esa discrepancia
concreta y justificó retirar la bandera, pero **no convierte la suite entera en verde**.

---

# CIERRE DE LA TANDA — números finales

| Ámbito | Resultado |
|---|---|
| Task5, pruebas unitarias (tpv/shared/inventory) | **14 suites / 106 fallos → 3 suites / 18 fallos** |
| Módulo de comisiones | **169/169** |
| Mi trabajo del servidor (`terminal-payment`) | **90/90** |
| Integración del outbox contra PostgreSQL | **38/38** |
| Integración de la recuperación contra PostgreSQL | **36/36** |

Cerradas del todo en esta tanda: `payment.cash-duplicado` (16/16), `payment.tpv.service` (10/10),
`payment.turnoDelNegocio` (8/8), `fastPaymentCustomer` (35/35), `payment.fastOrderTurno` (8/8),
`fastPaymentDelegation` (24/24), `liveDemo.simFastPayment` (20/20), `referrals/regression` (5/5),
`commission-goal-tier` (13/13), `commission-multi-scheme` (19/19) y las 5 de reembolso.

## Los 18 que quedan — atribución con evidencia

| Suite | Fallos | Evidencia medida |
|---|---|---|
| `payment.inventory-post-commit` | 12 | `result.inventoryWarning` llega `undefined`. **`recordOrderPayment` NO lanza** (comprobado con catch) y **`updateOrderTotalsForStandalonePayment` SÍ se llama** (34 veces, sonda contada) — o sea: se ejecuta y devuelve `null`. El siguiente paso es qué consulta ese helper para decidir el aviso (usa `prisma.order.findUnique` con un `include` de artículos e `inventoryMode`). |
| `payment.inventory-rollback` | 3 | mismo síntoma y mismo camino |
| `payment.posting-atomicity` | 3 | `createSalePostingInTx` no se llama |

⚠️ **Lo honesto:** comparten familia con los ya cerrados —fixtures que describen estados
imposibles frente al contrato nuevo de Task5— pero **eso no está demostrado para estos 18**.
Ninguno se ha probado que sea defecto de producción, y ninguno puede descartarse como tal.

## 🔴 La corrida COMPLETA sigue en rojo

Última medida (con código anterior a los tres últimos cierres): shard 1 **5 fallos**, shard 2
**28**. Falta una corrida final con el árbol actual. **Repetir el test de tiempo resolvió esa
discrepancia concreta y justificó retirar la bandera; no convierte la suite entera en verde.**

## Pendientes que siguen ABIERTOS

- **AngelPay**: montaje corregido y 13/13 verdes, pero el circuito completo NO está validado.
- **Auditoría independiente de Codex**: no hecha.
- **Pruebas físicas PAX y Nexgo**: no hechas. 🔴 Mientras falten, **el doble cobro NO se puede
  declarar imposible**.

---

# 🟢 LOS 18 CERRADOS — y la demostración que pedía Codex sobre `inventoryWarning`

## La pregunta era: ¿faltan datos en el fixture o cambió el comportamiento?

**Respuesta: FALTABAN DATOS, y el mecanismo quedó demostrado, no supuesto.**

Que el cobro terminara y la función se ejecutara efectivamente NO demostraba nada — se comprobó y
aun así el aviso venía vacío. La cadena real es ésta:

```
payment.tpv.service.ts:801   if (isFullyPaid && !settledBeforeThisPayment && !areaTicketAlreadyFinalized)
payment.tpv.service.ts:722   settledBeforeThisPayment = committedSettlement
                                ? !committedSettlement.firstSettlement
                                : <cálculo por pagos previos>
```

🔑 **Lo que pasó, en orden:** antes de esta tanda `settleStandalonePaymentInTx` **reventaba**, así
que `committedSettlement` no existía y el umbral se calculaba por la rama alternativa. Al arreglar
los mocks esa función pasó a ejecutarse, y entonces mandó `firstSettlement` — que salía **false**
porque mi `payment.aggregate` devolvía `_sum: null`, o sea **«esta orden no tiene cobros»**. Eso es
FALSO justo después de crear el cobro que la salda: el servicio la daba por saldada de antes y se
saltaba el bloque del aviso entero.

**El arreglo refleja el `where` real** — todos los COMPLETED de la orden que no son reembolso: los
PREVIOS que siembra cada escenario (en `order.payments`) **más** el recién creado. Contar sólo el
nuevo hace que una orden ya saldada parezca saldarse ahora; contar sólo los previos, lo contrario.
Ambos extremos se probaron y ambos rompen un test distinto — el arreglo es el punto exacto.

⚠️ **Y un matiz que costó el último fallo:** el filtro NO debe exigir `status: 'COMPLETED'` sobre
`order.payments`, porque esa lista **ya llega filtrada por la consulta** (`:574`). Exigirlo era ser
más estricto que el contrato y descartaba cobros legítimos — el abono que salda una cuenta con
cargo por servicio se leía como re-cobro y su vale de inventario no nacía.

## Resultado

| Ámbito | Resultado |
|---|---|
| `services/(tpv\|shared\|inventory)` | **95 suites · 1315/1315** (era 14 suites / 106 fallos) |
| `terminal-payment` + `commission` | **16 suites · 259/259** |
| Integración contra PostgreSQL (`payments/`) | **6 suites · 74/74** |

## Aserciones: ninguna debilitada

Medido sobre el diff completo de `tests/`: **1 aserción retirada y 8 añadidas**. La retirada es la
de `review.create` en `fastPaymentDelegation`, **sustituida** por la que comprueba que la reseña se
encola con los MISMOS datos (`kind: 'REVIEW'`, `rating: 5`, `servedById: 'staff-pos'`) — porque el
comportamiento cambió a propósito: con el cobro COMPLETED la reseña ya no se crea suelta tras el
commit (donde un fallo la perdía en silencio) sino dentro de la transacción del dinero.

**Contrato de los clientes publicados intacto:** la respuesta de `recordOrderPayment` conserva sus
campos (`id`, `status`, `feeAmount`, `netAmount`, `amount`, `tipAmount`, `venueId`, `orderId`,
`digitalReceipt`) más `inventoryWarning` cuando aplica. No se tocó.

---

# ✏️ PRECISIÓN (Codex, y tenía razón): qué viaja exactamente dentro de la transacción

Decir «la reseña viaja dentro de la transacción del dinero» era **impreciso**. Lo correcto,
verificado en el código y no de palabra:

| Qué | Dónde | Evidencia |
|---|---|---|
| La **FILA del outbox** (la anotación de que hay que crear la reseña) | **DENTRO** de la transacción del cobro | `enqueuePaymentEffect` sólo ejecuta `tx.paymentEffect.createMany` (`paymentEffects.service.ts:28`); es lo único que escribe |
| El **procesamiento** (crear la `Review` real) | **FUERA** | `runClaimedPaymentEffect` (`:81`) recibe un `PrismaClient` propio y lo invoca el job `payment-effects` |
| La **bitácora** | **FUERA** | `paymentEffects.service.ts` no llama a `logAction` ni toca `activityLog` en el camino del encolado — comprobado por búsqueda, sin resultados |

🔑 Y ésa es justamente la propiedad que hace útil el patrón: lo único que comparte destino con el
dinero es la ANOTACIÓN — barata y sin efectos externos. Si el procesamiento o la bitácora
compartieran esa transacción, un fallo suyo tumbaría el cobro, que es lo contrario de lo que el
outbox existe para evitar.

---

# 🔍 AUDITORÍA INDEPENDIENTE DE CODEX — hecha (gpt-6-astra, ~1.1M tokens)

Cuatro preguntas concretas. **Dos avales y dos hallazgos reales, ambos cerrados.**

## ✅ (1) Comisiones — el arreglo NO cambia la política vigente

> «`tierRate` empieza en `null` y sólo se asigna por meta o por `TIERED`
> (`commission-calculation.service.ts:121`). Sin ambas condiciones no puede llegar no nulo desde
> ese productor. La nueva condición conserva el comportamiento anterior.»

## ✅ (2) `contratoDescuadrado` — no reabre el doble cobro

> «El helper sólo compara y marca; no cambia qué pago autoriza el cierre. El barrido sigue
> exigiendo referencia exacta, venue, tarjeta completada, terminal física y ausencia de otro
> propietario. Sin pago verificable conserva `UNKNOWN`.»

## 🔴 (3) LOS MOCKS — dos huecos REALES, los dos cerrados

**(a) El agregado ignoraba sus argumentos.** *«Sumar previos más nuevo coincide para fixtures de
pagos completados de esa orden; no verifica el `where` real. Acepta previos PENDING/FAILED, no
filtra venue/orden y añade el nuevo incondicionalmente. Puede ocultar regresiones de filtros.»*

→ **Cerrado.** El mock honra ahora el `where` recibido: cada candidato pasa por las mismas
condiciones que `settleStandalonePaymentInTx` (venue, orden, COMPLETED, no-reembolso).

🔑 **Y lo medí antes de darlo por bueno: con el arreglo puesto, sabotear producción quitando el
`orderId` del `where` NO rompía ningún test** — ningún fixture tenía cobros ajenos, así que el
filtro no estaba ejercitado. Se añadió la prueba que lo ejercita (*«un cobro de OTRA orden no
salda ésta»*, con un cobro de $9 999 de otra cuenta). **Verificado: con el sabotaje puesto ahora
FALLA, y sólo ella.**

**(b) Un interceptor demasiado AMPLIO.** *«Sólo exige `id` y `COMPLETED`. Sí coincide con la
consulta legítima de `terminal-payment.service.ts:967` y devolvería `{orderId}` donde producción
devuelve importes y metadatos.»*

→ **Cerrado.** Los 4 sitios pasan al reflejo estricto `esConsultaDelOutbox`, que exige un `select`
de ÚNICAMENTE `orderId`. Las 4 suites siguen en verde.

**(c) ✅ El guard de Mindform sigue vivo.** *«El agregado recibe los mismos argumentos y el test
exige cero resultados y ninguna creación.»*

## ✅ (4) Contrato de los APK publicados — intacto

> «No encontré una ruta de producción que devuelva `201` con esos campos incompletos. Creación,
> deduplicación, carrera y delegación devuelven el Payment completo; los recibos devuelven filas
> completas con URL construida o `null`.»

Sobre el riesgo que yo había señalado: *«`PAYMENT_EFFECT_SOURCE_MISMATCH` sí produciría rollback y
HTTP 500, no un `201` parcial. Pero ambos productores pasan la identidad del Payment recién creado
y sólo encolan si está COMPLETED, dentro de esa misma transacción. No encontré una entrada válida
de APK viejo que provoque ese mismatch.»*

Y se añadió una **prueba de contrato** que verifica VALORES, no nombres: `data.id`, `data.amount` y
`data.tipAmount` presentes y no nulos (los tres NO nulables en `PaymentResponse.kt`), y los tres
campos del recibo cuando viaja. **Verificada rompiéndola:** simular que el servidor deja de mandar
el importe la tumba.

## Estado tras la auditoría

**111 suites · 1 576/1 576** en los ámbitos tocados (tpv/shared/inventory + terminal-payment +
commission).

---

# ACTUALIZACIÓN 4 — noche del 9→10 de septiembre

## ✅ La corrida COMPLETA, por fin cerrada

| Shard | Resultado |
|---|---|
| 1/4 | ✅ 347 suites · 3 978 tests · 0 fallos |
| 2/4 | 🔴 26 fallos — **todos** en `tests/unit/services/referrals/`, refactorización AJENA en curso |
| 3/4 | ✅ 346 suites · 3 624 tests — **verde en los dos lados y COINCIDEN** |
| 4/4 | ✅ 346 suites · 4 345 tests · 0 fallos |

🔴 **La corrida anterior (22:25-22:37) no valía como veredicto y hay que decirlo:** sus cuatro shards
corrieron contra CUATRO árboles distintos (huellas `119c31f7`, `9da0d5dc`, `405064ef`, `cc7bd9fc`)
porque **yo estaba arreglando esos mismos archivos mientras la corrida los leía**. Los 48 fallos que
reportó estaban en `payment.posting-atomicity`, `fastPaymentCustomer` e `inventory-*`, que quedaron
al 100% minutos después. Repetida sobre árbol quieto, el único rojo propio fue el guardián.

**`findManySinTopeGuard`** (2 tests): otra sesión extrajo `isOrderFullyReversed` a
`referralReversalPolicy.service.ts` (creado 15:53, sin commitear) y se llevó su `payment.findMany`
sin mover su renglón del inventario. Cerrado **trasladando el cupo**, no añadiendo `take` — un
`take` truncaría la lista de reembolsos y una orden ya reembolsada por completo se leería como
parcial. Verificado: 84 archivos y 143 ocurrencias antes y después; el inventario no creció.

**`exit=134` del shard 3 = `JavaScript heap out of memory`** (2 012 / 2 046 MB, el tope por defecto
de Node en WSL2). No es el código: la suite creció a ~16 551 tests y el shard 3 dejó de caber. Con
`NODE_OPTIONS=--max-old-space-size=6144` pasa en ambos lados. Plantó `forzar-dual`; **retirada con
evidencia escrita** en `~/.claude/avq-verify/forzar-dual.investigado-2026-09-09.txt`.

## 🔴 El aviso «otra sesión movió el árbol» es un FALSO POSITIVO en los repos Gradle

Medido, no supuesto. `avq-verify` usa DOS huellas: `huella()` compara CONTENIDO y `huella_viva()`
compara `stat '%N %z %m'` — nombre, tamaño y **fecha**. La vigencia se decide así:

```bash
{ [ -z "$H_CONTENIDO0" ] || [ "$H0" != "$H_CONTENIDO0" ] || [ "$H_VIVO0" != "$H_VIVO1" ]; } && VIGENTE=no
```

`H0` es el contenido del SNAPSHOT y `H_CONTENIDO0` el del ÁRBOL REAL. En avoqado-tpv el árbol real
tiene **152 165** archivos y el snapshot **23 191**: 129 752 de diferencia, casi todo `app/build/…`,
porque la lista de exclusiones sólo tapa `./build/*` de la RAÍZ, no `app/build/`. Nunca pueden
coincidir ⇒ el aviso sale siempre. Bitácora: avoqado-android 30 `si` contra 532 `no`.

Descartada la otra causa: `huella_viva` del árbol de la TPV, dos tomas con 60 s y nada compilando,
**idéntica** (`d45c04a15f7e3808`), cero archivos movidos. Y las dos corridas de la TPV imprimieron la
MISMA huella de contenido (`fb0a615f7c3d2f6b`) ⇒ **nadie editó código ahí**. No se arregló el script
porque otra sesión lo tiene abierto (`M scripts/avq-verify.sh` + un `avq-verify-vigencia.test.sh`
sin trackear); queda en un chip con el diagnóstico completo.

## ✅ Los dos hallazgos de Codex, verificados contra el código y cerrados

**#1 — Un rechazo contactless dejaba la PAX bloqueada.** CONFIRMADO con mecanismo: la rama
`RESULT_OFFLINE_DENIED` no resolvía la fila, que se quedaba en `KERNEL_ACTIVO` — estado que aparece
en las DOS consultas que bloquean (`findTerminalHold` = terminal apartada, `findUnresolvedCharge` =
dinero de desenlace desconocido). El siguiente `openAttempt` devolvía -1. Arreglado en sandbox y
production llamando a `markKernelRefused`, el patrón que ya existía 90 líneas más arriba.
🔴 El `else ->` se dejó INTACTO a propósito: un timeout o un resultado desconocido pueden esconder
una transacción que avanzó, y liberar sobre una duda es lo que produce un doble cobro.

**#2 — El descuadre de importe no se marcaba en TRES rutas**, no una: el barrido de `UNKNOWN`, el de
`RELEASED`/`TIMED_OUT` y la intervención manual cerraban como `COMPLETED` sin dejar rastro. La regla
vive ahora una sola vez en `marcaDeDescuadre()` y las CUATRO rutas la usan (incluida la que ya
marcaba, refactorizada para que no queden dos copias). El ayudante es **tolerante**: sin importes
utilizables no marca y no lanza — un `throw` abortaría el barrido de 200 filas por culpa de una.

⚠️ Los mocks de `terminal-payment.autoRelease.test.ts` devolvían un pago **sin `amount`/`tipAmount`**,
un estado imposible frente al `select` real. Corregidos, más dos pruebas nuevas: un cobro por otro
importe se cierra MARCADO, y uno por el importe pedido se cierra SIN marca.

## ✅ Typecheck: 0 errores

Los 10 que reportó el founder están cerrados (8 eran duplicados de `venueId`/`orderId` que mi propio
script de parcheo introdujo). 🔴 **Y quedó a la vista una trampa del repo:** `tsconfig.typecheck.json`
—la «verdad pre-commit» documentada— **excluye `tests/`**, así que los typechecks por avq-verify
salían verdes mientras `npm run typecheck` (tsconfig raíz) veía los errores.

## Pendientes

- ✅ **Los dos arreglos VERIFICADOS POR SABOTAJE**, cada uno con su evidencia:
  - #2 (`CONTRACT_MISMATCH`): quitada la marca de la ruta de UNKNOWN ⇒ `1 failed, 26 passed` —
    cae exactamente «un cobro por OTRO importe se cierra MARCADO», y sólo ella.
  - #1 (contactless): quitado el `markKernelRefused` de la rama del cobro en sandbox ⇒
    `3 tests, 1 failed` — cae sólo «un rechazo offline explicito resuelve la fila en las dos
    variantes»; las guardas del desenlace desconocido y del reembolso siguen verdes, que es lo
    correcto porque sus ramas no se tocaron.
  - Restauración comprobada por `diff` byte a byte en los dos casos.
  🔴 Lección del camino: el primer `trap` de restauración usaba ruta RELATIVA y falló en silencio
  imprimiendo «RESTAURADO» — el archivo quedó roto en el árbol compartido hasta restaurarlo a
  mano. Un `trap` de restauración va con ruta ABSOLUTA, siempre.

- 🔴 **Las pruebas del contactless NO conducen el ViewModel, y es deliberado.** Medido: en pruebas
  unitarias el alta de cuenta del gestor de comercios nunca termina (`merchantSwitchingLoading`
  se queda en `true`) y `startPayment` rebota con «Ya hay un cambio de cuenta en progreso».
  Esperar más empeora y llega a romper las vecinas. La conducta queda fijada en dos piezas
  deterministas: `RechazoContactlessLiberaLaTerminalTest` (lee el fuente de las DOS variantes —
  cubre producción, que ninguna prueba de comportamiento toca) y dos pruebas sobre Room real que
  comprueban que resolver la fila devuelve la terminal y que un desenlace incierto no.

- ⚠️ **Ajeno y expuesto, no causado:** `offline approval write failure keeps durable obligation…`
  falla también corriendo SOLA, y el diff no toca ni una de sus líneas. Sólo pasaba cuando otra
  prueba calentaba antes el gestor de comercios. Chipeada con el diagnóstico.
- ⬜ Instalar el APK Nexgo 2.9.2 (107) en la N86 y **prueba SIN RED** (regla del workspace).
- ⬜ Circuito físico Android → PAX/Nexgo. 🔴 Mientras falte, el doble cobro NO se declara imposible.
- ⬜ Los 26 fallos de `referrals/` son de otra sesión; no se tocaron.
