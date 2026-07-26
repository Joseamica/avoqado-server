# Mesas en la TPV — módulo nuevo, offline-first

**Fecha:** 2026-07-24
**Estado:** diseño aprobado por el founder, pendiente plan de implementación
**Repos tocados:** `avoqado-tpv` (módulo nuevo), `avoqado-server` (rutas `/tpv` + reducer compartido)
**Origen:** petición del founder — "quiero un nuevo recuadro en avoqado-tpv que sea Mesas […] el mismo flujo pero en chico, canvas de mesas adaptado a la pantalla del tpv, modo canvas o modo lista […] escoge mesa > y todo lo demás"

---

## 1. Problema

La TPV hoy tiene un módulo de mesas: `features/ordering/` (`FloorPlanCanvasScreen.kt`,
2589 líneas + `FloorPlanViewModel.kt` + `MenuViewModel.kt`). El founder lo declaró
**legacy y mal hecho**, y la auditoría lo confirma en lo que más importa: es
local-first para agregar productos, pero **muere sin red en todo lo demás**. Hay
11 puntos que llaman `orderSyncCoordinator.syncOrderImmediately(orderId)` y
esperan al server antes de continuar:

- `features/ordering/presentation/menu/MenuViewModel.kt` — líneas 649, 1730, 2042,
  2307, 2375, 2741, 2874, 3016, 3141, 3231
- `features/payment/presentation/PaymentViewModel.kt:2778` (production) / `:2785` (sandbox)

Enviar a cocina, aplicar descuento, anular o cobrar exigen server vivo. El flujo
se cae justo donde el cajero ya tiene al cliente enfrente.

Mientras tanto, `avoqado-android` + `avoqado-ios` + `avoqado-server` ya shipearon
un POS offline-first bien hecho (outbox de intents con UUID + `seq` FIFO, reducer
idempotente en el server, cuarentena visible). **La TPV se quedó atrás.**

## 2. Objetivo

Un módulo **nuevo y aislado** `features/tables/` en la TPV que replique el flujo de
mesa de `avoqado-android`, adaptado a las dimensiones de PAX y NEXGO, **offline-first
para ordenar y manejo interno**, hablando **exclusivamente** con endpoints `/api/v1/tpv/*`.

**Fuera de alcance (explícito):**

- **Cobro con tarjeta offline.** Imposible: el procesador (Blumon / AngelPay) no lo
  soporta. Ver §3 D-7 y §9.
- **Local hub / sync por LAN entre TPVs** (el patrón de Toast). Ver §9 — ni Toast
  lo resuelve bien. Candidato a v2, no a v1.
- **Arreglar la falla bloqueante de `MenuViewModel`** (los 11 puntos de arriba). Ese
  archivo queda huérfano cuando entre el módulo nuevo; ver §3 D-4.
- **Cache Room del legacy** (`TableEntity`, `DraftOrderEntity`, `FloorElementEntity`).
  El módulo nuevo estrena sus propias tablas; no hereda las del legacy.
- **Editor de plano** (crear / mover / borrar mesas y elementos). En la TPV el canvas
  **no se puede editar**. Se asume que el plano del venue ya existe. El editor va al
  final y en el dashboard — ver §12.5.

## 3. Decisiones tomadas (no re-litigar)

| # | Decisión | Elegido |
|---|---|---|
| D-1 | Tier de pago | **PRO+ con teaser visible** — el recuadro "Mesas" aparece SIEMPRE; en venue FREE va con candado y lleva a upsell |
| D-2 | Aislamiento de endpoints | **Solo `/api/v1/tpv/*`**. Nunca `/mobile`. Lo que falte bajo `/tpv` se monta ahí |
| D-3 | Aislamiento del módulo | `features/tables/` no importa NADA de `features/ordering/` ni de `features/checkout/` |
| D-4 | Legacy | Módulo nuevo, **legacy intacto** como red de seguridad. Modo restaurante ON ⇒ el tile "Órdenes" se oculta solo |
| D-5 | Offline | **Offline-first**, portando el outbox de `avoqado-android`. NO se hereda ni se repara el offline previo del ordering |
| D-6 | Concurrencia | Optimista por `version`. `VERSION_CONFLICT` → RETRY automático; el resto → REJECTED → cuarentena visible |
| D-7 | Tarjeta | **Online por física.** Sin red el botón se muestra deshabilitado con la razón, y la cuenta queda abierta. Nunca pantalla de error |
| D-8 | Prerrequisito | Los 7 hallazgos de §4 se arreglan **antes** de que Mesas use la cola de pagos |
| D-9 | Split / Merge | Sin decisión pendiente: `SPLIT_ORDER` y `MERGE_ORDERS` ya existen en el reducer (trabajo en curso de otra sesión). La TPV los hereda |

