# Autorización de compras con umbral por sucursal + segregación aprobar/recibir — Plan v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que ninguna compra por encima de un monto configurable por sucursal pueda autorizarse sola, que quien autoriza no sea forzosamente quien recibe, y que el control sea REAL y no cosmético — sin cambiar el comportamiento de los ~70 locales que ya operan hasta que su dueño lo encienda.

**Architecture:** Se conecta un flujo de autorización que ya existe pero está desconectado, se cierran las cuatro puertas que lo rodean (el PUT genérico, la ruta de impuestos, el correo prematuro y el "deshacer recepción" que no revierte), y se parte `inventory:update` en `approve` + `receive` con alias de compatibilidad. La política vive en dos columnas de `VenueSettings`, apagadas por default. Dos despliegues separados por reposo, porque el corte del contrato del PUT no puede coincidir con el cambio de permisos.

**Tech Stack:** Express + TypeScript, Prisma/PostgreSQL, Jest, React 18 + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-08-06-autorizacion-y-segregacion-compras-design.md`

---

## Por qué existe un v2

El v1 falló una auditoría de Codex con **20 incidencias, 8 críticas**. La causa raíz no fue descuido en el detalle: fue **asumir la superficie en vez de medirla**.

| v1 asumió | La realidad |
| --- | --- |
| La recepción pasa por `POST /receive` | La pantalla usa `/items/:id/status` renglón por renglón. **La segregación habría sido cosmética.** |
| El PUT genérico lo usa el wizard | Lo usan **seis** llamadores para cinco transiciones distintas |
| ~6 archivos | **~34 archivos en 2 repos**, 1 migración de esquema, 1 migración de datos en producción |
| El servicio deprecado no estampa quién aprobó | **Sí lo estampa.** La justificación escrita en v1 era falsa |
| El workflow no tiene llamadores | **El chatbot lo llama** |

Este v2 se escribió **después** de mapear exhaustivamente cinco superficies. Cada `archivo:línea` de aquí salió de leer el código, no de recordarlo.

---

## Global Constraints

- **El dinero en PESOS, 1:1.** `Decimal`, nunca float ni centavos.
- **Toda mutación escribe `ActivityLog`** en el MISMO cambio. Si ya escribe a una tabla siloed, **dual-write**.
- **El MCP (`src/mcp/tools/`) va en lockstep** en el MISMO cambio.
- **Con el interruptor apagado, comportamiento byte-idéntico a hoy.** Restricción número uno del founder.
- **NO tocar** `deductSimpleStock`, `validateOrderInventoryAvailability`, el enum `InventoryMethod`, el reducer offline ni el corte de caja.
- **NO tocar el enum `PurchaseOrderStatus`** (10 valores en producción). Se mapea a etiquetas en español sólo en la UI.
- **`/mobile` sólo en T25**, y con periodo de gracia. iOS y Android se tocan en paralelo desde otras sesiones: **releer su contrato en fuente**, nunca de memoria.
- Mensajes de Zod **en español**. Toda consulta filtra por `venueId`.
- **No commitear sin permiso explícito del founder.**

---

## 🔴 Trampas verificadas a mano — ignorarlas hace fallar el trabajo en silencio

1. **El auditor de permisos sólo lee entradas de UNA línea.** `scripts/audit-permissions.ts:225` usa
   `/^\s*'(...)'\s*:\s*\[(.*?)\]/` sobre cada línea suelta. `inventory:read` está escrito multilínea
   (`permissions.ts:156-159`) y por eso **el auditor no lo ve**. Si las dependencias nuevas se escriben
   multilínea, `npm run audit:permissions` **sale 0 y la dependencia no existe**. Van en una sola línea.

2. **Zod strippea lo desconocido y `validation.ts:51` reemplaza `req.body`.** Quitar `status` del esquema
   a secas hace que un cliente viejo reciba **200 OK sin efecto alguno**. Por eso T17 lo deja declarado
   con un `superRefine` que devuelve 400 en español: falla ruidosamente, no en silencio.

3. **`ReceiveOrderDialog.tsx` es código muerto** — verificado: ningún archivo lo importa. Y los botones
   "Recibir todo/ninguno" del detalle **sólo mutan estado de React**, nunca pegan a `receive-all` /
   `receive-none`. Poner candados ahí sin cablearlos primero es proteger puertas que nadie usa: fue
   exactamente el error de v1.

4. **`createdBy`, NUNCA `createdById`.** En producción `createdById` está en 0 de 5 órdenes.

5. **El tipo de ajustes del venue vive en DOS lugares del dashboard** (`types.ts:619` y `:1741`) y la
   pantalla lee el segundo. Tocar sólo el primero compila y no sirve.

6. **La rama CREATE del upsert de `VenueSettings` enumera campo por campo** y no hace spread. Un venue
   sin fila **pierde su primer PUT** — ya le pasa a `enforceTableOwnership`.

---

## Decisiones — LAS 13 ESTÁN CERRADAS. No re-litigar.

**Cerradas por el founder (2026-08-06), cambian comportamiento de los ~70 locales:**

| # | Decisión | Resuelto |
| --- | --- | --- |
| **D-9** | ¿Cuándo sale el correo al proveedor? | **Al ENVIAR, para todos.** Hoy sale al crear, incluso desde un borrador — defecto reportado por un cliente real. Mantenerlo por compatibilidad sería preservar el error. **Hay que avisar a los ~70 locales.** |
| **D-1** | ¿"Deshacer recepción" revierte inventario? | **Sí, con guarda de consumo.** Revierte lotes y movimientos; si un lote ya tiene consumo parcial, rechaza con 409 nombrándolo. Cierra el doble conteo que hoy permite ese botón. |
| **D-3** | ¿"Rechazar" rechaza de verdad? | **Sí**, con ciclo `REJECTED → DRAFT` para corregir y reenviar. A partir del deploy las rechazadas dejan de contarse como canceladas en reportes; **el histórico no se migra.** |

**Cerradas con la recomendación del análisis:**

| # | Decisión | Resuelto |
| --- | --- | --- |
| D-2 | ¿Quién deshace una recepción? | `inventory:delete` — es reversión, no edición. Alinea con el chatbot, que ya la trata como peligrosa. |
| D-4 | ¿Sobrevive el atajo del wizard? | Sí, pero explícito: `POST /create-and-confirm`, que **se niega** si el venue exige autorización. Dos PUT encadenados eran el agujero. |
| D-5 | ¿Tabla de transiciones canónica? | La del workflow, **más** un set `LEGACY_MOBILE` que conserva `DRAFT→SENT` y `SENT→RECEIVED`. Unificar a secas rompe el POS. |
| D-6 | ¿Estados recibibles? | `CONFIRMED, SHIPPED, PARTIAL, APPROVED, SENT`. **Fuera `CANCELLED`** (hoy resucita órdenes canceladas). `recalculate-status` va con `inventory:receive`. |
| D-7 | ¿Roles por default? | MANAGER hereda **ambos**; ADMIN/OWNER conservan `inventory:*`. La segregación se obtiene creando un rol a la medida: **se ofrece, no se impone.** |
| D-8 | ¿La recompra automática respeta el umbral? | **Sí.** Un job nocturno que compra $80,000 sin que nadie lo vea es justo lo que esto previene. |
| D-10 | ¿Reenvío al proveedor? | Sí, botón explícito con `ActivityLog`. `supplierEmailSentAt` es defensa anti-doble-clic, no candado. Sin email del proveedor → **aviso visible** (hoy es silencio). |
| D-11 | ¿Permiso y lugar del ajuste? | `venues:update` (quien configura el control no debe ser quien lo sufre). Vive en `/settings/local/basic-info`. Umbral `null` con switch prendido = **toda orden requiere autorización**, dicho explícito en la UI. |
| D-12 | ¿Tier y `/mobile`? | **Sin gate nuevo** — el router de inventario ya es PREMIUM. `/mobile`: periodo de gracia aceptando el permiso viejo OR el nuevo. |
| D-13 | ¿Los botones muertos? | Cablearlos a las rutas reales y **borrar `ReceiveOrderDialog.tsx`**. |

---

## Fronteras de corte

Cada fase termina en un estado **desplegable y coherente**. Si en el camino hay que shipear antes, se corta en una frontera, nunca a media fase:

| Corte | Qué queda entregado |
| --- | --- |
| Fin de Fase 2 | Backend completo con rutas dedicadas y política; el dashboard sigue usando el PUT viejo. Nada visible aún. |
| Fin de Fase 4 | **El flujo de autorización funciona de punta a punta.** El PUT ya no acepta `status`. Sin segregación de permisos todavía. |
| Fin de Fase 5 | Segregación real, incluidos chatbot y MCP. |
| Fin de Fase 6 | El dueño puede configurar el umbral desde la pantalla. **Antes de esto, sólo se prende por script.** |

**El corte más honesto para una demo es el fin de Fase 4** más un script que prenda el interruptor: se enseña la autorización completa y se declara que la pantalla de configuración viene después.

---

Verificado en fuente antes de escribir (no heredado del mapa): `validation.ts:50-52` (`req.body = parsedResult.data.body`, Zod no-strict), `inventory.schema.ts:455` (`status` opcional libre), `purchaseOrder.service.ts:688-698` (guard sólo `RECEIVED`, `status: data.status` crudo), `purchaseOrder.service.ts:1560-1566` (el include del núcleo trae sólo `orderNumber`/`id` — sin `status`), `permissions.ts:1498` (línea única de `inventory`), `permissions.ts:156-159` (`inventory:read` multilínea — invisible al audit), `audit-permissions.ts:224-232` (parser de una sola línea), `purchaseOrderWorkflow.service.ts:10-35` (VALID_TRANSITIONS) y `:83-84` (`submitForApproval` exige DRAFT).

**Hallazgo nuevo que el mapa no traía (afecta el alcance):** hay **DOS** puertas laterales de monto, no una.
- `updatePurchaseOrderFees` (`purchaseOrder.service.ts:1236`, ruta `inventory.routes.ts:753`) permite cambiar `taxRate`/`commissionRate` —y por tanto el `total`— en estado **DRAFT o SENT**. SENT es post-aprobación.
- Peor: el **PUT genérico** reemplaza los renglones completos (`items` en el Zod, "editar borra y recrea") y **sólo bloquea si `RECEIVED`**. Una orden en `APPROVED` o `PENDING_APPROVAL` puede cambiar su `subtotal` y `total` con `inventory:update`. Cualquier umbral es decorativo si esto no se cierra.

---

## 1. TAREAS EN ORDEN DE DEPENDENCIA

Nomenclatura: `[S]` = avoqado-server, `[D]` = avoqado-web-dashboard. Rutas relativas a la raíz de cada repo.

### FASE 0 — Baseline grabado ✅ decisiones ya cerradas

**T00 · ~~Cerrar las decisiones~~ — HECHO el 2026-08-06.** Las 13 están resueltas en la tabla del
encabezado: D-1, D-3 y D-9 por el founder; el resto con la recomendación del análisis. No re-abrir.

**T00b · Grabar el baseline ANTES de tocar nada.**
Correr el ciclo completo de compras contra la base real —crear, enviar, confirmar, recibir parcial,
recibir todo, deshacer, cancelar— y **guardar el resultado como suite de regresión**. Es la única forma
de demostrar después que "con el interruptor apagado el comportamiento es byte-idéntico", que es la
restricción número uno del founder. Sin esta grabación, esa afirmación no se puede probar, sólo creer.
Depende de: nada. **Es la primera tarea que se ejecuta.**

---

### FASE 1 — Fundaciones backend, cero cambio de comportamiento

Las tres son aditivas y no tocan ningún archivo en común. Nada de esto se puede observar desde la UI todavía.

**T01 · Máquina de estados única.**
Archivos `[S]`: **nuevo** `src/services/dashboard/purchaseOrderStateMachine.ts`; `src/services/dashboard/purchaseOrderWorkflow.service.ts:10-35` (mueve `VALID_TRANSITIONS`, re-exporta para no romper importadores).
Produce: `VALID_TRANSITIONS`, `isValidTransition(from,to,origin)`, `RECEIVABLE_STATUSES` (constante exportada, la que hoy son tres listas distintas: `:924`, `:1867`, `mobile:403`), y `MOBILE_LEGACY_TRANSITIONS` si D-5 = "no romper POS". Test de tabla: cada salto que hoy hace producción (dashboard, mobile, chatbot, auto-reorder) tiene que estar en la tabla o estar explícitamente marcado como legacy.
Depende de: T00 (D-5, D-6).
🔴 Nadie consume el módulo todavía. Es a propósito: reemplazar consumidores es la Fase 2.

**T02 · Alta de `inventory:approve` e `inventory:receive` en el catálogo (SIN cablear ninguna ruta).**
Archivos `[S]`: `src/lib/permissions.ts` — (a) `DEFAULT_PERMISSIONS[MANAGER]` bloque inventory `:761-765` (y los roles que salgan de D-7); (b) `PERMISSION_DEPENDENCIES` `:162`, **entradas en UNA SOLA LÍNEA** (`'inventory:receive': ['inventory:read','inventory:receive','products:read'],`) — el parser del audit `:224-232` no ve multilínea, como ya le pasa a `inventory:read`; (c) `INDIVIDUAL_PERMISSIONS_BY_RESOURCE.inventory` `:1498` (línea única; esto también cambia lo que expande `inventory:*` y el payload que recibe el TPV en login, `tpv.routes.ts:2669`). Más `src/services/access/access.service.ts:118` → `PERMISSION_TO_FEATURE_MAP` = `AVOQADO_INVENTORY`.
Tests `[S]`: clonar `tests/unit/lib/interVenueTransfer.permissions.test.ts` (valida `isValidPermission`, `hasPermission` por rol y `expandWildcards`, con la aserción negativa de no-colisión).
Produce: `npm run audit:permissions` sale 0. Los permisos existen y son asignables pero **nadie los exige todavía** → cero riesgo en prod.
Depende de: T00 (D-7).

**T03 · Migración de esquema, una sola.**
Archivos `[S]`: `prisma/schema.prisma` — en `model VenueSettings` (:719-793) `requirePurchaseApproval Boolean @default(false)` y `purchaseApprovalThreshold Decimal? @db.Decimal(12,2)` (**PESOS 1:1**, patrón `ReservationSettings:10771`); en `model PurchaseOrder` `supplierEmailSentAt DateTime?` y `supplierEmailSentTo String?`. `prisma/migrations/<ts>_purchase_approval_policy/` (con `--create-only` + `SET lock_timeout`), y `docs/SCHEMA_MAP.md` regenerado con `npm run schema:map` **en el mismo commit** (`VenueSettings` y `PurchaseOrder` ya están en `MODEL_TO_DOMAIN`; no hay que tocar el generador).
Depende de: T00 (D-9 define si `supplierEmailSentAt` es candado duro o defensa anti-doble-clic; la columna se necesita igual).

---

### FASE 2 — Backend: rutas dedicadas y política (todo aditivo, el PUT sigue intacto)

**T04 · Completar los servicios de workflow huérfanos.**
Archivos `[S]`: `src/services/dashboard/purchaseOrderWorkflow.service.ts` — `confirmBySupplier` (:292) y `markAsShipped` (:332) **les falta `logAction`**; `sendToSupplier` (:245) ya audita, pero su `data` guarda `supplierEmail` sugiriendo un envío que no ocurre (corregir el payload); `rejectPurchaseOrder` (:196) queda igual; `submitForApproval` (:95) se reescribe en T06. Todos pasan a validar contra `isValidTransition` de T01.
Produce: 4 servicios cableables, todos auditando.
Depende de: T01.

**T05 · Servicio de política de autorización.**
Archivos `[S]`: **nuevo** `src/services/dashboard/purchaseApprovalPolicy.service.ts` → `evaluatePurchaseApproval(venueId, total: Decimal)` → `{ requiresApproval, threshold, source: 'venue'|'default' }`, leyendo `VenueSettings`. Sin umbral y con el switch prendido → `requiresApproval: true` siempre (D-11).
Produce: **el único** punto donde se decide si algo necesita autorización. Los 5 consumidores (T06, T08, T09) lo llaman; ninguno reimplementa la comparación.
Depende de: T03.

**T06 · Las 6 rutas dedicadas + controllers + Zod.**
Archivos `[S]`: `src/routes/dashboard/inventory.routes.ts` (después de :711), `src/controllers/dashboard/inventory/purchaseOrder.controller.ts`, `src/schemas/dashboard/inventory.schema.ts`.
- `POST /purchase-orders/:id/send` → `sendToSupplier`. Perm `inventory:update`.
- `POST /purchase-orders/:id/confirm` → `confirmBySupplier`. Perm `inventory:update`.
- `POST /purchase-orders/:id/ship` → `markAsShipped`, body `{ trackingNumber? }`. Perm `inventory:update`.
- `POST /purchase-orders/:id/submit-for-approval` → `submitForApproval` **reescrito**: acepta `DRAFT` **y `REJECTED`** (D-3; hoy `:83-84` tira 400 desde RECHAZADA), consulta `evaluatePurchaseApproval` y escribe `PENDING_APPROVAL` **o** `APPROVED` según la política — v1 prometía esto y el servicio siempre escribía `PENDING_APPROVAL`.
- `POST /purchase-orders/:id/reject` → `rejectPurchaseOrder`, body `{ reason }` obligatorio. Perm `inventory:update`.
- `POST /purchase-orders/:id/undo-receive` → **servicio nuevo** (T07). Perm por D-2.
🔴 **Reusar `TransitionPurchaseOrderStatusSchema` (`inventory.schema.ts:517`), que ya existe y v1 volvía a declarar.** Sólo se escriben esquemas nuevos para `ship` (trackingNumber) y `reject` (reason), con mensajes **en español**.
Cada ruta escribe `ActivityLog`. Ninguna importa símbolos privados de otro módulo (el otro error de código de v1).
Depende de: T04, T05, T01.

**T07 · `undoReceive` — la única transición realmente nueva, y la única que toca dinero.**
Archivos `[S]`: `src/services/dashboard/purchaseOrder.service.ts` — **nuevo** `revertItemReceiveInTx` hermano de `applyItemReceiveStatusInTx` (:1545), más `undoReceivePurchaseOrder` que lo orquesta en `$transaction`.
Comportamiento (si D-1 = reversión real, mi recomendación): por cada renglón recibido, movimiento inverso (`InventoryMovement` para reventa / `RawMaterialMovement` + anulación de `StockBatch` para insumo), `quantityReceived → 0`, `receiveStatus → NOT_PROCESSED`, y **guarda dura: si algún lote ya tiene consumo parcial, rechaza con 409** y nombra los lotes (revertir mercancía ya vendida es inventar existencias negativas). Escribe `ActivityLog` + los siloed (`InventoryMovement`) — dual-write.
Produce: cierra el doble conteo que hoy permite el botón "Deshacer recepción" (`POActions.tsx:130`), que además ya miente invalidando `['rawMaterials']` como si se hubiera revertido.
Depende de: T00 (D-1, D-2), T01.
🔴 Tarea más cara del plan y **no** paralelizable con T08/T09/T14: todas viven en `purchaseOrder.service.ts`.

**T08 · Gating + idempotencia del correo al proveedor.**
Archivos `[S]`: `src/services/dashboard/purchaseOrder.service.ts` — guard **dentro de `sendPurchaseOrderEmailAsync`** junto al chequeo de `supplier.email` (:300), decidiendo por el `status` del `po` que la función **ya releyó** (no por un flag del llamador; así el auto-reorder que nace APPROVED sigue funcionando sin tocarlo); eliminar el disparo incondicional de `createPurchaseOrder` (:648); `ActivityLog PURCHASE_ORDER_EMAIL_SENT` (hoy sólo existe el `_FAILED` de :377); sellar `supplierEmailSentAt`/`supplierEmailSentTo`. Cablear el envío en la transición a `SENT` — **en la ruta `/send` de T06 y también en el PUT mientras exista** (cubrir sólo `sendToSupplier` no cambia nada en producción: hoy no lo llama nadie).
Archivos `[S]` secundarios: `src/services/dashboard/autoReorder.service.ts:573` (verificar que el guard lo deja pasar), `scripts/seed-la-ribera-demo.ts:1261` (el correo real de un cliente vivo → dato de prueba).
Produce: se acaba el correo al proveedor desde un **borrador** — que es el bug de fondo, existía antes de la autorización y lo dispara hasta el botón "Guardar como borrador" (`PurchaseOrderWizard.tsx:579`).
Depende de: T03, T06. **Serializada con T07** (mismo archivo).

**T09 · Cerrar las DOS puertas laterales de monto.**
Archivos `[S]`: `src/services/dashboard/purchaseOrder.service.ts` — (a) `updatePurchaseOrderFees` (:1236): quitar `SENT` de `allowedStatuses`, o re-evaluar con `evaluatePurchaseApproval` y regresar la orden a `PENDING_APPROVAL` si el nuevo total cruza el umbral; (b) `updatePurchaseOrder` (:667-700): si la orden está en `APPROVED`/`SENT`/`PENDING_APPROVAL` y el body trae `items`, re-evaluar el total y degradar a `PENDING_APPROVAL` (o rechazar con 409). ActivityLog `PURCHASE_ORDER_APPROVAL_REVOKED` con `antes → después`.
Depende de: T05. **Serializada con T07/T08.**

**T10 · Aplicar la política en los caminos de creación.**
Archivos `[S]`: `src/services/dashboard/purchaseOrder.service.ts:598` (createPurchaseOrder nace DRAFT — se queda así, la política se aplica al submit), `src/services/dashboard/autoReorder.service.ts:408` (si `autoApprove` está prendido y el total cruza el umbral → nace `PENDING_APPROVAL`, no `APPROVED`; D-8), `src/services/dashboard/chatbot-actions/definitions/purchase-order.actions.ts:190` (hereda gratis por reusar `createPurchaseOrder`), y `src/services/mobile/purchase-order.mobile.service.ts:137/:303` → **sólo declarar la asimetría** (D-12), no tocar el contrato.
Depende de: T05, T09.

---

### FASE 3 — Dashboard migra al contrato nuevo

**T11 · Cliente HTTP: quitar `status` y agregar los 6 métodos.**
Archivos `[D]`: `src/services/purchaseOrder.service.ts` — borrar `status?: PurchaseOrderStatus` de `UpdatePurchaseOrderDto` (:182) y agregar `sendToSupplier/confirm/ship/submitForApproval/reject/undoReceive`.
Produce: **el compilador lista los 6 llamadores**. Ése es el objetivo de la tarea, no la limpieza.
Depende de: T06 mergeado en el server.

**T12 · Migrar los 6 llamadores.**
Archivos `[D]`: `src/pages/Inventory/PurchaseOrders/components/POActions.tsx` :76, :94, :112, :130, :204 y el botón "Rechazar" :169 (hoy pega a `/cancel` y manda a `CANCELLED`; con D-3 pasa a `/reject`); `src/pages/Inventory/PurchaseOrders/components/PurchaseOrderWizard.tsx:473` (el sexto llamador, el que no está en POActions: si D-4 = mantener el atajo, se sustituye por `POST /create-and-confirm`, no por dos llamadas encadenadas).
En `undo-receive`: dejar de invalidar `['rawMaterials']` a menos que el backend revierta de verdad (T07).
Depende de: T11.

**T13 · Código muerto y botones mentirosos.**
Archivos `[D]`: `src/pages/Inventory/PurchaseOrders/components/ReceiveOrderDialog.tsx` (huérfano — nadie lo importa; borrar), y `PurchaseOrderDetailPage.tsx:538/:546` ("Recibir todo/ninguno" sólo mutan estado local de React y luego guardan por `/items/:id/status`): cablearlos a `receive-all`/`receive-none` o quitarlos. Si no, la Fase 5 pone candados en rutas que ninguna pantalla usa — exactamente el error de v1.
Depende de: T11. Decisión D-10.

**T14 · Mocks y tests del dashboard.**
Archivos `[D]`: `src/test/mocks/handlers.ts:466` (el PUT). Sin esto los tests pasan en verde contra una ruta que ya no existe.
Depende de: T12.

---

### FASE 4 — Deploy 1 y cierre del PUT (secuencia obligatoria, no negociable)

**T15 · Deploy backend** (rutas nuevas + correo arreglado; PUT todavía acepta `status`).
**T16 · Deploy dashboard** (los 6 llamadores ya usan rutas dedicadas). Soak mínimo 48 h con el interruptor de autorización APAGADO en todos los venues.
**T17 · Retirar `status` del PUT.**
Archivos `[S]`: `src/schemas/dashboard/inventory.schema.ts:455` y `src/services/dashboard/purchaseOrder.service.ts:696` (`updateData.status`) y el `if` de RECEIVED→SHIPPED de `:688-693` (esa escotilla ahora vive en `/undo-receive`).
🔴 **No borrar la llave del Zod a secas.** Zod strippea lo desconocido y `validation.ts:51` reemplaza `req.body` → un cliente viejo recibiría **200 OK sin cambio alguno**. En su lugar: dejar `status` declarado con un `superRefine` que devuelva **400 en español** ("usa la ruta dedicada `/send`, `/confirm`, …"). Así un cliente atrasado falla ruidosamente, no en silencio.
Depende de: T16 desplegado y estable.

---

### FASE 5 — Segregación de permisos (deploy 2, el riesgoso)

**T18 · Guard de estado + `receivedBy` en el núcleo compartido.**
Archivos `[S]`: `src/services/dashboard/purchaseOrder.service.ts:1560-1566` — el `include` debe traer `status` del padre (hoy sólo `orderNumber`, `id`) y rechazar los estados fuera de `RECEIVABLE_STATUSES` (T01). Además estampar `receivedBy`/`receivedDate` en el camino por renglón: hoy `updatePurchaseOrderStatusBasedOnItems` (:2034) sólo escribe `status`, así que **el flujo dominante del dashboard deja "quién recibió" en NULL**. El `staffId` ya llega hasta ahí.
🔴 Este archivo lo comparte `/mobile`: cambiar la lista rompe la recepción del POS si `APPROVED`/`SENT` no entran (D-6). Coordinar con las sesiones de iOS/Android y **releer su contrato en fuente**, no de memoria.
Depende de: T01, T17 (mientras el PUT acepte `status` libre, el guard es decorativo — son UNA tarea funcional, en dos deploys).

**T19 · Cablear los permisos nuevos en las rutas del dashboard.**
Archivos `[S]`: `src/routes/dashboard/inventory.routes.ts` — :711 approve → `inventory:approve`; :722 `/receive`, **:768 `/items/:itemId/status`** (la única que la pantalla usa de verdad), :795 `/receive-all`, :809 `/receive-none` → `inventory:receive`; :782 `/recalculate-status` → `inventory:receive` (D-6b: es el segundo paso obligado del Guardar).
Depende de: T02 desplegado, T06 (mismo archivo → serializar), D-7.

**T20 · Chatbot.**
Archivos `[S]`: `definitions/purchase-order.actions.ts` :218 (approve), :262 (receive); `definitions/po-workflow.actions.ts` :112 (receiveAll), :162 (receiveNone, hoy `inventory:delete`), :13 (submitForApproval), :57 (reject); y **el paso que se olvida**: `action-engine.service.ts:903-916` y `:929-931` — `hasAnyMutationPermission` hardcodea `:create/:update/:adjust/:delete` en **DOS ramas**; sin agregar `:approve` y `:receive`, un usuario con sólo esos permisos recibe "no entendí" (`{ isAction: false }`), sin mención de permisos. Falla silenciosa.
Depende de: T02.

**T21 · MCP cliente (regla de lockstep).**
Archivos `[S]`: `src/mcp/tools/procurement.ts` (hoy 100 % lectura) — `approve_purchase_order` y `receive_purchase_order` con `guard.requirePermission` de los permisos nuevos + `venueFilter` + `auditMcpWrite` + **confirm-gate de dos pasos** con preview `actual → nuevo` (mueven dinero e inventario). Patrón: `src/mcp/tools/interVenueTransfers.ts:111/:211`. Registrar en `src/mcp/server.ts`. Además exponer la política de autorización en `src/mcp/tools/venues.ts:92` (`venue_profile`) — lectura.
Depende de: T02, T06, T03.

**T22 · Espejo en el dashboard.**
Archivos `[D]`: `src/lib/permissions/defaultPermissions.ts:172` (MANAGER) y `:336` (`PERMISSION_CATEGORIES.INVENTORY`); `src/lib/permissions/permissionDependencies.ts:131` (copia **idéntica** al backend); verificar que INVENTORY siga colgada de una super-categoría en `src/lib/permissions/permissionGroups.ts:66` (precedente: `INVENTORY_TRANSFERS` existe en el catálogo y **no** es toggleable porque nadie la colgó).
i18n `[D]`: `src/locales/en/settings.json:321` y `src/locales/es/settings.json:327` → acción `receive` (`approve` ya existe; `fr` no tiene `settings.json`).
🔴 Si el catálogo del dashboard va atrasado, `PermissionEditorModal.tsx:313-318` guarda un rol "con todo" como lista literal **incompleta** en vez de `['*:*']`: degradación silenciosa. Por eso va en el mismo ship.
Depende de: T02.

**T23 · `PermissionGate` en las pantallas de OC.**
Archivos `[D]`: `POActions.tsx` (Aprobar :450, y los botones de recepción), `PurchaseOrderDetailPage.tsx` (Guardar :351, :538, :546).
Hoy **no hay ni un solo `PermissionGate`** en `src/pages/Inventory/PurchaseOrders/**`: sin esto el usuario captura toda la recepción y se entera con un toast de 403.
Depende de: T22, T12.

**T24 · Migración de `VenueRolePermission` (datos en producción, ~70 sucursales).**
Archivos `[S]`: **nuevo** `scripts/backfill-inventory-approve-receive.ts`, idempotente y re-runnable: a todo override custom que hoy contenga `inventory:update` se le agregan `inventory:receive` (y `inventory:approve` según D-7). Los overrides guardan la lista **expandida** (`rolePermission.service.ts:90`), así que no heredan nada solo.
Depende de: T02 desplegado, D-9.

**T25 · `/mobile`: periodo de gracia declarado.**
Archivos `[S]`: `src/routes/mobile.routes.ts:2213` (PUT status — endpoint con sub-acciones que incluye `approve`, hoy con `inventory:create`; mismo patrón del bug WIPE=LOCK) y `:2225` (receive, `inventory:create`). Aceptar `inventory:create` **OR** el permiso nuevo durante N semanas, y middleware por tipo derivado del body para la sub-acción `approve`.
Depende de: T02, D-12. Coordinado con las sesiones de iOS/Android.

---

### FASE 6 — La pantalla de ajustes (lo que v1 se saltó entero)

**T26 · Backend del ajuste.**
Archivos `[S]`: `src/schemas/dashboard/venueSettings.schema.ts` (body de `UpdateVenueSettingsSchema`, :42-114) — `requirePurchaseApproval: z.boolean().optional()` y `purchaseApprovalThreshold: z.number().min(0,'…').nullable().optional()` **sin `.int()`**, mensajes en español; `src/services/dashboard/venueSettings.dashboard.service.ts` — defaults en `DEFAULT_VENUE_SETTINGS` (:25-74), **cablear al `createData` de la rama CREATE del upsert (:133)**, que enumera campo por campo y no hace spread de `updates` (hoy un venue sin fila pierde su primer PUT — le pasa a `enforceTableOwnership`), y convertir `new Prisma.Decimal()` al escribir / `Number()` al responder (patrón `reservationSettings.service.ts:217`).
Ruta y controller: **cero cambios** (`dashboard.routes.ts:10862`, perm `venues:update`).
Tests `[S]`: `tests/unit/schemas/venueSettings.schema.test.ts` (centavos, negativo, null) y `tests/unit/services/venueSettings.updateCreate.test.ts` (rama CREATE).
Depende de: T03. Decisión D-11 (permiso).

**T27 · Frontend del ajuste.**
Archivos `[D]`: `src/types.ts:619` **y** `:1741-1746` (los DOS lugares; la pantalla lee el segundo — tocar sólo el primero compila y no sirve); `src/pages/Venue/Edit/BasicInfo.tsx` en 4 pasos — schema del form (~:92), `defaultValues` (~:177), hidratación en `form.reset` (~:203, con `Number()` porque el Decimal viaja como **string**) y **mutación propia** con PUT a `/venues/:id/settings` (modelo :350). 🔴 El botón "Guardar" (`saveVenue` :212) **no manda ajustes**: colgar el umbral del submit = no se guarda nunca.
UI: tarjeta con switch (modelo :1090-1114) + input de monto visible sólo con el switch prendido, `disabled={!canEdit||isPending}`, español, toast.
Navegación: cero entradas nuevas si vive en BasicInfo; si D-11b = pantalla propia bajo Inventario, agregar `venueRoutes.tsx` + `app-sidebar.tsx` (precedente: "Re-orden automático").
Depende de: T26 desplegado.

---

### FASE 7 — Cierre

**T28 · Suite de regresión completa + `/full-testing`** (ver sección 4).
**T29 · Deck y one-pagers.** `~/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/`: `avoqado-presentacion-v2.html`, `avoqado-one-pager-v2.html`, `avoqado-one-pager-cliente.html` **+ regenerar los 3 PDFs** con el comando Chrome-headless del README. Es capacidad visible al cliente ("autorización de compras por monto"). Editar el HTML sin regenerar el PDF = cambio incompleto.
**T30 · Documentar los huecos que NO se tapan en este ciclo**, en `.claude/rules/` o `docs/`: los dos `adjust-stock` (`inventory.routes.ts:251` y `:1176`) permiten inflar existencias sin OC con `inventory:update` — la segregación protege el proceso formal de compras, no el inventario; `/mobile` sin gate PREMIUM mientras el router de dashboard sí lo tiene (`:103`); asimetría de correo dashboard vs POS.

---

## 2. QUÉ VA DE VERDAD EN PARALELO

La regla que v1 rompió: **dos tareas son paralelas sólo si no comparten archivo**. Los archivos calientes son cuatro.

| Archivo | Tareas que lo tocan | Regla |
|---|---|---|
| `[S] purchaseOrder.service.ts` | T07, T08, T09, T10, T17, T18 | **Estrictamente serial.** Es el archivo más disputado del plan. |
| `[S] inventory.routes.ts` | T06, T19 | Serial (T19 después de T06). |
| `[S] purchaseOrderWorkflow.service.ts` | T01, T04, T06 | Serial. |
| `[D] POActions.tsx` | T12, T23 | Serial (gates después de migrar). |

**Paralelizables de verdad:**

- **Ola 1 (3 sesiones):** `T01` (nuevo archivo + workflow) ∥ `T02` (`permissions.ts` + `access.service.ts`) ∥ `T03` (`schema.prisma` + migración). Cero solapamiento.
- **Ola 2 (2 sesiones):** `T05` (archivo nuevo) ∥ `T04` (workflow). `T26` (venueSettings, backend) puede entrar aquí como tercera — no comparte nada con compras.
- **Ola 3 (2 sesiones):** `T20` (chatbot: `definitions/*` + `action-engine`) ∥ `T21` (MCP: `procurement.ts` + `venues.ts` + `server.ts`). Ambas dependen sólo de T02.
- **Ola 4 (cross-repo, 2 sesiones):** `T22` (permisos espejo `[D]`) ∥ `T24` (script de migración `[S]`).
- **Ola 5:** `T27` (`[D]` BasicInfo/types) ∥ `T19` (`[S]` rutas). Repos distintos, features distintas.

**NO son paralelas aunque lo parezcan:**
- T07 / T08 / T09 — el mismo archivo y además la misma función en dos casos.
- T17 (quitar `status`) con cualquier cosa del dashboard — es un corte de contrato, va solo y después del deploy.
- T18 (guard de estado) con T17 — funcionalmente son una: mientras el PUT acepte `status` libre, el guard se rodea con un salto DRAFT→CONFIRMED.
- T19 con T23 — cambiar el gate del backend sin el `PermissionGate` deja usuarios capturando datos para recibir un 403.
- Nada de Fase 5 con nada de Fase 4: son dos deploys distintos con soak entre ellos.

---

## 3. Decisiones

Cerradas. Ver la tabla del encabezado de este documento.

---

## 4. ORDEN DE VERIFICACIÓN (y por qué ése)

**V0 — Baseline de regresión ANTES de tocar una línea** (con `requirePurchaseApproval = false`, que es el default y el estado de las ~70 sucursales el día 1). Se graba como suite, no como observación:
1. Los 6 saltos de estado del dashboard (5 botones + wizard) — respuesta y `status` resultante.
2. Recepción por renglón: `PUT /items/:id/status` × N + `recalculate-status` → `StockBatch`, `InventoryMovement`, `currentStock`, `quantityReceived`, `status` del padre.
3. `receive-all`, `receive-none`, `/receive` legacy y el `/mobile/receive`.
4. Correo: qué se dispara al crear, al guardar borrador y al pasar a SENT (con `RESEND_API_KEY` ausente, capturando la llamada).
5. Auto-reorder con `autoApprove`.
**Por qué primero:** con el interruptor apagado, **el único cambio de comportamiento aceptable en todo el plan es el correo (D-9)**. Cualquier otra diferencia contra este baseline es una regresión, y sin la foto previa no hay forma de probarlo. v1 no tenía baseline y por eso su fallo silencioso (200 OK, cero cambio) era invisible.

**V1 — `npm run audit:permissions` justo al terminar T02**, antes de cablear una sola ruta. Debe salir **0**. En este punto es imposible que haya `DASHBOARD_DEAD_GATE` (no hay gates de UI todavía) ni `PHANTOM` (ya hay defaults). Correrlo aquí aísla el error: si truena, es el catálogo, no el cableado. Si se corre después, el ruido de 10 archivos hace irreconocible cuál rompió qué. Verificación extra que el audit **no** hace: confirmar a mano que las entradas nuevas de `PERMISSION_DEPENDENCIES` quedaron **en una línea** (`grep -n "inventory:receive" src/lib/permissions.ts` debe dar 3 aciertos, uno por lugar).

**V2 — Tests unitarios de la máquina de estados y de la política (T01, T05)**, antes de que exista cualquier ruta. Son funciones puras: si la tabla canónica está mal, se descubre aquí y no en un salón.

**V3 — Suite de regresión completa (V0) contra el backend con las rutas nuevas, ANTES de desplegar.** Las rutas nuevas son aditivas: V0 debe pasar **idéntico** salvo el correo. Si algo del PUT cambió, T04/T06 se colaron donde no debían.

**V4 — Deploy backend → soak 48 h con el interruptor apagado → deploy dashboard → soak 48 h.** Recién entonces T17 (quitar `status`). **Por qué ese orden y no al revés:** si se retira `status` antes de que el dashboard desplegado use las rutas dedicadas, los 6 botones responden **200 OK sin hacer nada** — el fallo silencioso confirmado en `validation.ts:51`. El `superRefine` con 400 explícito de T17 es la red por si un cliente quedó atrás.

**V5 — `npm run audit:permissions` otra vez al terminar T19+T22+T23**, ahora **con `--strict`**. Aquí ya no debe haber `DASHBOARD_DEAD_GATE`: si aparece, es que el catálogo del dashboard no se actualizó y `PermissionEditorModal` está a punto de degradar roles en silencio. Recordar que el audit **sólo escanea `src/routes/**`**: MCP y chatbot son invisibles para él y hay que verificarlos a mano (grep de `requirePermission` en `src/mcp/tools/procurement.ts` y del campo `permission:` en las dos definiciones).

**V6 — Prueba de segregación real, con usuarios de verdad** (no unit tests): un rol con `receive` sin `approve` (recibe y no aprueba), uno con `approve` sin `receive` (aprueba y el Guardar del detalle le da 403 **con el botón ya oculto**), y un MANAGER sin cambios (todo sigue funcionando — la prueba de que no se rompieron 70 sucursales). Más el chatbot: "recibe la orden X" con un usuario que sólo tenga `receive` **debe ejecutarse**, no responder "no entendí" (ése es el bug de `hasAnyMutationPermission`).

**V7 — `/full-testing` end-to-end con el interruptor PRENDIDO**, en un venue de prueba (nunca en La Ribera demo, cuyo proveedor tiene buzón vivo): crear → submit bajo umbral (aprueba sola) → crear → submit sobre umbral (queda pendiente) → rechazar → corregir → reenviar → aprobar → enviar (verificar UN correo, no dos) → confirmar → recibir por renglón (verificar `receivedBy` sellado) → deshacer recepción (verificar lotes revertidos) → intentar subir el monto vía `/fees` y vía PUT de items estando aprobada (debe degradar o rechazar). Validado contra Postgres con `psql`, no contra la UI.

**V8 — `npm run pre-deploy`** antes de cada uno de los dos deploys.

---

## 5. ESTIMACIÓN HONESTA

Un dev senior (o una sesión de agente supervisada), días **hábiles de trabajo efectivo**, no de calendario.

| Fase | Contenido | Días |
|---|---|---|
| 0 | Decisiones + baseline V0 grabado como suite | 1.5 |
| 1 | T01 máquina de estados, T02 permisos + tests, T03 migración + schema map | 2.0 |
| 2 | T04 workflow, T05 política, T06 seis rutas, **T07 undo-receive con reversión de stock (1.5 sola)**, T08 correo + idempotencia, T09 puertas laterales, T10 caminos de creación | 5.0 |
| 3 | T11–T14 dashboard (cliente, 6 llamadores, código muerto, MSW) | 1.5 |
| 4 | Deploys + soak + T17 retiro de `status` con superRefine | 1.0 (+4 días de calendario de soak) |
| 5 | T18 guard de núcleo + receivedBy, T19 rutas, T20 chatbot, T21 MCP, T22 espejo, T23 PermissionGate, T24 migración de datos, T25 /mobile | 4.0 |
| 6 | T26 backend de ajustes, T27 pantalla | 2.0 |
| 7 | T28 regresión + full-testing, T29 deck+PDFs, T30 docs de huecos | 2.0 |
| | **Total trabajo efectivo** | **19 días** |

**Calendario realista: 5 semanas.** 19 días de trabajo + 4 días de soak obligatorio entre los dos deploys + la ida y vuelta con las sesiones de iOS/Android por `RECEIVABLE_STATUSES` (T18) y por el gate de `/mobile` (T25), que no se puede comprimir porque no depende de nosotros.

**Con dos sesiones en paralelo** siguiendo las 5 olas de la sección 2: **13-14 días de trabajo**, ~4 semanas de calendario. No baja más: las Fases 2 y 4 son casi enteramente seriales por el archivo `purchaseOrder.service.ts` y por el orden de deploy.

**Qué mueve la estimación:**
- **D-1 = "sólo etiqueta"** ahorra **1.5 días** (T07 se vuelve trivial) pero conserva el doble conteo de existencias. No lo recomiendo: es el único bug de inventario real que este plan puede cerrar de paso.
- **D-3 = "rechazar sigue siendo cancelar"** ahorra ~0.5 día y deja la autorización sin vuelta atrás.
- **D-7 = "recortar el comodín de ADMIN/OWNER"** suma **+2 días** y un riesgo de regresión que excede esta feature.
- **T24 (migración de overrides en producción)** es la única tarea con riesgo de datos irreversible: presupuestada en 0.5 día, pero exige respaldo previo y un `--dry-run` revisado a mano.

**Comparación honesta con v1:** v1 estimaba una superficie de ~6 archivos. La real son **~34 archivos en 2 repos**, 1 migración de esquema, 1 migración de datos en producción, 2 deploys separados por soak, y 3 superficies (chatbot, MCP, /mobile) que el plan v1 no mencionaba y que se saltan por completo la capa de rutas donde v1 pensaba poner los candados.