**Nota sobre D-4:** el founder creía que el tile legacy ya estaba oculto. **No lo
está**: `showOrderManagement` tiene default `true` (`TpvSettings.kt:113`,
`TpvSettingsDto.kt:204`, `SecureStorage.kt:1258`), así que hoy se ve en toda terminal
salvo que alguien lo haya apagado a mano. Por eso D-4 lo oculta explícitamente al
prender modo restaurante — nunca conviven los dos caminos hacia la misma mesa.

**Nota sobre D-7:** ver §9. Square y Toast sí cobran con tarjeta offline, pero
porque **ellos son el procesador** y trasladan el riesgo de rechazo al comercio.
Avoqado va por un tercero: no puede diferir una autorización que no le pertenece.
Es una limitación estratégica, no de código.

## 4. Prerrequisito — deuda del stack de dinero

El módulo nuevo cobra con tarjeta contra una orden ya existente, así que **hereda
la cola de registro de pagos tal cual está**. Estos 7 hallazgos se cierran antes.

Aclaración de nombre, porque el anterior confundía: `pending_payments` **no es una
cola de cobro offline**. Es una **cola de registro post-autorización** — la tarjeta
YA se cobró en línea a través del procesador y lo que falló fue anotar la venta en
Avoqado. Por eso cada fila perdida es dinero que el cliente sí pagó y que el venue
no ve en sus libros, sin recibo firmado que lo respalde (§9).

### 4.1 Confirmados por el founder (auditoría previa)

> **F-2 no aparece a propósito.** Era la falla bloqueante de los 11
> `syncOrderImmediately` (§1), y vive en `MenuViewModel.kt` — archivo que queda
> huérfano cuando entre el módulo nuevo. Arreglar 10 call sites en código que va a
> morir es tirar trabajo. Decisión del founder: **se salta.** La numeración se
> conserva para que coincida con el reporte original.

| # | Archivo:línea | Qué está mal |
|---|---|---|
| F-1 | `AngelPayPaymentViewModel.kt:575` | Un cobro **exitoso** se renderiza como `AngelPayPaymentState.Error`. El texto ya dice "EN COLA / NO vuelvas a cobrar", pero el **tipo de estado** sigue siendo error → el cajero ve rojo y vuelve a cobrar por miedo. Arreglo: estado `Queued`/`SuccessPendingSync` renderizado como éxito con matiz. `Error` se reserva para cuando el encolado **también** falla (`:582`). Revisar el mismo patrón en el path de Blumon |
| F-3 | 7 banners + 2 fuentes de conectividad | `ConnectionBanner`, `DeviceAlertBanner`, `VenueStatusBanner`, `ShiftStatusBanner`, `AngelPayAuthBanner`, `PayLaterBanner`, `UnpaidTakeoutBanner`; fuentes `ConnectivityObserver` + `ConnectionViewModel`. **Verificar primero cuáles se apilan de verdad**, luego consolidar en un host único con prioridad explícita |
| F-4 | `PaymentSyncScheduler.kt:181` | `enqueue()` pelón, sin `enqueueUniqueWork`. Cada `runNow()` crea un worker independiente. Arreglo: `enqueueUniqueWork(PAYMENT_SYNC_NOW, ExistingWorkPolicy.KEEP, …)` — **KEEP, no REPLACE** |
| F-5 | `ActivationRepositoryImpl.kt:125,128,148,151` · `TerminalConfigRepositoryImpl.kt:168,173,174` · `HomeViewModel.kt:807,808` · `RecordPaymentUseCase.kt:310-328` | Retry vs fail decidido por `message.contains(…)`. Un cambio de wording en el server rompe la clasificación **en silencio**. Arreglo: clasificar por **tipo de excepción y código**, reusando `AppErrorCatalog` y espejando `RETRYABLE_ERROR_CODES` del server por nombre exacto |

`RecordPaymentUseCase.kt:310-328` resultó peor de lo reportado: ~18 `contains()`
encadenados, incluyendo `Regex("5\\d{2}")`, `"conexión"` y `"Verifica tu conexión"`.

### 4.2 Nuevos (segundo recorrido, 2026-07-24)

| # | Sev | Archivo:línea | Qué está mal |
|---|---|---|---|
| F-6 | **P1** | `PaymentSyncWorker.kt:247-257` | Si el mensaje de error **contiene** `"409"` (o `"duplicate"`/`"idempoten"`), llama `markSynced()`. Los reference numbers son numéricos — `000000409231` contiene "409"; igual montos e ids. Un falso positivo marca como SUCCESS una venta que **nunca llegó al backend**, deja de reintentar, y a los 7 días `deleteOldSyncedPayments` **borra la fila**. Irreversible y sin rastro |
| F-7 | **P1** | `PaymentQueueRepositoryImpl.kt:51-57` | `insert` es `OnConflictStrategy.IGNORE` sobre el índice único de `reference_number`; si choca devuelve rowId 0 y el repo responde **`Result.success(Unit)`**. Las filas `FAILED` **nunca se borran** (el cleanup solo toca `SUCCESS`), así que un reference number repetido choca con un cadáver y el pago nuevo jamás entra a la cola. El cajero ve "EN COLA" y no hay nada que completar |
| F-8 | **P1** | `PendingPaymentDao.kt:58-63` | `getAllPending()` devuelve todo lo PENDING y **no existe estado intermedio ni claim** (ningún `UPDATE … SET 'IN_PROGRESS' WHERE id=… AND sync_status='PENDING'`). Con F-4, N workers leen las mismas filas y las registran en paralelo. Lo único que evita el doble registro es que el **backend** deduplique. La seguridad del dinero está fuera de la app |
| F-9 | **P1** | `PaymentSyncWorker.kt:113,207-214` | 10 pagos × hasta 10 intentos × backoff de hasta 30s ≈ 40 min. **WorkManager mata al worker a los 10.** Se corta a media tanda pero el `retry_count` elevado ya quedó escrito y se acumula entre corridas → un pago bueno, que solo necesitaba que volviera el internet, termina en `FAILED` con intervención manual |
| F-10 | P2 | `PendingPaymentDao.kt:172-177`, llamado desde `HomeViewModel.kt:896` y `DeviceHealthViewModel.kt:388` | `resetAllFailed()` regresa **todos** los FAILED a PENDING con `retry_count = 0`, incluyendo los que fallaron por un 4xx permanente. Cada reconexión los reintenta 10 veces más, para siempre |
| F-11 | P2 | `PendingPaymentDao.kt:72-77` + KDoc del worker/DAO/entity | `markSynced` actualiza por `WHERE id = :id` sin verificar estado → una fila FAILED puede voltearse a SUCCESS. Y el KDoc dice "3 attempts max" en cinco lugares cuando `MAX_RETRY_ATTEMPTS = 10` |

**Orden de arreglo:** F-6, F-7, F-8 primero (dinero irrecuperable), luego F-1, F-4,
F-9, después F-5, F-3, y al final los P2 (F-10, F-11) que tocan los mismos archivos.

**Limitación de esta auditoría:** el segundo recorrido se hizo con lectura directa,
**sin modelo independiente**. Codex agotó créditos hasta el 2026-07-28 y Gemini CLI
está dado de baja para cuentas individuales (`IneligibleTierError`). Vale menos que
triangular; conviene repetirlo con Codex cuando vuelva.

### 4.3 Deuda de namespace detectada

La TPV está **limpia de `/mobile`** (125 endpoints `tpv/`, cero `mobile/`), pero
tiene **5 llamadas a `dashboard/`**:

- `core/data/network/ApiService.kt:505` — `GET dashboard/venues/{venueId}/products`
- `core/data/network/ApiService.kt:555` — `GET dashboard/venues/{venueId}/categories`
- `features/referrals/data/api/ReferralsApiService.kt:41,58,68` — referidos

Las dos primeras importan para este spec: **el menú de Mesas jala productos**. Si no
se cierran, el módulo nuevo nace con la fuga. Se migran a su equivalente `/tpv`
como parte de este trabajo.

### 4.4 Hueco de seguridad en las rutas de mesa de `/tpv` (hallado 2026-07-24)

Las 10 rutas de escritura de mesas y floor-elements bajo `/tpv` llevan **solo**
`authenticateTokenMiddleware` (`tpv.routes.ts:3531,3534,3537,3540,3586,3592,3598`).
No hay `checkPermission`, no hay `router.use` de permisos (el único es
`touchTerminalHeartbeatMiddleware` en `:108`), y el controller no verifica nada.

Cadena completa: `/api/v1/tpv` → `tpvVersionGate` → `touchTerminalHeartbeat` →
`authenticateTokenMiddleware` → controller.

Dos defectos independientes:

1. **Sin permiso.** Un `WAITER` puede crear, renombrar, reposicionar y borrar mesas.
   La UI legacy lo expone literalmente (el diálogo de edición trae botón de borrar).
2. **Cross-tenant (IDOR de escritura).** `authenticateTokenMiddleware` nunca lee
   `req.params.venueId`; el controller lo pasa directo
   (`table.tpv.controller.ts:11,36`); y el servicio scopea con
   `where: { id: tableId, venueId }` (`:667`, `:849`) — es decir, contra el venueId
   **que vino en la URL**, controlado por quien llama. Con un token válido del venue
   A, `DELETE /tpv/venues/<venueB>/tables/<id>` opera sobre el venue B.

**Precondición:** token válido de TPV + conocer el `venueId` destino (cuids, no
enumerables, pero se filtran en URLs y respuestas). **No es dinero** — es layout, y
el delete es soft. Sobrevivió al barrido de IDOR previo.

**Se tapa en el mismo sweep que §7.2** (cuando se agregue `checkFeatureAccess`):
`checkPermission('tables:create'|'tables:update'|'tables:delete')` + validar que el
`venueId` de la URL pertenezca al `authContext`. **Crítico:** el editor de plano del
dashboard (§12.5) va a espejar estas mismas rutas — si se copian antes de taparlas,
se duplica el hueco en un namespace con usuarios de oficina.

## 5. Arquitectura

```
features/tables/
├── domain/model/   DiningTable · TableOrder · OrderDetail · TableSession   (con `version`)
├── data/           TablesApiService (Retrofit, SOLO tpv/…) · TablesRepository
│                   SyncOutbox · SyncIntentEntity · TableSyncCoordinator
└── presentation/   TablesScreen · TableSheet · TableOrderScreen
                    TableMenuScreen · TableCheckoutScreen · QuarantineSheet + ViewModels
```

**Regla dura:** `features/tables/` no importa nada de `features/ordering/` (legacy)
ni de `features/checkout/` (el Cobrar existente). Comparte únicamente la ruta de
pago con hardware (§7.3).

### 5.1 El outbox — puerto de `avoqado-android`

Se porta la implementación ya probada en producción, no se reinventa:

| Pieza en `avoqado-android` | Qué resuelve |
|---|---|
| `core/data/sync/SyncOutbox.kt` (`enqueue` / `replayNow` / `rejectedIntents` / `dismissRejected` / `nextLocalFolio`) | La cola FIFO por dispositivo |
| `core/data/local/database/SyncIntentEntity.kt` | Asigna `seq` dentro de un `@Transaction` para que un `ADD_ITEMS` **nunca** se ordene antes de su `OPEN_TABLE` |
| `tables/data/TableSyncCoordinator.kt` | Al llegar el ack de `OPEN_TABLE`, promueve el UUID local → `orderId` real del server |
| `tables/data/TableSession.kt` | Mesa abierta con orden provisional local |
| `sync/presentation/QuarantineViewModel.kt` | Rechazos visibles con etiqueta en español ("Enviar ronda", "Cobro en efectivo", "Liberar mesa") |
| `tables/data/TableServiceRepository.kt` → `orQueueOffline` | **La separación**: red caída ⇒ outbox; el server dijo que no ⇒ error normal |

**La regla de oro del módulo:** *red caída ⇒ va al outbox. El server dijo que no ⇒
error al usuario.* Nunca se confunden. Es F-5 y la falla bloqueante del legacy en
su raíz común.

### 5.2 Cache local

Room propio de `features/tables/`: plano, cuenta y outbox. Tablas nuevas, no se
reusan las del legacy. Migración aditiva; nada destructivo.

### 5.3 Tiempo real

`SocketManager` de la TPV ya escucha `table_status_change` y `order_*`. El ViewModel
del plano se suscribe con debounce (~800ms) y recarga. El server ya emite desde los
servicios compartidos. **Cero trabajo nuevo de sockets.**

## 6. Pantallas y UX

**El flujo es idéntico al de `avoqado-android`.** Este módulo no inventa producto:
toma `tables/presentation/TablesScreen.kt` + `TableOrderScreen.kt` + sus ViewModels,
**acomoda el UI/UX a la pantalla chica**, y apunta a `/tpv`. Nada más.

### 6.1 En qué se diferencia del legacy (verificado en código, 2026-07-24)

La diferencia no es cosmética. `FloorPlanCanvasScreen.kt` **no es un plano: es un CMS
de planos corriendo en una terminal de pago.**

| | Legacy (`features/ordering/`) | Mesas nuevo (= android) |
|---|---|---|
| Qué es | Editor de plano que además deja operar | Plano **operativo**; el layout es solo lectura |
| Mover / crear / borrar mesas | **Sí**, desde la terminal, a media operación (`isEditMode` `:283-285`, `detectDragGestures` → `updateTablePosition`, `createTable`/`updateTable`/`deleteTable`, `createFloorElement`/`deleteFloorElement`) | **No** — espejo de android, que no tiene editor |
| Modos de vista | **Solo canvas** (cero `LazyColumn`/`LazyVerticalGrid` en 2589 líneas) | **Canvas ⇄ lista**, toggle en la misma pantalla |
| Pantalla chica | Canvas de 20 mesas en 480×480 | Lista es el modo primario en NEXGO |
| Estructura | Canvas monolítico con gestos manuales | Paso a paso, 3 `ScreenProfile` |
| Cobro | Pasa por el Cobrar compartido | Pantalla propia, aislada |
| Sin red | Se cae | Sigue operando; cuarentena visible |

El defecto de fondo del legacy: **pone un editor de contenido en manos de un mesero
con un cliente enfrente** — un long-press mal dado mueve una mesa, y el diálogo de
edición tiene botón de borrar. El módulo nuevo separa *acomodar el salón* (config,
ocasional, de un gerente) de *trabajar las mesas* (operativo, constante, de un mesero).

### 6.2 Pantallas

Adaptado a los 3 `ScreenProfile` existentes (`ResponsiveScaffold.kt`): CompactSquare
(NEXGO 480×480), CompactPortrait (PAX A80 <600dp), RegularPortrait (A920).
Flujo paso-a-paso, **no** el layout de dos paneles de la tablet.

1. **Tile "Mesas"** en `WelcomeScreen.kt` — visible solo con modo restaurante ON.
   Gating idéntico al de los tiles existentes (bloque :794-952), tier según D-1.
2. **Toggle "modo restaurante"** en `SettingsScreen.kt` + `SettingsViewModel.kt`
   (patrón de toggles :188-534). Nuevo flag `restaurantModeEnabled` en `TpvSettings`
   (default `false`, aditivo — terminales viejas ni lo ven). Al prenderlo, D-4 oculta
   el tile "Órdenes".
3. **`TablesScreen`** — plano en vivo con **toggle canvas / lista ahí mismo en la
   pantalla**. Canvas: coordenadas normalizadas 0–1 del server. Lista: agrupada por área.
4. **Sheet de mesa** — comensales → "Abrir mesa y ordenar".
5. **`TableOrderScreen`** — lo ya enviado a cocina (por rondas) y lo pendiente.
   "Enviar ronda" manda a cocina e imprime comandas.
6. **`TableCheckoutScreen`** — pantalla propia, aislada de Cobrar: restante, split
   (por monto / partes iguales / por items) y propina.
7. **`QuarantineSheet`** — los rechazos del outbox, visibles y accionables.

## 7. Contratos y cambios en el server

### 7.1 Ya existe bajo `/tpv` — se reusa tal cual

`GET/POST tpv/venues/{venueId}/tables` · `PUT …/tables/{tableId}(/position)` ·
`POST …/tables/assign` · `…/tables/{tableId}/clear` ·
`tpv/venues/{venueId}/floor-elements` (lectura para el canvas) ·
`POST tpv/…/orders/{orderId}` (registrar pago).

### 7.2 Rutas nuevas bajo `/tpv` — controllers delgados sobre servicios compartidos

**El hallazgo que evita reinventar todo:** el reducer offline de mesas **ya existe
y está bien hecho** — `POST /api/v1/mobile/venues/:venueId/sync/intents`
(`src/services/mobile/sync.mobile.service.ts`), con modelo `PosSyncIntent` en Prisma,
idempotencia por `[venueId, idempotencyKey]`, y 13 tipos de intent que son
exactamente el flujo de mesa:

```
OPEN_TABLE · ADD_ITEMS · PAY_CASH · APPLY_DISCOUNT · APPLY_SERVICE_CHARGE
COMP_ORDER · UPDATE_DETAILS · CANCEL_ORDER · MOVE_ORDER · ASSIGN_ORDER
CLEAR_TABLE · SPLIT_ORDER · MERGE_ORDERS
```

Semántica de reintento ya resuelta: `RETRYABLE_ERROR_CODES = {VERSION_CONFLICT}` →
RETRY (queda PENDING, se reintenta solo, no se pierde); todo lo demás → REJECTED
terminal → cuarentena visible. El gating de `TABLE_SERVICE` y la propiedad de mesa
se evalúan **por intent** en el reducer — sincronizar no es puerta trasera.

Y el controller **no está acoplado a mobile**: solo lee `venueId` de params,
`authContext.userId`, y `deviceId` / `intents` del body.

**→ Montar el MISMO controller bajo `POST /api/v1/tpv/venues/:venueId/sync/intents`
es una ruta nueva, cero lógica nueva, cero riesgo al contrato `/mobile`.**

Lo que además falta bajo `/tpv` (controllers delgados delegando en servicios
compartidos; donde hoy la lógica vive solo en `order.mobile.service.ts`, se
**extrae a servicio compartido** dejando el wrapper de `/mobile` con contrato
idéntico):

| Ruta `/tpv` | Delega en |
|---|---|
| `POST tables/:tableId/open` | servicio compartido de apertura de mesa |
| `POST orders/:orderId/items` (con `version`) | `order.tpv.service.addItemsToOrder` (ya existe) |
| `POST orders/:orderId/split` · `/merge` · `/move` · `/assign` | extraído de `order.mobile.service` |
| `POST orders/:orderId/comp` · `/items/:itemId/comp` · `/discounts` · `/service-charges` | extraído de `order.mobile.service` |
| `GET menus` (menús por horario) | servicio existente |
| `GET products` · `GET categories` | migración de §4.3 (hoy pegan a `dashboard/`) |

**Gating:** `checkFeatureAccess('TABLE_SERVICE')` en las rutas `/tpv` de servicio de
mesa. Hoy solo `/mobile` las gatea — es un hueco real que este trabajo cierra.
`TABLE_SERVICE` es un código de **`Feature`** (no `Module`): se resuelve con
`venueHasFeatureAccess`, **nunca** con `isModuleEnabled`. No está en
`PREMIUM_ONLY_CODES`, así que PRO ya lo incluye — consistente con D-1.

**Sin cambios de schema Prisma.** El dominio (`Table`, `Area`, `FloorElement`,
`PosSyncIntent`) ya existe completo. Cero migraciones, y por tanto **no aplica**
la regla de `npm run schema:map`.

### 7.3 Costura de pago

`TableSession` (singleton en memoria: mesa + orden + modo ORDERING/PAYING + restante)
es la costura. Al entrar a `getPaymentRoute()` (`AppNavigation.kt:2927-2936` — Blumon
en PAX, AngelPay en NEXGO), si hay sesión PAYING el pago se registra contra
`session.orderId`. **Nunca se crea una orden nueva.** Espejo de
`PaymentFlowViewModel.kt:459-471` en android.

## 8. Manejo de errores

| Caso | Qué ve el mesero | Mecánica |
|---|---|---|
| Sin red | Nada. Sigue trabajando | Va al outbox. **Nunca** es un error |
| Orden cambió en otra terminal | "La cuenta cambió — la actualicé" y recarga | `VERSION_CONFLICT` → RETRY, queda PENDING, se reintenta solo |
| Mesa de otro mesero | "Solo Juan puede modificar esta mesa" | `TABLE_OWNED_BY_OTHER` → REJECTED → cuarentena visible, no desaparece |
| Sin red + quiere cobrar tarjeta | Botón **deshabilitado con la razón** ("necesita conexión"). La cuenta queda abierta | D-7. No es error, es estado |
| Tarjeta cobró, backend no respondió | Pantalla **verde/ámbar**: "Cobrado — se sincroniza solo" | F-1 arreglado: estado `Queued`, no `Error` |
| La cola **también** falló al guardar | Rojo real: "avisa al supervisor" | Único caso que amerita intervención humana |
| Pago parcial | Vuelve al cobro con el restante | |
| Vuelve la red | Banner único baja, la cola se drena | `NetworkType.CONNECTED` ya dispara el worker — **esto está bien, no se toca** |

**Regla que gobierna todo:** red caída ⇒ outbox. Server dijo que no ⇒ error al
usuario. Se clasifica **por código** (`AppErrorCatalog` + `RETRYABLE_ERROR_CODES`
por nombre exacto), nunca por texto del mensaje.

## 9. Referencia: cómo lo resuelven Square y Toast

Investigado el 2026-07-24 porque define qué es razonable prometer.

**Square y Toast SÍ cobran con tarjeta offline — porque ellos son el procesador.**
Square es su propio payment facilitator; Toast tiene Toast Payments. Pueden decidir
guardar la tarjeta y autorizar después, y repartir el riesgo. Avoqado pasa por
Blumon / AngelPay como tercero: **no puede diferir una autorización que no es suya.**
Limitación estratégica, no técnica.

Y el precio de esa capacidad es alto:

- **Square** — subir los pagos offline dentro de **24h** (tope duro **72h**). El
  comercio **no recibe aviso de rechazos** y es **responsable** de todo pago vencido,
  rechazado o disputado; Square ni siquiera le da los datos del cliente. Mitigación
  recomendada: firma, comparar contra el plástico, identificación, y **tope por
  transacción**.
- **Toast** — entra en modo offline a los **40 segundos**. Efectivo y tarjeta siguen.
  Recomendación literal: *"conserva los recibos firmados por el cliente, por si el
  pago se pierde"*. Offline NO funcionan gift cards, lealtad, créditos, house
  accounts ni text-to-pay.

**Lo que de verdad sirve — el local hub de Toast y su límite:** Toast elige
automáticamente un terminal por Ethernet (nunca un handheld) como hub que relevea
por la red local. Pero documentan que *"las órdenes enviadas desde un POS no se
pueden ver en otro dispositivo salvo que sea un KDS"*, y por eso recomiendan que
**cada empleado use un solo dispositivo mientras está offline**. Si el hub se cae,
no se comparte nada.

O sea: **el líder del mercado no resuelve mesas compartidas entre dispositivos
offline; su respuesta es "no lo hagan".** Avoqado ya va adelante — el reducer
detecta el choque (`TABLE_OWNED_BY_OTHER` → cuarentena) en vez de corromper en
silencio. **Para v1 nos quedamos con el detector que ya existe; no se construye
local hub.**

Corolario para §4: como no hay offline de tarjeta, cada cobro que el procesador sí
autorizó es dinero que ya salió de la tarjeta del cliente. Si el registro se pierde
(F-7) o se marca sincronizado sin haberse enviado (F-6), esa venta desaparece de los
libros. Square y Toast cubren ese hueco con un recibo firmado en papel; **aquí no
hay papel que lo respalde.** Por eso F-6/F-7/F-8 son prerrequisito y no "después".

## 10. Testing

- **Regresión de dinero (las que no pueden volver):** un cobro exitoso jamás
  renderiza `Error`; `runNow()` con N pagos encolados produce **1** worker, no N;
  la clasificación retry/fail sobrevive a un cambio de wording del server; un error
  cuyo texto contiene "409" **no** marca la venta como sincronizada; un
  `reference_number` que choca con una fila `FAILED` vieja **no** se reporta como encolado.
- **Outbox:** `seq` FIFO bajo escritura concurrente; idempotencia por UUID (mismo
  intent dos veces = un solo efecto); REJECTED → cuarentena visible y no se pierde;
  el ack de `OPEN_TABLE` promueve el UUID local al `orderId` real.
- **Espejo de tipos:** test que falle si un tipo de intent del server no existe en la
  TPV. Los strings son *espejo exacto* del server (así lo dice el propio
  `SyncIntentEntity.kt` de android) y otra sesión está agregando tipos ahora mismo —
  el mismatch silencioso es el enemigo.
- **Legacy intacto:** `features/ordering/` sigue compilando y funcionando (D-4).
- **Pantallas:** los 3 `ScreenProfile` — NEXGO 480×480 y PAX.
- **Gate:** `npm test` + `npm run pre-deploy` en el server; build verde en la TPV.
- Fechas relativas (`Date.now() + N días`), nunca hardcodeadas.

## 11. Obligaciones de lockstep

- **MCP cliente (`src/mcp/tools/`):** `tables_status`, `open_orders`,
  `assign_table_check`, `split_table_check`, `move_table_check`, `comp_table_check`,
  `set_table_status`, `set_table_check_details` ya existen, y `src/mcp/tools/orders.ts:284`
  ya expone el replay de intents. **Verificar** que los tools nuevos de `/tpv` no
  agregan capacidad no reflejada; si el reducer gana tipos, el tool de intents se
  actualiza en el mismo cambio.
- **`ActivityLog`:** toda mutación auditable del reducer debe escribir su fila.
  Verificar que los intents replayados **no** se pierdan del rastro (el reducer es
  el único camino de escritura cuando se estuvo offline). Anomalías que sí se
  registran: comp, descuento, cancelar, liberar mesa. No: `ORDER_CREATED` de rutina.
- **Permisos:** nombres exactos espejados server ↔ TPV. `npm run audit:permissions`
  debe salir 0.
- **Presentación de ventas:** "Mesas en la terminal, funciona sin internet" es una
  capacidad visible al cliente → actualizar el deck, el one-pager y el one-pager de
  cliente, **y regenerar los 3 PDFs**.
- **Schema map:** no aplica (§7.2, sin cambios de Prisma).

## 12. Riesgos y preguntas abiertas

1. **El reducer es un blanco móvil.** Otra sesión está escribiendo
   `sync.mobile.service.ts` ahora mismo (cambios sin commit). El port a la TPV se
   construye contra lo que aterrice, no contra una foto. El test de espejo de tipos
   (§10) es la red.
2. **Extraer lógica de `order.mobile.service.ts` a servicio compartido toca código
   que `avoqado-ios` y `avoqado-android` consumen en vivo**, desarrollados en
   paralelo por otras sesiones. El contrato `/mobile` debe quedar byte-idéntico;
   re-verificar en fuente antes de tocar, nunca de memoria.
3. **Auditoría sin modelo independiente** (§4.2). Repetir con Codex después del
   2026-07-28.
4. **`showOrderManagement` sigue en `true` a nivel global** — a propósito. El founder
   descartó cambiar el default (rompería terminales que hoy usan "Órdenes" y que no
   van a tener Mesas). El ocultamiento es **local a la terminal** que prende modo
   restaurante (D-4). No es pregunta abierta; queda anotado porque el default global
   sorprende a quien lea el código sin este contexto.

5. **El editor de plano va al final, y no es de este spec.** Se diseña asumiendo que
   **el plano del venue ya existe**. En la TPV el canvas **no se puede editar** —
   punto; solo se toca una mesa para trabajarla.

   Cuando toque hacerlo, su hogar es el dashboard web (pantalla grande, mouse, un
   gerente sentado). Backend casi gratis: `/tpv` ya tiene el CRUD completo (10 rutas)
   sobre `tableController` y `floorElementController`, agnósticos del namespace — se
   espejan, mismo truco que §7.2. El trabajo real es el canvas en React.
   **Al hacerlo, tapar §4.4 primero**, o se duplica el hueco en un namespace de oficina.

**No quedan preguntas abiertas de diseño.** Las 9 decisiones de §3 están cerradas por
el founder el 2026-07-24.
