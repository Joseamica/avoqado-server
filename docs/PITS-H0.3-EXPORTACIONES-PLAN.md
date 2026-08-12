# PITS · H0.3 — Exportaciones: plan de implementación

> Levantado el 2026-08-07 cruzando el patrón de exportación que ya funciona en producción (pagos, órdenes, resumen de ventas) contra los
> cuatro módulos donde contestamos "exportable" en la matriz de PITS y hoy no lo es: bitácora, inventario, compras y contabilidad.
>
> **Estado: NO implementado.** Este documento es el plan, no el reporte de lo hecho. Trae dos bloqueos de día 0 que son decisiones del
> fundador, no técnicas — están en §0.

---

# PLAN DE IMPLEMENTACIÓN — H0.3 «Exportable» (PITS)

**Alcance:** conectar el helper genérico de exportación a los listados donde contestamos "exportable" en la matriz y hoy no lo es.
**Repos:** `avoqado-server` (rutas/servicios/controladores) + `avoqado-web-dashboard` (botones y diálogo). **Restricción de programa:** H0
son 2 semanas para NUEVE puntos. Este plan compromete **10 rutas nuevas** y declara explícitamente el corte si el tiempo aprieta (§6).

---

## 0. DOS BLOQUEOS DE DÍA 0 (antes de escribir una línea)

**B1 — ¿En qué tier queda PITS?** Los tres namespaces que vamos a tocar ya están detrás de un candado de plan y el export lo hereda sin
código extra:

| Namespace             | Gate                                                            | Archivo:línea                                                       |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Inventario y compras  | `checkFeatureAccess('INVENTORY_TRACKING')` a nivel `router.use` | `src/routes/dashboard/inventory.routes.ts:108`                      |
| Bitácora por sucursal | `checkFeatureAccess('VENUE_AUDIT_LOG')` por ruta                | `src/routes/dashboard/activityLog.routes.ts:30,40,48`               |
| Contabilidad Capa B   | `checkFeatureAccess('CFDI')` por ruta                           | `src/routes/dashboard/accounting.routes.ts:173,272,344,373,471,536` |

Si el venue de PITS no tiene los tres, **el export nace en 403 y el mensaje dirá "tu plan no lo incluye", no "no implementado"** — que en
una verificación de consultora se lee igual de mal. Hay que confirmarlo con el founder antes de la demo. (No verifiqué en base de datos qué
features tiene hoy el venue/organización de PITS; es lectura de código, no de prod.)

**B2 — ¿Quién puede exportar la bitácora?** `activity:read` existe (`src/lib/permissions.ts:1468` catálogo, `:967` defaults) pero **sólo lo
tiene OWNER** (más SUPERADMIN por `*:*`). Verificado: no aparece en ADMIN (`:853`) ni en MANAGER (`:713`). Un contralor de PITS con rol
ADMIN **no podrá exportar la bitácora**. Dos salidas y hay que elegir una:

- (a) Recomendada: agregar `'activity:read'` a `DEFAULT_PERMISSIONS[ADMIN]` (`src/lib/permissions.ts:853`) — NO a MANAGER. Es un cambio de
  política de producto: decisión del founder, no mía.
- (b) Dejarlo como está y darle a PITS un rol custom con `activity:read` (es asignable individualmente porque está en el catálogo `:1468`).

En cualquier caso **NO se crea `activity:export` ni `inventory:export` ni `accounting:export`**: nacerían sin defaults y el audit los
marcaría PHANTOM (`npm run audit:permissions`).

---

## 1. QUÉ SE EXTRAE PRIMERO — y qué NO se toca

### 1.1 Decisión: extracción **aditiva**, cero cambios a los tres caminos vivos

Los tres exports en producción (pagos, órdenes, resumen de ventas) **NO se refactorizan en H0.3**. Justificación concreta, no ideológica:

- La deuda real (D3 del levantamiento) es que `buildPaymentsWhereClause` (`src/services/dashboard/payment.dashboard.service.ts:272`) y
  `buildOrdersWhereClause` (`src/services/dashboard/order.dashboard.service.ts:157`) son **copias** del `where` inline del listado, no
  extracciones. Arreglarlo obliga a tocar `getPaymentsData` y `getOrders`, que son las dos pantallas de mayor tráfico del dashboard, **sin
  una sola prueba de export que las cubra** (verificado: ningún archivo bajo `tests/` importa `encodeExport`/`sendExport`), y con la rama
  especial de fusión de pagos QR legacy de MindForm de por medio (`payment.dashboard.service.ts:129-211`). Riesgo alto, beneficio nulo para
  PITS.
- Lo que sí hacemos es **no repetir el defecto**: en todo lo nuevo el `build…WhereClause` se escribe UNA vez y **el listado también lo
  llama** desde el primer commit.

### 1.2 Lo que sí se extrae (todo aditivo, nada rompe hoy)

**Backend — se AGREGAN a `src/services/dashboard/export.helpers.ts`** (el archivo ya es agnóstico del dominio; hoy termina en
`parseFormatParam`, línea 226):

```ts
// 1. D1 — hoy copiado 4 veces (payment.dashboard.controller.ts:53 y :301,
//    order.dashboard.controller.ts:39 y :147, sales-summary…:202)
export function parseListParam(raw: unknown): string[] | undefined

// 2. D2 — hoy copiado 3 veces con el texto reescrito a mano
//    ("filas" payment…:320-331, "órdenes" order…:166-176, "transacciones" sales-summary…:251-261)
export function sendRowCapExceeded(res: Response, opts: { total: number; cap: number; format: ExportFormat; noun: string }): void // UN solo texto en español, con el sustantivo por parámetro

// 3. Contabilidad — el ledger es Int en centavos (§4.3). SIN esto entregamos un 100x.
export const pesosFromCents = (c: number | null | undefined): number => (c == null ? 0 : Math.round(c) / 100)

// 4. Fechas venue-local — los tres caminos vivos emiten toISOString() (UTC crudo).
//    Bitácora, kardex y compras se leen como documento de contraloría: no se hereda.
export function venueDateTimeCell(d: Date | null | undefined, tz: string): string // 'yyyy-MM-dd HH:mm:ss'
export function venueDateCell(d: Date | null | undefined, tz: string): string // 'yyyy-MM-dd'

// 5. Normalización del rango que manda el diálogo (§4.4)
export function toYmd(raw: unknown): string | undefined // '2026-08-07T00:00:00.000Z' -> '2026-08-07'

// 6. Celdas repetidas
export const siNoCell = (v: unknown): string => (v ? 'Sí' : 'No')
```

**Backend — redacción de PII, en el servicio de bitácora, no en el helper.** `redactSensitive` vive HOY sólo en el cliente y sólo en una de
las dos pantallas (`avoqado-web-dashboard/src/pages/Venue/VenueActivityLog.tsx:44-56`); la de organización hace
`JSON.stringify(log.data, null, 2)` **crudo** (`OrganizationActivityLog.tsx:364`). Un archivo no pasa por la UI. Se porta el **mismo regex**
a `src/services/dashboard/activity-log.service.ts` y se usa en las columnas `resumen` y `dataJson`. No se quita del cliente (defensa en
profundidad).

**Frontend — UNA prop aditiva a `ExportDialog`.** Hoy el diálogo **siempre** sobreescribe `startDate`/`endDate` con `.toISOString()`
(`avoqado-web-dashboard/src/components/export-dialog.tsx:111-112`) y exige `initialDateFrom/To` (`:40-41`). Eso rompe o miente en 6 de los
10 endpoints nuevos. Se agrega:

```ts
/** 'iso' (default, comportamiento actual) | 'ymd' (YYYY-MM-DD) | 'none' (oculta el picker y no manda fechas) */
dateParam?: 'iso' | 'ymd' | 'none'
```

Con default `'iso'`, `Payments.tsx` y `Orders.tsx` no cambian ni una línea. `initialDateFrom/To` pasan a opcionales sólo cuando es `'none'`.
**NO** se fusiona `SalesSummaryExportDialog.tsx` con `ExportDialog` (D6) ni se extrae `useBlobExport` (D5) en H0: son 2 consumidores, no 8,
y el ahorro llega después.

### 1.3 El único refactor "de los vivos" que sí vale: pruebas del helper

Antes de multiplicar por 10, un test unitario de `export.helpers.ts` (D8). Es puro, barato y protege los diez caminos de golpe. Ver §5.0.

---

## 2. ORDEN DE IMPLEMENTACIÓN, con el criterio

**Criterio (en este orden de prioridad):**

1. **Qué renglón de la matriz cierra y qué tan verificable es en 30 segundos.** Una consultora abre la pantalla y busca el botón. La
   bitácora es donde dijimos "exportable" con esas palabras exactas y donde hoy no hay ni botón.
2. **Riesgo de entregar algo que abre bien y miente.** Todo lo que estructuralmente no puede cumplir (lotes de mercancía de reventa,
   valorización sin `Product`) se saca del hito, no se "conecta rápido".
3. **Cuánto trabajo NO-export arrastra.** Compras y kardex arrastran subir filtros de cliente a servidor: eso es la mitad del costo real y
   hay que decirlo antes, no descubrirlo el jueves.

| #     | Bloque       | Entregable                                                          | Días |
| ----- | ------------ | ------------------------------------------------------------------- | ---- |
| **0** | Andamiaje    | Helpers aditivos + `dateParam` en `ExportDialog` + tests del helper | 0.5  |
| **1** | Bitácora     | A. venue · B. organización                                          | 1.5  |
| **2** | Compras      | C. OC (orden + renglón, una ruta) · D. proveedores                  | 1.5  |
| **3** | Inventario   | E. insumos · F. kardex · G. conteos (detalle)                       | 2    |
| **4** | Contabilidad | H. gastos · I. balanza · J. catálogo de cuentas                     | 1    |

**Total 6.5 días.** Con 9 puntos en 2 semanas, esto ya es la mitad del hito para una persona. El corte, si hay que cortar, está en §6.

**Deconflicto con H0.4:** el punto H0.4 del programa ya es _"Botón de pólizas XML + export de estado de resultados y balance"_. Por eso **el
estado de resultados y el balance general (filas 142/143/155) NO son de H0.3** — H0.3 entrega el andamiaje (`pesosFromCents`,
`dateParam:'none'`, el patrón de reusar el servicio completo y aplanarlo) y H0.4 lo consume. Si se implementan aquí, se duplica trabajo con
la otra tarea.

---

## 3. LAS DIEZ EXPORTACIONES, una por una

> Convención común a todas (no la repito): controlador copiado literal de
> `src/controllers/dashboard/payment.dashboard.controller.ts:275-393`, con `parseFormatParam` → `parseColumnsParam` → `getRowCapForFormat` →
> filtros → `count` → `sendRowCapExceeded` → `fetch(take: cap)` → `encodeExport` → `sendExport`. Etiquetas **en duro y en español** en el
> backend (así lo hacen los tres caminos vivos). Fallback de columnas: si no llega `?columns=`, se exportan todas.

---

### BLOQUE 1 — BITÁCORA (filas 35, 28, 4)

#### A. Bitácora por sucursal

- **Ruta:** `GET /api/v1/dashboard/venues/:venueId/activity-log/export` Se declara en `src/routes/dashboard/activityLog.routes.ts` **junto a
  `/entities` (:46-51)**. Verificado: ese sub-router NO tiene ninguna ruta dinámica `:param` (sólo `/`, `/actions`, `/entities`), así que
  **no hay trampa de orden aquí**. `authenticateTokenMiddleware` YA viene del `router.use` en `src/routes/dashboard.routes.ts:3511` — **no
  lo repitas**; sí repite `checkFeatureAccess('VENUE_AUDIT_LOG')` + `checkPermission('activity:read')` porque este router no los tiene a
  nivel `use`.
- **Permiso:** `activity:read` (`src/lib/permissions.ts:1468`, defaults `:967`). Ver bloqueo B2.
- **Servicio:** `src/services/dashboard/activity-log.service.ts`. Extraer `buildVenueActivityLogWhere(venueId, venueTz, filtros)` de
  `:252-271` y **hacer que `queryVenueActivityLogs` (:244) la use**. Agregar `countVenueActivityLogsForExport` +
  `fetchVenueActivityLogsForExport` en el MISMO archivo, con el `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` **idéntico al de `:279`**
  (ese desempate está comentado y protegido por prueba; ver §4.2), y ampliando el `select` de staff de `:277` a
  `{ id, firstName, lastName, email }`.
- **Columnas** (14; ✅ = seleccionada por defecto):

| id            | Etiqueta                | Def.                                                                          |
| ------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `createdAt`   | Fecha y hora            | ✅ (venue-local, `venueDateTimeCell(r.createdAt, venue.timezone)`)            |
| `venueName`   | Sucursal                | ✅                                                                            |
| `staffName`   | Usuario                 | ✅ (`Sistema` si `staff` es null, igual que `VenueActivityLog.tsx:378`)       |
| `staffEmail`  | Correo del usuario      | ✅                                                                            |
| `action`      | Código de acción        | ✅                                                                            |
| `actionLabel` | Acción                  | ✅                                                                            |
| `entity`      | Entidad                 | ✅                                                                            |
| `origen`      | Origen                  | ✅ (derivada de `data.source` + `data.terminalSerialNumber` + `data.method`)  |
| `resumen`     | Detalle                 | ✅ (`data` aplanado prof. 1, `clave=valor; …`, tope 200 chars, **redactado**) |
| `entityId`    | ID de entidad           | —                                                                             |
| `ipAddress`   | Dirección IP            | — (**default OFF a propósito**, ver §4.6)                                     |
| `userAgent`   | Dispositivo / navegador | —                                                                             |
| `dataJson`    | Detalle técnico (JSON)  | — (redactado; nunca útil en PDF)                                              |
| `id`          | Folio de bitácora       | —                                                                             |

`actionLabel`: hoy las traducciones viven SÓLO en el i18n del dashboard (`activityLog.actions.*`, con `formatActionFallback` en
`VenueActivityLog.tsx:97`) y hay ~398 acciones distintas. **Se porta al backend un mapa de las ~40 que un contralor audita** (login/logout,
cancelación, cortesía, descuento, devolución, cambio de precio, ajustes, aprobaciones) y para el resto el mismo fallback mecánico (guiones
bajos → espacios, capitalizado). **No se bloquea el export por traducir 398.** Ese mapa lo comparten A y B.

- **Botón:** `avoqado-web-dashboard/src/pages/Venue/VenueActivityLog.tsx:192-195` — hoy es un `<div>` con `h1` + `p`; se convierte en
  `flex items-start justify-between` con el botón a la derecha, mismo tratamiento que `Payments.tsx:1607`. Reutiliza
  `src/components/export-dialog.tsx` **tal cual** (nada de forkear como hizo `SalesSummaryExportDialog.tsx`). `dateParam="ymd"`.
- **`baseParams`:** `search`, `action`, `staffId`, `entity` (los nombres exactos que ya consume el listado vía
  `src/services/venueActivity.service.ts:36-43`), desde el estado que ya existe en `VenueActivityLog.tsx:108-113`. `activeFilterSummary` con
  los chips de sólo lectura.
- **ActivityLog del propio export:** **SÍ.** `ACTIVITY_LOG_EXPORTED` con `{ alcance:'venue', formato, filas, filtros, columnas }`,
  `void logAction(...)` fire-and-forget, **después** de pasar el 413 y fuera de cualquier transacción. Es 1 renglón por descarga y es
  exactamente el evento que un auditor quiere ver. Sólo para A y B (ver §6).

#### B. Bitácora por organización

- **Ruta:** `GET /api/v1/dashboard/organizations/:orgId/activity-log/export` En `src/routes/dashboard/organizationDashboard.routes.ts`,
  junto a `:1532`. Verificado: no hay ruta dinámica después del segmento `activity-log`, así que `/export` no queda capturada. **En este
  archivo `authenticateTokenMiddleware` va POR RUTA** (`:1532`), no en un `router.use` → hay que declararlo:
  ```ts
  router.get(
    '/:orgId/activity-log/export',
    authenticateTokenMiddleware,
    checkOrgAccess,
    checkPermission('activity:read'),
    exportOrgActivityLog,
  )
  ```
- **Permiso:** `activity:read`. 🔴 **Hallazgo que reporto aparte y NO arreglo aquí:** el listado de organización (`:1532`) hoy lleva
  **sólo** `checkOrgAccess` (`:43-66`, que únicamente compara `authContext.orgId === req.params.orgId`) — **cualquier staff de la
  organización, incluido un WAITER, puede leer la bitácora completa de todas las sucursales**. Poner una descarga masiva encima de eso sin
  candado convierte una sobre-exposición paginada en una vía de extracción. El **export lleva `checkPermission('activity:read')` desde el
  día 1**; el listado se arregla en tarea aparte porque cambia el comportamiento de una pantalla en producción.
- **Servicio:** extraer `buildOrgActivityLogWhere` de `queryActivityLogs` (`activity-log.service.ts:126-155`) y hacer que
  `queryActivityLogs` (`:109`) la use. 🔴 **Al extraer hay que corregir el bug de zona horaria**: `:152-153` usa hoy
  `new Date(params.startDate)` (verificado), que es la trampa documentada en `critical-warnings.md` — en prod (Node en UTC) corre el día
  completo. Se arregla ahí, no después. El `orderBy` de `:173` ya es estable, se reusa idéntico. Además, el mapa de venues de `:113-117` hoy
  trae `{ id, name }`: **hay que sumarle `timezone`**, porque en un consolidado cada sucursal formatea su fecha en SU huso (§4.4).
- **Columnas:** las mismas 14 de A, con `venueName` marcada `required: true` en el diálogo (es literalmente lo que PITS pidió: "filtrable
  por sucursal").
- **Botón:** `avoqado-web-dashboard/src/pages/Organization/OrganizationActivityLog.tsx:166-169` (mismo `<div>` de encabezado, mismo
  tratamiento). Servicio de front a extender: `src/services/organizationDashboard.service.ts`.
- **`baseParams`:** `venueId`, `action`, `search` (nombres verificados en la ruta, `:1535`). ⚠️ Asimetría real: esta pantalla **no tiene**
  filtro de fechas ni de usuario, pero el diálogo sí impone un rango. Es aceptable (el diálogo es dueño del rango, igual que en pagos), pero
  **el `activeFilterSummary` debe decirlo explícito** y el rango inicial se siembra en **últimos 30 días**, o el primer clic pega contra el
  tope de 10 000.

---

### BLOQUE 2 — COMPRAS (filas 58, 59, 75, 77, 78, 79, 196)

#### C. Órdenes de compra — dos granularidades, UNA ruta

- **Ruta:** `GET /api/v1/dashboard/venues/:venueId/inventory/purchase-orders/export?granularity=order|item` 🔴 **Se declara entre
  `src/routes/dashboard/inventory.routes.ts:703` (`/purchase-orders/stats`) y `:712` (`/purchase-orders/:purchaseOrderId`).** El propio
  archivo lleva el aviso en `:699-702`: _"Cualquier ruta ESTÁTICA de este grupo tiene que quedar arriba"_ — ya nos mató `/stats` una vez.
  Una sola ruta con branch por `granularity`, igual que `sales-summary.dashboard.controller.ts:177-366` resuelve `summary` vs `detailed`.
  `granularity` se valida contra whitelist `['order','item']` con default `'order'`; **valor inválido = 400 con mensaje en español** (aquí
  NO se copia el silencio de `parseFormatParam`).
- **Permiso:** `inventory:read` (`src/lib/permissions.ts:1498` catálogo, `:156-159` deps, defaults: MANAGER `:761`, ADMIN/OWNER por wildcard
  `inventory:*`). Verificado. **VIEWER y CASHIER no lo tienen**: un contralor con rol VIEWER no exporta.
- **Servicio:** `src/services/dashboard/purchaseOrder.service.ts`. Extraer `buildPurchaseOrdersWhereClause` del `where` inline de
  `getPurchaseOrders` (`:451-457`) y **hacer que `getPurchaseOrders` (:442) la use**. Agregar `countPurchaseOrdersForExport` /
  `fetchPurchaseOrdersForExport` (granularidad orden) y `countPurchaseOrderItemsForExport` / `fetchPurchaseOrderItemsForExport`
  (granularidad renglón, `prisma.purchaseOrderItem` con `where: { purchaseOrder: <mismo where> }`).
  - `orderBy` orden: `[{ orderDate: 'desc' }, { id: 'desc' }]` — hoy es sólo `{ orderDate: 'desc' }` (**verificado, `:496-498`**) y el job
    de auto-reorder crea varias OC el mismo día.
  - `orderBy` renglón: `[{ purchaseOrder: { orderDate: 'desc' } }, { purchaseOrderId: 'desc' }, { id: 'asc' }]`.
  - **El pre-flight cuenta la MISMA entidad que se exporta.** Contar órdenes y traer renglones deja el cap de 10 000 sin efecto.
  - `include` **más ligero** que el del listado: los nombres de `createdBy`/`approvedBy`/`rejectedBy`/`receivedBy` son `String?` planos sin
    relación (`prisma/schema.prisma`, modelo `PurchaseOrder`), así que **se resuelven en UN solo
    `staff.findMany({ where: { id: { in: [...] } } })` + Map**, jamás con `getStaffSummary` por fila (`purchaseOrder.service.ts:260`) o son
    40 000 queries.
- **Columnas, granularidad `order`** (✅ default): `orderNumber` Folio ✅ · `orderDate` Fecha de orden ✅ · `supplierName` Proveedor ✅ ·
  `supplierTaxId` RFC del proveedor ✅ · `status` Estatus ✅ · `expectedDeliveryDate` Entrega comprometida ✅ · `receivedDate` Fecha de
  recepción ✅ · `itemsCount` Renglones ✅ · `subtotal` Subtotal ✅ · `taxAmount` IVA ✅ · `commission` Comisión / otros cargos — · `total`
  Total ✅ · `createdByName` Capturó ✅ · `approvedByName` Autorizó ✅ · `approvedAt` Fecha de autorización — · `rejectedByName` Rechazó — ·
  `rejectionReason` Motivo de rechazo — · `autoGenerated` Generada automáticamente — · `notes` Notas —
- **Columnas, granularidad `item`:** `orderNumber` Folio ✅ · `orderDate` Fecha de orden ✅ · `supplierName` Proveedor ✅ · `status` Estatus
  de la orden ✅ · `itemType` Tipo (Insumo / Mercancía de reventa) ✅ · `itemSku` SKU ✅ · `itemName` Artículo ✅ · `presentationName`
  Presentación de compra — · `presentationFactor` Unidades base por presentación — · `unit` Unidad ✅ · `quantityOrdered` Cantidad pedida ✅
  · `quantityReceived` Cantidad recibida ✅ · `quantityDifference` Diferencia (faltante/sobrante) ✅ · `receiveStatus` Estatus del renglón
  ✅ · `unitPrice` Precio unitario ✅ · `lineTotal` Importe del renglón ✅ · `itemNotes` Notas del renglón — 🔴 **El renglón NO repite
  `taxAmount`/`commission`/`total` de la orden**: el IVA y la comisión viven en la ORDEN, no en el renglón, y repetirlos por fila produce
  doble conteo en cuanto alguien pivotea. Por lo mismo el gasto (fila 58) no se deriva del archivo de renglones. Filtros propios del
  renglón: `receiveStatus[]` y `soloConDiferencia=true` — es lo que cierra las filas 77 y 79 ("faltantes, sobrantes y rechazos").
- **Botón:** `avoqado-web-dashboard/src/pages/Inventory/PurchaseOrders/PurchaseOrdersPage.tsx:681`, junto al botón de crear (bloque de
  encabezado `:673-685`), como `DropdownMenu` con dos entradas ("Exportar órdenes" / "Exportar renglones") que abren el **mismo**
  `ExportDialog` cambiando `columns`, `filenameStem` y `baseParams.granularity`. `dateParam="ymd"`.
- 🔴 **La mitad del costo de este punto no es el export:** hoy la pantalla manda al backend **sólo `status`**
  (`PurchaseOrdersPage.tsx:111-116`; también manda `search`, que el backend descarta porque no está en `GetPurchaseOrdersQuerySchema`,
  `src/schemas/dashboard/inventory.schema.ts:480-488`). Todo lo demás se filtra en memoria en el cliente (`:133-289`: búsqueda, folio,
  proveedor, fecha de orden, fecha de entrega, rango de total, rango de renglones). **En el MISMO cambio** el `where` compartido acepta
  `status[]`, `supplierIds[]`, `orderNumber`, `search`, `startDate`/`endDate` (sobre `orderDate`), `expectedFrom/expectedTo`,
  `totalMin/totalMax`, `itemsMin/itemsMax`, y la pantalla sube esos filtros al servidor. Sin esto el archivo trae órdenes que el usuario ya
  había descartado y nadie lo nota.

#### D. Padrón de proveedores

- **Ruta:** `GET /api/v1/dashboard/venues/:venueId/inventory/suppliers/export` 🔴 **Entre `inventory.routes.ts:571` (`/suppliers`) y la
  primera `/suppliers/:supplierId…` (`:672`)**: si queda debajo, Express captura `export` como `supplierId` y la ruta nace muerta.
- **Permiso:** `inventory:read` (mismo que `:571`).
- **Servicio:** `src/services/dashboard/supplier.service.ts`. Extraer el `where` de `getSuppliers` (`:19-31`) y reusarlo. El `orderBy`
  `[{rating:'desc'},{name:'asc'}]` (`:64`) **ya es único** (`@@unique([venueId, name])` en `Supplier`) — se conserva. **El `include` del
  export es más ligero que el del listado** (`:35-63`): nada de traer `pricing` completo ni las 5 últimas OC por proveedor; sólo
  `_count.purchaseOrders` y la última `orderDate`.
- **Columnas:** `name` Proveedor ✅ · `taxId` RFC ✅ · `contactName` Contacto ✅ · `email` Correo ✅ · `phone` Teléfono ✅ · `address`
  Dirección — · `city` Ciudad — · `state` Estado — · `zipCode` C.P. — · `country` País — · `leadTimeDays` Días de entrega ✅ ·
  `minimumOrder` Pedido mínimo — · `rating` Calificación ✅ · `reliabilityScore` Confiabilidad — · `active` Estatus ✅ · `notes`
  Observaciones — · `createdAt` Fecha de alta — · `purchaseOrdersCount` Órdenes de compra ✅ · `lastOrderDate` Última compra ✅
- **Botón:** `avoqado-web-dashboard/src/pages/Inventory/Suppliers/SuppliersPage.tsx:269-278`, junto al botón de crear (encabezado
  `:263-278`). La página ya está envuelta en `<FeatureGate feature="INVENTORY_TRACKING">` (`:261`), consistente con el gate del router.
- **`dateParam="none"`** — un padrón no es una serie temporal. Si el diálogo mandara `startDate/endDate` y el backend los aplicara sobre
  `createdAt`, el contralor exporta "proveedores" y recibe sólo los dados de alta en el rango: pérdida silenciosa, el peor modo de falla.
- **`baseParams`:** `search` (ya va al backend, `supplier.service.ts:24-30`) **y `active`**, que hoy se filtra en el cliente
  (`SuppliersPage.tsx:227-235`) y hay que subir.

---

### BLOQUE 3 — INVENTARIO (filas 85, 93, 95, 196)

> Contexto que hay que tener presente: **en la pantalla de aterrizaje del módulo ya hay un botón "Exportar" que no hace nada** —
> `avoqado-web-dashboard/src/pages/Inventory/InventorySummary.tsx:643-648`, un `<button>` sin `onClick`. Ese botón es el primer sitio donde
> una consultora va a hacer clic. Conectarlo es parte de este bloque.

#### E. Existencias de insumos

- **Ruta:** `GET /api/v1/dashboard/venues/:venueId/inventory/raw-materials/export` 🔴 **Verificado que debe ir entre
  `inventory.routes.ts:131-136` (`/raw-materials`) y `:145-150` (`/raw-materials/:rawMaterialId`)** — esa dinámica valida cuid, así que si
  `/export` queda abajo el endpoint devuelve 400 para todo el mundo, exactamente como pasó con `/purchase-orders/stats`.
- **Permiso:** `inventory:read`.
- **Servicio:** `src/services/dashboard/rawMaterial.service.ts`. Extraer `buildRawMaterialsWhereClause` del `where` de `getRawMaterials`
  (**verificado `:68-76`**) y hacer que `getRawMaterials` (`:59`) la use. `orderBy: [{ name: 'asc' }, { id: 'asc' }]` (hoy es sólo
  `{ name: 'asc' }`, `:93`). 🔴 **Decisión sobre `lowStock`:** hoy se aplica **después** del `findMany`, en memoria (**verificado,
  `:96-98`**: `currentStock <= reorderPoint`, comparación entre columnas que Prisma no expresa). Si se queda así, el pre-flight `count` no
  puede usar el mismo `where` y **el 413 mentiría**. Decisión para H0: cuando `lowStock=true`, el conteo se hace sobre el arreglo ya
  filtrado (el universo de insumos de un venue son cientos, no decenas de miles, y el `findMany` sin `take` ya existe hoy en el listado). Se
  documenta en el JSDoc. Migrar a `$queryRaw` es H1.
- **Columnas:** `sku` SKU ✅ · `name` Insumo ✅ · `category` Categoría ✅ · `currentStock` Existencia ✅ · `unit` Unidad ✅ · `minimumStock`
  Mínimo ✅ · `reorderPoint` Punto de reorden ✅ · `costPerUnit` Costo unitario ✅ · `avgCostPerUnit` Costo promedio (PEPS) ✅ ·
  `valorInventario` Valor inventario ✅ (`currentStock × avgCostPerUnit`, **pesos 1:1**) · `shelfLifeDays` Vida útil (días) — · `bajoMinimo`
  Bajo mínimo ✅ (`siNoCell`) · `recetasQueLoUsan` Recetas que lo usan — · `active` Activo ✅
- **Botón:** `InventorySummary.tsx:643-648` — **ahí va el `onClick={() => setExportOpen(true)}`** del botón muerto. Segundo sitio opcional:
  `src/pages/Inventory/RawMaterials.tsx` (barra de `FilterPill`). Ninguna pantalla de inventario importa hoy `ExportDialog` (verificado); se
  usa el de `src/components/export-dialog.tsx`, sin forkear. `dateParam="none"` (una existencia es una foto de hoy, no un rango).
- **`baseParams`:** `category`, `lowStock`, `active`, `search` — ya validados por `GetRawMaterialsQuerySchema` (`inventory.routes.ts:134`).

#### F. Kardex de movimientos (fila 93: "historial completo… exportable")

- **Ruta:** `GET /api/v1/dashboard/venues/:venueId/inventory/movements/export` Se declara inmediatamente encima de
  `inventory.routes.ts:1374` (`/movements`). Verificado que `/movements` no tiene hermana dinámica: sin trampa de orden.
- **Permiso:** `inventory:read` (mismo que `:1376`).
- **Servicio:** 🔴 **NO se reusa `getGlobalMovements`** (`src/services/dashboard/productInventory.service.ts:185-327`). Está inservible para
  exportar: `take: limit * page` (`:239`, `:262`), merge y paginación **en memoria** (`:308-317`) y `total: 1000, // Dummy total` (`:322`).
  Con eso el 413 nunca dispararía y el CSV saldría truncado en silencio. Se escriben `buildProductMovementsWhere` +
  `buildRawMaterialMovementsWhere`, **dos `count()` reales que se suman** para el pre-flight, y dos `findMany` con `take: cap` cada uno
  antes de fusionar y recortar a `cap`. 🔴 **`InventoryMovement` NO tiene `venueId`** (verificado en `prisma/schema.prisma`, modelo
  `InventoryMovement`): el único camino al tenant es `inventory: { venueId }`, como hace `productInventory.service.ts:214-223`.
  `RawMaterialMovement` sí lo tiene. **Esa asimetría es la trampa**: un `where` que la olvide cruza venues en silencio. `orderBy` de cada
  rama: `[{ createdAt: 'desc' }, { id: 'desc' }]` — hoy es sólo `createdAt desc` (`:238`, `:261`) y los movimientos de una recepción o un
  conteo se escriben en el MISMO instante en lote: empates masivos, corte no determinista. Resolver `createdBy`: es `String` suelto sin
  relación (`InventoryMovement.createdBy`, `RawMaterialMovement.createdBy`) → lookup por lote a `Staff` + Map. Exportar un cuid en la
  columna "Usuario" no le sirve a contraloría, y la matriz promete "usuario responsable" por nombre (filas 88 y 90).
- **Columnas:** `createdAt` Fecha y hora ✅ (**venue-local**) · `origen` Tipo de artículo ✅ (Insumo / Mercancía de reventa) · `sku` SKU ✅
  · `itemName` Artículo ✅ · `type` Tipo de movimiento ✅ (enum **traducido**, no crudo) · `quantity` Cantidad ✅ · `unit` Unidad ✅ ·
  `previousStock` Existencia anterior ✅ · `newStock` Existencia nueva ✅ · `unitCost` Costo unitario del movimiento ✅ (el del
  movimiento/lote, **no** el costo actual del producto que devuelve hoy `productInventory.service.ts:278`) · `costImpact` Impacto en costo —
  · `batchNumber` Lote — · `reason` Motivo ✅ · `reference` Referencia — · `supplier` Proveedor — · `createdByName` Usuario ✅
- **Botón:** `avoqado-web-dashboard/src/pages/Inventory/InventoryHistory.tsx` — encabezado de la página; el `ColumnCustomizer` ya define los
  ids visibles (`:141`, `:487-492`): **se reusan esos mismos ids** como los del backend. `dateParam="ymd"`.
- 🔴 **Dos trabajos NO-export que arrastra:**
  1. La pantalla llama `getGlobalMovements(venueId!, {})` — **sin filtros** (`InventoryHistory.tsx:146-148`) — y con `limit` default 50
     (`src/schemas/dashboard/inventory.schema.ts:1037`): el "historial completo" que el contralor ve hoy son los **últimos 50 movimientos**,
     y los filtros de la pantalla filtran esas 50 filas. Hay que subir `startDate`/`endDate`/`search`/`type` al servidor **antes** de colgar
     el export, o el archivo no es "lo que se ve".
  2. El enum `type` del schema (`ALL/RECEIVED/COUNT/WASTE/RETURN/SALE/TRANSFER`, `inventory.schema.ts:1034-1043`) **no coincide** con
     `MovementType` ni con `RawMaterialMovementType` de Prisma; sólo `RECEIVED` está mapeado a mano (`productInventory.service.ts:227-229`)
     y `WASTE` no existe en ningún enum. **No verifiqué en runtime qué hace Prisma con `{ type: 'WASTE' }`.** Hay que revisar ese mapeo
     antes de exportar por tipo, porque "merma" es justo lo que prometen las filas 90 y 93.

#### G. Conteos físicos y diferencias (fila 95)

- **Ruta:** `GET /api/v1/dashboard/venues/:venueId/inventory/stock-counts/export?level=detail|header` (default `detail`) 🔴 **Verificado que
  debe ir antes de `inventory.routes.ts:1424` (`/stock-counts/:countId`)**, junto a `:1415`. `detail` por default porque la matriz pide
  "Diferencias de inventario": **líneas, no cabeceras**.
- **Permiso:** `inventory:read` (el que ya usa `:1415`). Ojo: el candado de **ajuste** es `inventory:adjust` (`permissions.ts:162`) —
  leer/exportar conteos no es ajustar; no confundirlos (eso es H0.7).
- **Servicio:** 🔴 **NO reusar `getStockCounts`** (`src/services/mobile/inventory.mobile.service.ts:152-177`): trae TODOS los conteos con
  TODOS sus items sin `take` y el controlador filtra y pagina en memoria
  (`src/controllers/dashboard/inventory/stockCount.controller.ts:35-57`). Query nueva sobre `stockCountItem` con
  `where: { stockCount: { venueId, …filtros } }` — 🔴 **`StockCountItem` no tiene `venueId` propio**, el aislamiento va por la relación.
  `orderBy: [{ stockCount: { createdAt: 'desc' } }, { stockCountId: 'desc' }, { id: 'asc' }]`.
- **Columnas:** `countNumber` Folio de conteo ✅ · `createdAt` Fecha del conteo ✅ (venue-local) · `type` Tipo ✅ · `status` Estatus ✅ ·
  `createdByName` Capturó ✅ (aquí **sí** hay relación a `Staff`) · `note` Nota — · `itemType` Tipo de artículo ✅ · `sku` SKU ✅ ·
  `itemName` Artículo ✅ · `unit` Unidad ✅ · `expected` Existencia en sistema ✅ · `counted` Contado físico ✅ · `difference` Diferencia ✅
  · `valorDiferencia` Valor de la diferencia ✅ (pesos 1:1) · `countedAt` Fecha de captura de la línea — · `completedAt` Fecha de cierre —
- **Botón:** `avoqado-web-dashboard/src/pages/Inventory/StockCounts/StockCountsPage.tsx`, encabezado. `dateParam="ymd"`.
- **`baseParams`:** `status`, `type`, `startDate`, `endDate` (ya documentados en `inventory.routes.ts:1395-1414` y leídos en
  `stockCount.controller.ts:29`). ⚠️ **Al bajarlos al `where` hay que corregir el parseo**: hoy se filtra en memoria con
  `new Date(startDate)` + `end.setHours(23,59,59,999)` (`stockCount.controller.ts:43-49`), que es hora del **host** (prod corre UTC). Usar
  `parseDbDateRange(from, to, venue.timezone)` o `venueStartOfDay`/`venueEndOfDay`.

---

### BLOQUE 4 — CONTABILIDAD, sólo los listados baratos (filas 158, 196)

> Los cuatro comparten: `checkFeatureAccess('CFDI')` **antes** de `checkPermission('accounting:read')` (mismo orden que las rutas vigentes)
> y `dateParam="none"` (filtran por `period`/`asOf`, no por rango). El 403 de feature se copia **verbatim** de
> `src/controllers/dashboard/sales-summary.dashboard.controller.ts:232-237` (`error`/`message`/`featureCode`/`subscriptionRequired`): el
> `FeatureGate` del dashboard depende de esa forma exacta. `authenticateTokenMiddleware` ya viene del `router.use` de
> `src/routes/dashboard.routes.ts:4151`. **Permiso verificado:** `accounting:read` existe — `src/lib/permissions.ts:291` (deps), `:713`
> MANAGER, `:853` ADMIN, `:971` OWNER, `:1471` catálogo. **TODAS las columnas de dinero pasan por `pesosFromCents()` en el `value()` de la
> columna.** Ver §4.3.

#### H. Gastos / buzón de CFDIs recibidos (fila 158)

- **Ruta:** `GET .../accounting/expenses/export?period=&paymentStatus=&proveedorRfc=&includeCancelled=&format=` — inmediatamente después de
  `src/routes/dashboard/accounting.routes.ts:471`, y **antes** de los `POST /expenses/:expenseId/pay` (`:514`). Hoy no colisiona por método,
  pero es la trampa esperando.
- **Servicio:** `listExpenses` (`src/services/fiscal/expense.service.ts:415`) como base. 🔴 **Dos arreglos obligatorios en el fetch de
  export:** (1) el `take: min(limit,500)` (`:444`) es del listado — el export usa `EXPORT_ROW_CAP` con pre-flight `prisma.expense.count` +
  413; (2) el `orderBy { fechaEmision: 'desc' }` (`:443`) **no es único** (decenas de CFDIs el mismo día) →
  `[{ fechaEmision: 'desc' }, { id: 'desc' }]`.
- **Columnas:** `fechaEmision` Fecha de emisión ✅ · `fechaPago` Fecha de pago ✅ · `uuid` UUID (folio fiscal) ✅ · `serie` Serie — ·
  `folio` Folio — · `proveedorRfc` RFC del proveedor ✅ · `proveedorNombre` Proveedor ✅ · `tipoComprobante` Tipo de comprobante — ·
  `usoCfdi` Uso del CFDI — · `metodoPago` Método de pago (PUE/PPD) ✅ · `formaPago` Forma de pago — · `categoria` Categoría ✅ · `subtotal`
  Subtotal ✅ · `descuento` Descuento — · `iva` IVA ✅ · `ieps` IEPS — · `isrRetenido` ISR retenido — · `ivaRetenido` IVA retenido — ·
  `total` Total ✅ · `estatusPago` Estatus de pago ✅ · `pagado` Pagado ✅ (`usoCfdi` y `formaPago` están en el modelo pero **no en el
  DTO**: el `select` del fetch de export los tiene que pedir.)
- **Botón:** `avoqado-web-dashboard/src/pages/Reports/Expenses.tsx:84` (encabezado, junto a importar XML / generar pólizas).
- **`baseParams`:** `period` (lo único que usa hoy la pantalla, `:59`, `:62`) + `paymentStatus` y `proveedorRfc` si se activan.

#### I. Balanza de comprobación

- **Ruta:** `GET .../accounting/trial-balance/export?period=&format=` — después de `accounting.routes.ts:344-350`. Sin hermana dinámica.
- **Servicio:** se **reusa `getTrialBalance()` completo** (`src/services/fiscal/trialBalance.service.ts:71`) y se aplana — mismo patrón que
  el modo `summary` de ventas (`sales-summary.dashboard.controller.ts:341-343`): así los números del archivo **no pueden** diferir de los de
  la pantalla. Sin cap real (son cuentas, cientos como mucho); el `orderBy` por `code` ya es único.
- **Columnas:** `code` Código de cuenta ✅ · `name` Cuenta ✅ · `tipo` Tipo ✅ · `naturaleza` Naturaleza ✅ · `saldoInicialDeudor` Saldo
  inicial deudor ✅ · `saldoInicialAcreedor` Saldo inicial acreedor ✅ · `cargos` Cargos del periodo ✅ · `abonos` Abonos del periodo ✅ ·
  `saldoFinalDeudor` Saldo final deudor ✅ · `saldoFinalAcreedor` Saldo final acreedor ✅ · `period` Periodo ✅ · `rfc` RFC del
  contribuyente ✅ 🔴 **Los saldos son NETOS CON SIGNO** (`trialBalance.service.ts:28-33`, "+ = deudor") y la pantalla los parte con
  `Math.abs` en dos columnas (`TrialBalance.tsx:33`). **El archivo los parte igual.** Un saldo acreedor saliendo como número negativo bajo
  un encabezado "Saldo" se postea al revés.
- **Botón:** `avoqado-web-dashboard/src/pages/Reports/TrialBalance.tsx:50` (encabezado), junto al selector de mes de `:59-62`.

#### J. Catálogo de cuentas

- **Ruta:** `GET .../accounting/chart-of-accounts/export?format=` — inmediatamente después de `accounting.routes.ts:173-179`, **antes** del
  `POST /seed` (`:182`) y del `PATCH /chart-of-accounts/:accountId` (`:200`). Hoy no colisiona (métodos distintos), pero se declara arriba
  para no dejar la trampa armada si mañana alguien agrega un `GET /chart-of-accounts/:accountId`.
- **Servicio:** `getChartOfAccounts()` → `listAccounts()` (`src/services/fiscal/chartOfAccounts.service.ts:156`), `orderBy { code: 'asc' }`
  ya único.
- **Columnas:** `code` Código de cuenta ✅ · `name` Nombre ✅ · `codigoAgrupadorSat` Código agrupador SAT ✅ · `tipo` Tipo ✅ · `naturaleza`
  Naturaleza ✅ · `nivel` Nivel — · `padre` Cuenta padre (código) — · `afectable` Afectable ✅ · `activa` Activa ✅ **Sin columnas de dinero
  → aquí no aplica `pesosFromCents`.**
- **Botón:** `avoqado-web-dashboard/src/pages/Reports/ChartOfAccounts.tsx:70` (encabezado). `baseParams={}`.

---

## 4. LAS TRAMPAS DE ESTE REPO QUE APLICAN, con la línea que las causa

### 4.1 Orden de rutas: la estática ANTES de la dinámica

La única que **ya nos mató** está comentada en el propio código: `src/routes/dashboard/inventory.routes.ts:699-702` (_"declarada después, la
ruta dinámica capturaba 'stats' como si fuera un id… este endpoint era INALCANZABLE"_). Aplica a **cuatro** de las diez:

| Export         | Va ANTES de                                                                              | Verificado |
| -------------- | ---------------------------------------------------------------------------------------- | ---------- |
| C. OC          | `inventory.routes.ts:712` `/purchase-orders/:purchaseOrderId`                            | ✅         |
| D. Proveedores | `inventory.routes.ts:672` `/suppliers/:supplierId/performance`                           | ✅         |
| E. Insumos     | `inventory.routes.ts:145` `/raw-materials/:rawMaterialId` (valida cuid → 400 para todos) | ✅         |
| G. Conteos     | `inventory.routes.ts:1424` `/stock-counts/:countId`                                      | ✅         |

**Sin trampa** (verificado): A (el sub-router de bitácora sólo tiene `/`, `/actions`, `/entities`), B, F (`/movements` no tiene hermana
dinámica), H, I, J. Y el **middleware de autenticación cambia de sitio según el archivo**: en `activityLog.routes.ts` y
`accounting.routes.ts` viene del `router.use` (`dashboard.routes.ts:3511` y `:4151`) → **no repetirlo**; en
`organizationDashboard.routes.ts` va **por ruta** (`:1532`) → **sí declararlo**, o el endpoint queda sin autenticar.

### 4.2 `orderBy` no único = filas perdidas en silencio

Con `take: cap` y muchos timestamps empatados, el corte es no determinista. **Seis de los servicios base tienen este defecto hoy:**

| Servicio                  | Línea                                  | `orderBy` actual           | En el export                  |
| ------------------------- | -------------------------------------- | -------------------------- | ----------------------------- |
| `getPurchaseOrders`       | `purchaseOrder.service.ts:496-498`     | `{ orderDate: 'desc' }`    | `+ { id: 'desc' }`            |
| `getRawMaterials`         | `rawMaterial.service.ts:93`            | `{ name: 'asc' }`          | `+ { id: 'asc' }`             |
| `getGlobalMovements`      | `productInventory.service.ts:238, 261` | `{ createdAt: 'desc' }`    | `+ { id: 'desc' }`            |
| `listExpenses`            | `expense.service.ts:443`               | `{ fechaEmision: 'desc' }` | `+ { id: 'desc' }`            |
| `getStockCounts`          | filtrado en memoria                    | —                          | `orderBy` nuevo con desempate |
| `getAccountsPayableAging` | `accountsPayable.service.ts:122`       | `pendienteCents desc`      | (fuera de H0, §6)             |

**Los dos que YA están bien y se reusan idénticos** son los de bitácora: `activity-log.service.ts:173` y `:279`,
`[{ createdAt: 'desc' }, { id: 'desc' }]`, con el comentario que explica el porqué (verificado: _"prod holds groups of up to 71 across
15,508 rows"_) y con prueba que lo protege (`tests/unit/services/dashboard/activity-log.pagination-stability.test.ts`).

### 4.3 Centavos en el ledger — el 100x que cuadra consigo mismo

Verificado en `prisma/schema.prisma`: `JournalEntry.totalDebitCents/totalCreditCents` son `Int` (`:13097-13098`),
`JournalLine.debitCents/creditCents` son `Int` (`:13116-13117`), y `Expense` tiene 11 campos `…Cents` `Int` (`:13195-13221`). Los servicios
los devuelven **sin convertir, a propósito** (`trialBalance.service.ts:15`, `accountLedger.service.ts:14`). Hoy la división entre 100 vive
**sólo en el render**, con `Currency(x, true)` (`avoqado-web-dashboard/src/utils/currency.tsx:17`).

Si se copia el patrón de pagos literal (`value: r => Number(r.amount) || 0`, `payment.dashboard.controller.ts:370-376`), el XLSX sale en
centavos y **nadie lo nota**: `encodeExport` escribe `col.value(row)` verbatim (`export.helpers.ts:177-191`) y `encodeXlsx` (`:77`) mete el
número tal cual → la celda dice `116000` y el contador postea $116,000 en vez de $1,160.00. Y el archivo **cuadra consigo mismo**, así que
ni la balanza ni la ecuación contable lo delatan.

**Regla:** `pesosFromCents()` va **únicamente** en el `value()` de cada `ExportColumnDef`. Convertirlo en el servicio rompe a la vez las
pantallas, los tools del MCP (`accounting_reports`, `trial_balance`, `journal_entries`, `expenses`, `accounts_payable`) y el XML del SAT. En
el resto del sistema el dinero ya es **pesos 1:1 como Decimal** (`Number(r.amount)`), y así se queda.

### 4.4 Fechas venue-local

Los tres exports vivos emiten `createdAt.toISOString()` (UTC crudo): una venta de las 20:30 del día 6 en México sale fechada el día 7.
**Contraloría abre estos archivos** — la bitácora, el kardex y las compras usan `venueDateTimeCell(fecha, venue.timezone)`. Tres bugs
concretos que hay que corregir **al extraer**, no después:

- `activity-log.service.ts:152-153` (org) usa `new Date(params.startDate)` — la trampa de tz documentada en `critical-warnings.md`; en prod
  (Node UTC) corre el día entero. El de venue ya lo hace bien (`:266-269`, `fromZonedTime` con **string**) y es el modelo a copiar.
- `stockCount.controller.ts:43-49` parsea con `new Date(startDate)` + `setHours(23,59,59,999)` = hora del host.
- **En el consolidado de organización cada renglón se formatea en la tz de SU sucursal**: el mapa de venues de
  `activity-log.service.ts:113-117` hoy trae `{ id, name }` (verificado) — hay que sumarle `timezone`, o un consolidado de sucursales en
  husos distintos miente.

Y la trampa del contrato front↔back: **`ExportDialog` manda siempre `.toISOString()`** (`export-dialog.tsx:111-112`, verificado), mientras
`queryVenueActivityLogs` mete el valor en la plantilla `` `${params.startDate}T00:00:00.000` `` (`activity-log.service.ts:268`). Un ISO
completo produce `'2026-08-07T00:00:00.000ZT00:00:00.000'` = fecha inválida. Lo resuelven la prop `dateParam="ymd"` **y** `toYmd()` en el
controlador (defensa en los dos lados: el backend nunca confía en el cliente).

### 4.5 Aislamiento multi-tenant — tres tablas sin `venueId`

Toda query filtra por `venueId`/`orgId`, sin excepción. **La trampa es que tres de las tablas nuevas no lo tienen como columna** y hay que
ir por la relación:

| Tabla               | Ruta al tenant                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InventoryMovement` | `inventory: { venueId }` (patrón en `productInventory.service.ts:214-223`)                                                                                                      |
| `StockCountItem`    | `stockCount: { venueId }`                                                                                                                                                       |
| `SupplierPricing`   | `supplier: { venueId }` — y `getSupplierPricingHistory` **hoy** consulta `where { rawMaterialId }` a secas (`supplier.service.ts:292-295`), apoyándose en una validación previa |

Y el **alcance contable no es el venue, es el contribuyente**: `resolveScopeOrNull` (`chartOfAccounts.service.ts:130-145`) resuelve el RFC
del venue de la ruta y a partir de ahí todo filtra por `{ organizationId, rfc }`. Para PITS, que es multi-sucursal, **un contralor con
`accounting:read` en UNA sucursal exporta las pólizas y los gastos de TODAS las que comparten ese RFC**. Es correcto fiscalmente y ya es el
comportamiento de las pantallas, pero **un archivo sale del edificio**: por eso `rfc` "RFC del contribuyente" va como columna en H, I y J, y
la UI lo dice.

Un cuarto punto, distinto pero de la misma familia — **el candado y la consulta miran venues diferentes**:
`checkPermission`/`checkFeatureAccess` resuelven con `resolveRequestVenueId` (param `:venueId` → header `x-venue-id` → JWT,
`src/middlewares/checkPermission.middleware.ts:38-46`), pero el controlador de bitácora lee `(req as any).authContext.venueId`
(`src/controllers/dashboard/activityLog.dashboard.controller.ts:6`), que se construye **sólo del JWT**. Con `mergeParams:true` el param
siempre está. **El export usa `resolveRequestVenueId(req, authContext)`** para quedar alineado con su propio candado. El listado vigente
arrastra el mismo defecto → hallazgo aparte.

### 4.6 Tope de filas, y la columna que parece mentir

- **Pre-flight `count` → 413 antes de traer nada a memoria**, con `sendRowCapExceeded`. Cap 10 000 (1 000 en PDF,
  `export.helpers.ts:12-13`). **El count debe contar la misma entidad que el fetch** (órdenes vs renglones, conteos vs líneas).
- **`STAFF_LOGIN`/`STAFF_LOGOUT` es lo que va a reventar el cap.** Es por-persona × por-dispositivo × por-turno. Un export mensual a nivel
  organización de PITS pega contra el 413 casi seguro y en PDF contra cualquier rango útil. **No pude medirlo contra producción**
  (levantamiento de sólo lectura): el "15 508 filas / grupos de hasta 71" es lectura del comentario de `activity-log.service.ts:167-172`, y
  esa medición es **anterior** a que registráramos accesos. Mitigación: casilla "Excluir inicios y cierres de sesión" →
  `excludeActions=STAFF_LOGIN,STAFF_LOGOUT`, **agregada al listado Y al export a la vez** o se rompe "lo que exportas es lo que ves".
- **`ipAddress` sale default OFF, y es una decisión, no un descuido.** Verificado hoy: de las cinco rutas que escriben
  `STAFF_LOGIN`/`STAFF_LOGOUT` (`src/services/dashboard/auth.service.ts:453`, `src/services/dashboard/googleOAuth.service.ts:488`,
  `src/services/mobile/auth.mobile.service.ts:256` y `:621`, `src/services/tpv/auth.tpv.service.ts:180`), **sólo `auth.service.ts` menciona
  `ipAddress` siquiera** — `googleOAuth.service.ts`, `auth.mobile.service.ts` y `auth.tpv.service.ts` no lo referencian en ningún punto del
  archivo. Entregar "Dirección IP" en ON sería entregar una columna vacía en la mayoría de los accesos. Por eso la columna **`origen`**
  (derivada de `data.source` + `data.terminalSerialNumber` + `data.method`) va **ON**: hoy es lo único que responde "¿desde dónde?" en TPV y
  móvil.
- **Nota de rendimiento (no bloqueante):** `ActivityLog` tiene índices **separados** en `venueId` (`prisma/schema.prisma:5742`) y
  `createdAt` (`:5744`), no compuesto. Un export de 10 000 filas con `venueId` + rango + `ORDER BY createdAt DESC` es un escaneo caro. Si en
  pruebas tarda, un `@@index([venueId, createdAt])` lo arregla — pero eso es una **migración** (`npx prisma migrate dev`, nunca `db push`) +
  `npm run schema:map` en el mismo commit. **No lo meto en H0** salvo que se mida el problema.
- **Race count↔fetch:** el pre-flight cuenta y luego el `findMany` trae; si entran filas en medio, `take: cap` trunca en silencio. Es el
  comportamiento de los tres caminos vivos y se hereda a conciencia (el 413 protege el caso grande, no éste).

### 4.7 Cuatro trampas del helper que hay que respetar tal cual

1. `parseFormatParam` **nunca falla**: `?format=json` devuelve `'csv'` (`export.helpers.ts:226-229`). No esperes 400.
2. Un id de columna desconocido **se ignora en silencio** (`pickColumns`, `:46-49`); si TODOS son inválidos, `encodeExport` **lanza**
   (`:182`) → `next(error)` → **500 genérico**. Por eso los ids del front y del back se escriben juntos, en el mismo commit.
3. El **CSV lleva BOM UTF-8** (`:68`) o Excel destroza los acentos. Nadie lo "optimiza" fuera.
4. El **PDF no hace wrap, trunca con `…`** y con >8 columnas baja a 7pt. `dataJson`, `userAgent` y `notes` **nunca** tienen sentido en PDF.
   Y en el cliente: con `responseType:'blob'` **el cuerpo de error también llega como Blob** — el desempaque de `export-dialog.tsx:144-151`
   es obligatorio o el mensaje del 413 se pierde. Ya está resuelto en el componente que reusamos: **por eso no forkeamos.**

---

## 5. CÓMO SE PRUEBA CADA UNA

### 5.0 Primero, el helper (una vez, protege las diez)

`tests/unit/services/dashboard/export.helpers.test.ts` — **hoy no existe ninguna prueba que importe `encodeExport`** (verificado). Fija:

- CSV empieza con BOM UTF-8; escapado RFC-4180 (comas, comillas dobles, saltos de línea); separador `\r\n`.
- `pickColumns` preserva el orden de `allColumns`, no el de `requestedColumnIds`; ids desconocidos se ignoran; **0 columnas válidas lanza**.
- `getRowCapForFormat('pdf') === 1000`, el resto `10000`.
- `parseColumnsParam` deduplica y limpia; `parseFormatParam` cae a `'csv'` con basura.
- **`pesosFromCents`**: `116000 → 1160`, `null → 0`, `-1 → -0.01`, y **nunca** `Math.round(x*100)`.
- **`venueDateTimeCell`**: el mismo `Date` UTC formateado en `America/Mexico_City` da el día anterior a las 20:30 — y la prueba corre con
  **`TZ=UTC npx jest …`**, que es como corre prod.
- `toYmd('2026-08-07T00:00:00.000Z') === '2026-08-07'`.

### 5.1 Por CADA exportación, tres pruebas obligatorias

**(1) Aislamiento multi-tenant** — sin excepción, una por export.

> _Dos venues (o dos organizaciones / dos RFC) con datos; se pide el export del venue A; el archivo NO contiene ni un identificador del
> venue B, y el `count` del pre-flight tampoco lo cuenta._ Se escribe contra el `build…WhereClause` extraído (unitaria con `prismaMock`,
> asertando el `where` que llega a Prisma) **y** con una api-test que decodifica el CSV. Especial atención a las tres tablas sin `venueId`
> (§4.5): en `InventoryMovement`, `StockCountItem` y `SupplierPricing` la prueba debe fallar si alguien quita el anidado por relación. En
> contabilidad la prueba es por **RFC**, no por venue: dos venues del mismo RFC **sí** comparten datos (comportamiento correcto que hay que
> congelar para que nadie lo "arregle"), dos RFC distintos no.

**(2) El export respeta los filtros vigentes de la pantalla** — sin excepción, una por export.

> _Dado el mismo conjunto de query params que manda el listado, `countXForExport` y `fetchXForExport` devuelven exactamente el mismo
> universo que `getX` (mismo conteo, mismos ids)._ Es la prueba que impide el defecto que pagos y órdenes ya tienen en producción (el
> listado fusiona QR legacy de MindForm y el export no; el listado ordena por `updatedAt` y el export por `createdAt`). Se implementa como
> **prueba de equivalencia contra el `build…WhereClause` compartido**, no comparando resultados a mano: si alguien deja una copia inline en
> el listado, la prueba lo caza. Casos concretos que fija cada una: A/B `action`+`staffId`+`search`+rango; C
> `status[]`+`supplierIds[]`+`totalMin/Max`+`soloConDiferencia`; D `search`+`active`; E `category`+`lowStock`+`active`; F
> `type`+rango+`search`; G `status`+`type`+rango; H `period`+`paymentStatus`+`proveedorRfc`.

**(3) Estabilidad del corte (`orderBy` único)**

> _N filas con `createdAt`/`orderDate`/`name` byte-idéntico y `cap` menor que N: dos ejecuciones devuelven el MISMO subconjunto, y el
> subconjunto es el mismo que devuelve el listado paginado._ Modelo a copiar:
> `tests/unit/services/dashboard/activity-log.pagination-stability.test.ts`, que ya existe y **no se debe romper**.

### 5.2 Pruebas específicas que no se pueden omitir

| Export  | Prueba adicional                                                                                                                                          | Por qué                                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A, B    | **Redacción de PII**: un `data` con `{ password, token, clabe, cardNumber }` sale como `••• redacted` **en `resumen` y en `dataJson`**, y anidado también | Un archivo no pasa por la UI. Hoy la redacción es sólo de cliente (`VenueActivityLog.tsx:44-56`) y la pantalla de org ni eso (`OrganizationActivityLog.tsx:364`) |
| A, B    | `createdAt` formateado en la tz **de cada sucursal**, corriendo con `TZ=UTC`                                                                              | Un consolidado en husos distintos miente                                                                                                                         |
| A, B    | Se escribe `ACTIVITY_LOG_EXPORTED` una vez, **después** del 413 y **nunca** dentro de una transacción                                                     | La descarga masiva es el evento auditable                                                                                                                        |
| B       | La ruta responde **403 sin `activity:read`** aunque el usuario pertenezca a la organización                                                               | Es el candado que el listado no tiene                                                                                                                            |
| C       | Con `granularity=item`, el pre-flight cuenta **renglones**; y el archivo de renglones **no** trae `taxAmount`/`commission`/`total` de la orden            | Cap inútil + doble conteo al pivotear                                                                                                                            |
| F       | Un movimiento cuyo `Inventory` es de otro venue **no** aparece                                                                                            | `InventoryMovement` no tiene `venueId`                                                                                                                           |
| H, I, J | **Centavos**: una `JournalLine` con `debitCents = 116000` produce la celda `1160` (no `116000`, no `"1,160.00"`)                                          | El 100x que cuadra consigo mismo                                                                                                                                 |
| I       | Un saldo neto negativo cae en **"Saldo acreedor"** con valor positivo, no en "Saldo deudor" en negativo                                                   | Se postea al revés                                                                                                                                               |
| Todas   | **413** cuando `total > cap`, con `message` en español y `success:false`; y **PDF con cap 1 000**                                                         | Contrato que el diálogo ya consume (`export-dialog.tsx:155-160`)                                                                                                 |

**Dónde van:** unitarias en `tests/unit/services/dashboard/…` y `tests/unit/services/fiscal/…`; las de contrato HTTP (413, 403,
`Content-Type`, `Content-Disposition`) en `tests/api-tests/dashboard/…`, con `tests/api-tests/dashboard/salesSummaryExport.api.test.ts` (294
líneas, 7 casos) como plantilla. Nota de `prismaMock`: `tests/__helpers__/setup.ts` lista los modelos a mano — si el export toca un
`prisma.<modelo>` que no está registrado, truena hasta agregarlo. **Cierre:** `npm run pre-deploy` verde + `npm run audit:permissions` en 0
(no agregamos permisos, pero el audit valida que no dejamos gates fantasma) + `/full-testing` sobre al menos A, C y H, porque compilar y
pasar unitarias no prueba que el archivo se descargue y se abra en Excel.

---

## 6. QUÉ **NO** SE HACE EN H0.3 (y a dónde se mueve)

**Fuera porque el archivo abriría bien y MENTIRÍA** — esto es lo más importante de esta sección:

1. **Export de lotes / caducidad.** `StockBatch` sólo tiene `rawMaterialId`, **no tiene `productId`**: la mercancía de reventa no puede
   tener lote ni caducidad hoy. El export devolvería **0 filas en las 18 tiendas de PITS**. Además no existe pantalla de lotes
   (`grep -rln "batches" src/pages/` → 0 resultados) ni listado por venue. → **Ya está contestado como DESARROLLO en las filas 80 y 250 de
   la matriz. Se queda ahí.** No lo convirtamos en un renglón "natural" a medias.
2. **Export de valorización de inventario.** `getInventoryValuation` (`src/services/dashboard/report.service.ts:427-513`) consulta
   **únicamente** `prisma.rawMaterial.findMany` (`:434`) y no toca `Inventory`/`Product`: una tienda de conveniencia valuaría ~$0.
   Extenderlo a `Product` es trabajo de reporte, no de exportación. → **H1**, junto con el reporte corregido.
3. **Existencias de mercancía de reventa (`ProductStock`).** No hay servicio: la pantalla recicla el catálogo completo (`getProducts`,
   `product.dashboard.service.ts:389-449`) y el filtro que define "esto es una existencia" corre **en el navegador**
   (`ProductStock.tsx:117-121`). Exportar exige escribir el servidor primero y migrar la pantalla, o el archivo y la pantalla divergen desde
   el día 1. → **H1**, con el servicio propio. (Es un hueco grande para PITS: **decirlo en la reunión, no descubrirlo en la verificación.**)

**Fuera porque es otra tarea del mismo hito:** 4. **Estado de resultados y balance general (filas 142, 143, 155).** → **H0.4**, que ya
existe en la lista y ya incluye el botón de pólizas XML. H0.3 le deja listo `pesosFromCents`, `dateParam:'none'` y el patrón de reusar
`getAccountingReports()` completo + aplanar. **Ojo con los dos renglones sintéticos `~RETAINED`/`~RESULT`**
(`accountingReports.service.ts:183,185`), que la pantalla oculta (`AccountingReports.tsx:47`): en el archivo la celda de código va
**vacía**, o parecen cuentas del catálogo que no existen en el catálogo del contador.

**Fuera porque no es exportación, es desarrollo:** 5. **Estado de flujo de efectivo (fila 145).** **No existe el reporte.** Lo único
parecido es `/accounting/vat-flow` (`accounting.routes.ts:382`), que es IVA sobre base de flujo (LIVA 1-B), otra cosa. Ese renglón **no se
cierra con este punto** → tarea propia, **H1/H3**, y hay que decirlo en la matriz. 6. **Reporte de recepciones (fila 75).** No hay servicio,
ni ruta, ni pantalla; la evidencia está dispersa entre `PurchaseOrder.receivedDate/receivedBy`,
`PurchaseOrderItem.quantityReceived/receiveStatus`, `StockBatch` e `InventoryMovement`. Y **`StockBatch` no tiene columna de quién
recibió**, así que "usuario" sólo sale de los movimientos o del nivel orden. Construir la pantalla + el servicio es un punto propio. →
**H1**. El export de OC con `granularity=item` + `receiveStatus` + `soloConDiferencia` **cubre parcialmente** las filas 77/79 mientras
tanto, y así hay que decirlo. 7. **Auxiliar por cuenta.** El endpoint existe (`accounting.routes.ts:364`) pero **no hay pantalla**: cero
referencias a `account-ledger`/`accountLedger` en el dashboard. Exportar algo que nadie puede ver es peor que no exportarlo. → **H1**, junto
con el drill-down desde la balanza. 8. **Cuentas por pagar.** Sí es barato, pero su `sort` (`accountsPayable.service.ts:122`) no es único y
nadie lo pidió por nombre. → primer candidato a entrar si sobra tiempo; si no, H1.

**Fuera porque es deuda técnica, no entregable:** 9. **Refactor D3** (hacer que `getPaymentsData`/`getOrders` usen su `build…WhereClause`),
**D5** (`useBlobExport`), **D6** (fusionar `SalesSummaryExportDialog` con `ExportDialog`), **D7** (`export.cells.ts` completo). Justificado
en §1.1. 10. **Índice compuesto `@@index([venueId, createdAt])` en ActivityLog.** Es una migración; sólo si se mide el problema. 11. **Hilar
`ipAddress`/`userAgent` en las 5 rutas de acceso que no lo mandan** (SSO, móvil passkey, móvil contraseña, login TPV, logout TPV). Es barato
en el server, pero toca los caminos de autenticación de móvil y TPV, que otras sesiones están tocando en paralelo. → **tarea propia**, y
mientras tanto la columna "Dirección IP" sale default OFF (§4.6). 12. **Tools nuevos del MCP.** La lectura ya está cubierta
(`get_activity_log`, `expenses`, `journal_entries`, `trial_balance`, `chart_of_accounts`, `list_purchase_orders`, `list_suppliers`,
`stock_counts`, `get_inventory_movements`, `stock_value`) y una exportación es **comodidad de UI, no una capacidad nueva**. Decisión
explícita, no omisión. _(Aparte: `src/mcp/tools/activity-log.ts:60` ordena sólo por `createdAt`, sin el desempate — hallazgo menor a
reportar.)_ 13. **`ActivityLog` de los exports que no son de bitácora.** Sólo `logger.info` con `{ venueId, total, format, granularity }`.
La regla del repo obliga a auditar **mutaciones**, no lecturas, y siete renglones por descarga en compras/inventario/contabilidad sería
ruido. **La excepción son A y B**, donde la descarga lleva PII e IPs y donde PITS nos compró literalmente "bitácora de operaciones por
usuario". Decisión tomada, no heredada.

**Si el tiempo aprieta, el corte va en este orden (de abajo hacia arriba):** J (catálogo de cuentas) → D (proveedores) → I (balanza) → G
(conteos) → H (gastos). **A, B, C, E y F no se cortan**: son los que la matriz pide por nombre.

---

## 7. EL RENGLÓN HONESTO PARA LA MATRIZ

Esto es lo que se le puede decir a la consultora, palabra por palabra, y que resiste que abra el sistema y lo verifique.

> **Lo que queda exportable después de H0.3** (XLS, CSV y PDF, desde la propia pantalla, respetando los filtros que el usuario tiene
> aplicados, con selección de columnas y tope de 10 000 filas por descarga —1 000 en PDF— con aviso explícito cuando el rango se pasa):
>
> - **Bitácora de operaciones por usuario**, en sus dos alcances: **por sucursal** y **consolidada por organización**, con fecha y hora en
>   la zona horaria de cada sucursal, usuario, correo, acción, entidad, origen (dashboard / terminal / móvil) y detalle de la operación.
>   Filtrable por sucursal, fecha, usuario y tipo de operación, y **la descarga misma queda registrada en la bitácora**. _(Filas 35 y 28.)_
> - **Compras**: órdenes de compra a nivel **orden** (para gasto del periodo) y a nivel **renglón** (para cotejo contra factura), con
>   proveedor, RFC, estatus, autorizaciones, cantidades pedidas vs. recibidas y **diferencias**. Y el **padrón de proveedores**. _(Filas 58,
>   59, 196; y parcialmente 77 y 79.)_
> - **Inventario**: **existencias de insumos** con costo y valorización PEPS, **historial completo de movimientos** (entradas, salidas,
>   traspasos, ajustes y mermas, con motivo y usuario responsable) y **conteos físicos con sus diferencias línea por línea**. _(Filas 85,
>   93, 95, 196.)_
> - **Contabilidad**: **buzón de gastos / CFDIs recibidos**, **balanza de comprobación** y **catálogo de cuentas**, con importes en pesos.
>   _(Filas 158 y 196.)_
>
> **Lo que NO queda exportable después de H0.3, y por qué:**
>
> - **Estado de resultados y balance general** — se entregan en el punto inmediato siguiente del mismo hito (H0.4), junto con la
>   contabilidad electrónica en XML. _(Filas 142, 143, 155.)_
> - **Estado de flujo de efectivo** — **el reporte no existe todavía**; no es un tema de exportación sino de desarrollo del reporte. Hay que
>   reclasificar ese renglón o comprometer fecha. _(Fila 145.)_
> - **Valorización económica del inventario** y **control de lote y caducidad** — hoy sólo cubren insumos de cocina y cafetería, **no la
>   mercancía de reventa** de las 18 tiendas. Lote/caducidad para reventa **ya está contestado como Desarrollo** (filas 80 y 250); la
>   valorización sobre mercancía de reventa hay que agregarla al mismo compromiso, o el archivo diría que las tiendas valen cero. _(Fila
>   94.)_
> - **Existencias de mercancía de reventa como listado exportable de servidor** — se ve en pantalla, pero el filtrado ocurre en el
>   navegador; el export honesto exige el servicio de servidor primero. _(Fila 85, parcial: insumos sí, reventa H1.)_
> - **Reporte detallado de recepciones** con filtros por fecha, tienda, proveedor, OC y usuario — **la pantalla no existe**. Lo que sí se
>   entrega hoy es el archivo de **renglones de orden de compra con cantidades recibidas y diferencias**, que cubre el "qué" pero no el
>   "cuándo se recibió y quién lo recibió" a nivel renglón. _(Fila 75: parcial, hay que decirlo así.)_
> - **Auxiliar por cuenta (libro mayor)** — el endpoint existe pero no hay pantalla; se entrega con el drill-down desde la balanza.
> - **Columna "Dirección IP" en la bitácora** — se entrega, pero **apagada por defecto**: sólo dos de las siete rutas de acceso la registran
>   hoy. El "desde dónde" se responde con la columna **Origen** (dashboard / terminal + serie / móvil). Completar la IP en las cinco rutas
>   restantes es una tarea aparte y barata.
>
> **Condición de plan (hay que cerrarla antes de la demo):** las exportaciones de inventario y compras viven detrás del módulo
> `INVENTORY_TRACKING`, la bitácora por sucursal detrás de `VENUE_AUDIT_LOG` (PRO) y las de contabilidad detrás de `CFDI`. Si la suscripción
> de PITS no los incluye, el sistema responderá "tu plan no lo incluye" — que en una verificación se lee igual de mal que "no existe".

---

### Nota final sobre verificación

Todo lo citado con `archivo:línea` en este plan lo leí en el código de hoy. **Lo que NO pude verificar y por tanto no afirmo:** (a) no
ejecuté ninguna exportación real ni generé un archivo — el comportamiento del PDF con muchas columnas y del XLSX con textos largos se deduce
del código de PDFKit/XLSX; (b) no consulté la base de producción, así que ni el volumen real de `ActivityLog` hoy (el 15 508 es lectura de
un comentario en código, anterior al registro de accesos) ni los features/módulos que tiene hoy el venue de PITS están verificados por mí;
(c) no verifiqué en runtime qué hace Prisma con `{ type: 'WASTE' }` en el filtro del kardex; (d) el tier PRO de `VENUE_AUDIT_LOG` lo tomo de
la especificación recibida, no lo confirmé en la tabla `Feature`.

---

# Anexo A — El patrón de exportación existente, documentado

> Cómo funciona hoy, de punta a punta, lo que YA exporta. Es la receta que los diez endpoints nuevos deben copiar en vez de inventar diez
> formas distintas.

# Patrón de exportación vivo en Avoqado — levantamiento completo (solo lectura, no modifiqué nada)

---

## 0. Resumen de una línea

Hay **un helper genérico completo y bien hecho** (`export.helpers.ts`) y **un componente de diálogo reutilizable** (`export-dialog.tsx`),
pero el "pegamento" entre los dos — parseo de filtros, pre-flight count, mensaje 413, registry de columnas — **está copiado a mano tres
veces**. El helper es la parte reutilizable; el controlador NO lo es.

---

## 1. CAMINO A — Pagos

### 1.1 Ruta

`/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/routes/dashboard.routes.ts:3136-3142`

```ts
// Export route — must be declared BEFORE the `:paymentId` routes so Express matches it first.
router.get(
  '/venues/:venueId/payments/export',
  authenticateTokenMiddleware,
  checkPermission('payments:read'),
  paymentController.exportPaymentsData,
)
```

- **Middlewares:** `authenticateTokenMiddleware` → `checkPermission('payments:read')`. Nada más: sin `validateRequest` (no hay Zod en este
  endpoint), sin `checkFeatureAccess`, sin gate de módulo.
- **Permiso:** `payments:read`, mismo que el listado (`:3134`). Existe en `src/lib/permissions.ts:108`. **No se creó un permiso
  `payments:export` nuevo** — la decisión vigente es: _quien puede ver la lista puede exportarla_.
- **Orden de rutas:** la ruta `/export` está **antes** de las `:paymentId`, y el comentario en el código lo dice explícitamente. Esta es
  exactamente la trampa de `/purchase-orders/stats` que mencionas.
- URL montada completa: `GET /api/v1/dashboard/venues/:venueId/payments/export`.

### 1.2 Controlador

`/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/controllers/dashboard/payment.dashboard.controller.ts:275-393`

**Cómo lee formato y columnas** (`:297-299`):

```ts
const format = parseFormatParam(req.query.format) // csv | xlsx | pdf, default csv
const requestedColumnIds = parseColumnsParam(req.query.columns) // "a,b,c" -> ['a','b','c'] dedup
const cap = getRowCapForFormat(format) // 10_000 | 1_000 (pdf)
```

**Cómo lee filtros** (`:301-318`): declara **su propio `parseList` local** (idéntico al de `getPaymentsData` en `:53-60` del mismo archivo)
y arma un `PaymentFilters`. Ojo: el export **omite a propósito** los filtros legacy de valor único (`merchantAccountId`, `method`, `source`,
`staffId`) que sí acepta el listado.

**El `venueId` sale de `req.params`** (`:296`), no de `authContext` — el aislamiento multi-tenant lo garantiza `checkPermission`, que
resuelve el venue con `resolveRequestVenueId` (`src/middlewares/checkPermission.middleware.ts:38-44`: param → header `x-venue-id` → JWT) y
valida el rol contra `StaffVenue` en ESE venue.

### 1.3 ¿Reúsa el servicio de la pantalla?

**NO. Duplica la query.** Hay tres funciones separadas en `src/services/dashboard/payment.dashboard.service.ts`:

| Función                    | Línea  | Qué hace                                                                         |
| -------------------------- | ------ | -------------------------------------------------------------------------------- |
| `getPaymentsData`          | `:32`  | La pantalla. Construye el `where` **inline** (`:47-114`).                        |
| `buildPaymentsWhereClause` | `:272` | Copia literal del mismo `where`, en función aparte.                              |
| `countPaymentsForExport`   | `:330` | `prisma.payment.count({ where: buildPaymentsWhereClause(...) })`                 |
| `fetchPaymentsForExport`   | `:338` | `findMany` con include reducido, `orderBy: { createdAt: 'desc' }`, `take: limit` |

El docstring de `buildPaymentsWhereClause` (`:268-271`) dice _"extracted so the export endpoint can apply the same filters without
duplicating logic"_ — pero **no se extrajo**: `getPaymentsData` sigue con su copia inline. Son dos bloques gemelos de ~70 líneas que hay que
mantener en paralelo. **Ya divergen:** el listado tiene una rama especial para MindForm que fusiona pagos QR legacy (`:129-211`); el export
**no la tiene**, así que para el venue MindForm el CSV omite silenciosamente los pagos QR legacy que sí ves en pantalla.

### 1.4 Tope de filas

Patrón **pre-flight count → 413**, `:320-331`:

```ts
const total = await paymentDashboardService.countPaymentsForExport(venueId, filters)
if (total > cap) {
  res.status(413).json({
    success: false,
    message:
      format === 'pdf'
        ? `El rango contiene ${total.toLocaleString()} filas. PDF está limitado a ${cap.toLocaleString()}. Usa CSV o Excel, o reduce el rango con filtros.`
        : `El rango contiene ${total.toLocaleString()} filas. El máximo por export es ${cap.toLocaleString()}. Reduce el rango con filtros.`,
  })
  return
}
```

Cuenta **antes** de traer filas a memoria; nunca trunca en silencio. El mensaje va en español y en `message` (el front lo lee de ahí).

### 1.5 `ExportColumnDef` y etiquetas

`:337-378` — 13 columnas. **Las etiquetas están EN DURO y en español en el backend**, sin i18n: `'Fecha'`, `'ID'`, `'Mesero'`,
`'Cuenta Comercial'`, `'Método'`, `'Origen'`, `'Internacional'`, `'Marca'`, `'Últimos 4'`, `'Subtotal'`, `'Propina'`, `'Total'`,
`'Estatus'`.

El dashboard tiene su propio set de etiquetas traducidas para el picker (`t('columns.date')` etc.), así que **el usuario elige "Date" en
inglés y el CSV le sale con encabezado "Fecha"**. Es una divergencia consciente-o-no, pero es el comportamiento actual de los tres caminos.

Fallback de columnas (`:382`): si el cliente no manda `columns`, se exportan **todas**:

```ts
requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id)
```

### 1.6 Nombre del archivo

`sendExport(res, encoded, 'payments')` (`:388`). El helper le pega la fecha y la extensión: `payments-2026-08-07.csv`.

### 1.7 Fechas y dinero en las celdas

- **Fechas:** `r.createdAt?.toISOString() ?? ''` (`:338`) → **UTC crudo, ISO-8601**, no venue-local, no formateado. Esta es la desviación
  más grande respecto a la regla del repo.
- **Dinero:** `Number(r.amount) || 0` (`:370-376`) → **pesos 1:1** como número JS plano, sin símbolo, sin separador de miles. Correcto en
  unidad, pero se pierde la precisión Decimal al pasar por `Number()` (irrelevante a 2 decimales, pero es el patrón). El total se calcula en
  el propio `value()`: `(Number(r.amount)||0) + (Number(r.tipAmount)||0)`.
- **`Últimos 4`** se deriva del `maskedPan` con `.slice(-4)` (`:362-369`).

---

## 2. CAMINO B — Órdenes

### 2.1 Ruta

`/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/routes/dashboard.routes.ts:3175`

```ts
router.get('/venues/:venueId/orders/export', authenticateTokenMiddleware, checkPermission('orders:read'), orderController.exportOrdersData)
```

Mismos middlewares; permiso `orders:read` (existe, `src/lib/permissions.ts:50`). Declarada en `:3175`, **antes** de
`/venues/:venueId/orders/:orderId` en `:3178`.

### 2.2 Controlador

`/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/controllers/dashboard/order.dashboard.controller.ts:121-219`

Estructura **carbón-copia** del de pagos: mismo bloque `parseFormatParam`/`parseColumnsParam`/`getRowCapForFormat` (`:143-145`), su
**tercera copia local** de `parseList` (`:147-154`), armado de `OrderFilters` (`:156-164`).

### 2.3 Servicio

`/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/dashboard/order.dashboard.service.ts`:

- `getOrders` (`:44`) — pantalla, `where` inline (`:53-107`), `orderBy: { updatedAt: 'desc' }` (`:134`)
- `buildOrdersWhereClause` (`:157`) — copia del mismo `where`, mismo docstring "sin duplicar lógica", misma duplicación real
- `countOrdersForExport` (`:200`)
- `fetchOrdersForExport` (`:207`) — `orderBy: { createdAt: 'desc' }` (`:216`), `take: limit`

**Divergencia real de orden:** la pantalla ordena por `updatedAt desc`, el export por `createdAt desc`. El archivo no sale en el mismo orden
que la tabla que el usuario está viendo.

### 2.4 Tope

`:166-176` — mismo pre-flight + 413, pero el mensaje dice **"órdenes"** en vez de "filas". Es la única diferencia respecto al de pagos: el
texto está reescrito a mano.

### 2.5 Columnas

`:181-204` — 11 columnas, etiquetas en duro en español: `'Fecha'`, `'ID'`, `'Folio'`, `'Tipo'`, `'Cliente'`, `'Mesa'`, `'Mesero'`,
`'Estatus'`, `'Productos'`, `'Propina'`, `'Total'`.

Detalles que valen:

- `customerName` (`:186-190`) lee `(r as any).customerName` — es el escalar `Order.customerName` (existe en `prisma/schema.prisma`, dentro
  de `model Order`, junto a `customerPhone`/`customerEmail`), no la relación `orderCustomers`. Como `fetchOrdersForExport` usa `include` (no
  `select`), todos los escalares vienen. Pero la **búsqueda** del listado sí filtra por `orderCustomers.customer.firstName` (`:179-191`), o
  sea que buscas por un cliente relacional y exportas una columna que lee otro campo.
- `waiterName` (`:192-199`) hace fallback `servedBy || createdBy`.
- `productsCount` sale de `_count.items` (`:201`).

### 2.6 Archivo, fechas, dinero

`sendExport(res, encoded, 'orders')` (`:214`) → `orders-2026-08-07.xlsx`. Fechas en `toISOString()` (UTC), dinero `Number(...)` pesos 1:1.
Idéntico a pagos.

---

## 3. CAMINO C — Resumen de ventas (el más elaborado)

### 3.1 Rutas

`/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/routes/dashboard/reports.routes.ts:110-111`

```ts
router.get('/sales-summary/export', checkPermission('reports:read'), clampSalesSummaryRangeToToday, salesSummaryExport)
router.get('/venues/:venueId/sales-summary/export', checkPermission('reports:read'), clampSalesSummaryRangeToToday, salesSummaryExport)
```

- **`authenticateTokenMiddleware` está en el `router.use`**, no en cada ruta: `src/routes/dashboard.routes.ts:4268` →
  `router.use('/reports', authenticateTokenMiddleware, reportsRoutes)`. Un módulo nuevo que monte su router aparte **debe** replicar esto o
  el endpoint queda abierto/roto.
- **Dos variantes de ruta a propósito**: sin `:venueId` (venue del header/JWT) y con `:venueId`. El dashboard usa la segunda
  (`SalesSummaryExportDialog.tsx:93-96`).
- **Un middleware de tier extra**: `clampSalesSummaryRangeToToday` (`reports.routes.ts:42-73`) — si el venue NO tiene `ADVANCED_REPORTS`,
  sólo puede pedir "hoy" en la tz del venue; cualquier otro rango → 403 con `code: 'PLAN_LIMIT_RANGE'` (`:64-70`). Este middleware corre
  **después** de `checkPermission` y **antes** del controlador.

### 3.2 Controlador — dos modos en una función

`/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/controllers/dashboard/sales-summary.dashboard.controller.ts:177-366`

Resuelve venue con `resolveRequestVenueId(req, req.authContext!)` (`:179`) — **no** `req.params.venueId` a pelo, porque la ruta existe con y
sin param.

Validación **a mano, sin Zod** (`:186-199`): `startDate`/`endDate` requeridos, whitelist de `paymentMethod` y `cardType`, y regla de negocio
QR_LEGACY sólo-MindForm. Los mensajes de estas validaciones están **en inglés** (`'startDate is required (ISO date string)'`) —
inconsistente con la regla de Zod-en-español, pero es lo que hay.

#### Modo `detailed` (`:214-305`) — PREMIUM

1. Rechaza `QR_LEGACY` con 400 antes de armar filtros (`:221-225`) — porque `buildPaymentWhereFilter` **lanza** con QR_LEGACY
   (`sales-summary.dashboard.service.ts:265`) y sería un 500.
2. **Gate de feature** (`:227-239`): `SUPERADMIN` o `venueHasFeatureAccess(venueId, 'TRANSACTION_EXPORT')`. Si no: 403 con el **contrato
   verbatim del middleware de features** (`error`, `message`, `featureCode`, `subscriptionRequired`) — el comentario dice explícitamente que
   NO se inventó un `code` nuevo. **Cópialo tal cual.**
3. Pre-flight `countSalesSummaryDetailRows` → 413 (`:251-261`), mensaje dice **"transacciones"**.
4. 13 columnas (`:267-293`), etiquetas en duro en español.
5. `sendExport(res, encoded, 'ventas-detalladas')` (`:303`), título `'Ventas detalladas'`.

Servicio: `sales-summary.dashboard.service.ts:1399-1440`. Aquí **sí** hay un `buildSalesSummaryDetailWhere` compartido de verdad entre count
y fetch (`:1399`), y reúsa `buildPaymentWhereFilter` (`:254`) que **también usa el reporte en pantalla** (`:752`). Es el único de los tres
donde la lógica de filtro sí es compartida con la pantalla.

#### Modo `summary` (default, `:307-361`) — no hay filas, hay secciones

- En vez de `columns` usa **`sections`** (`:312-316`), validadas contra la whitelist
  `['totals','paymentMethods','cardTypes','merchantAccounts','byPeriod']`, default `['totals','paymentMethods']`. Se parsean con el mismo
  `parseColumnsParam` (el helper es agnóstico del nombre del param).
- **Segundo gate de tier, silencioso** (`:318-328`): la sección `merchantAccounts` sólo se pide si SUPERADMIN o `ADVANCED_REPORTS`. Si no,
  se cae el flag y el flatten no produce esas filas — **sin 403**, aditivo. El comentario advierte: _"NEVER pass it unconditionally — that
  leaks PRO-tier per-merchant reconciliation data"_.
- **Reúsa `getSalesSummary` completo** (`:341`) — el mismísimo servicio de la pantalla — y luego aplana el resultado con
  `flattenSalesSummaryForExport` (`:343`). Este es el patrón correcto: **los números del archivo no pueden diferir de los de la pantalla
  porque son el mismo cálculo.**
- **Sin cap ni 413**: las filas son un puñado de agregados; no hay `count` previo.
- Columnas fijas, siempre las 5, ignora `?columns=` (`:346-356`): `Sección`, `Concepto`, `Cantidad`, `Monto`, `Porcentaje`.
- `sendExport(res, encoded, 'resumen-ventas')`.

`flattenSalesSummaryForExport` (`sales-summary.dashboard.service.ts:1319-1396`) es donde vive el formato de negocio: redondeo a 2 decimales
(`round2x`, `:1312`), **signo negativo explícito** para descuentos / reembolsos / comisiones (`:1336`, `:1337`, `:1341`), y `null`
preservado como `null` (el CSV lo pinta `''`) cuando el filtro por método de pago invalida las métricas derivadas de órdenes.

### 3.3 Fechas y dinero

- Detallado: `createdAt.toISOString()` (UTC) igual que los otros dos.
- **La tz del venue sí se usa**, pero sólo en modo summary y sólo para las etiquetas de periodo y el arg de `getSalesSummary` (`:310`,
  `:335`): `venue?.timezone || 'America/Mexico_City'`.
- El `where` de detallado usa `new Date(filters.startDate)` (`:1404`) — el dashboard manda ISO completo con hora (`.toISOString()`), no
  `YYYY-MM-DD` pelón, así que no cae en la trampa de tz del repo; **pero si un cliente nuevo mandara `?startDate=2026-08-01` sí caería**.

---

## 4. `export.helpers.ts` — firmas exactas

`/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/dashboard/export.helpers.ts` (230 líneas, sin dependencias del
dominio)

### Constantes

```ts
export const EXPORT_ROW_CAP = 10_000 // :12
export const EXPORT_PDF_ROW_CAP = 1_000 // :13
```

### Tipos

```ts
export type ExportFormat = 'csv' | 'xlsx' | 'pdf' // :15

export interface ExportColumnDef<TRow> {
  // :17
  id: string // debe coincidir con lo que manda el front en ?columns=
  label: string // encabezado (en duro, español)
  value: (row: TRow) => string | number | null | undefined
}

export interface EncodeExportOptions<TRow> {
  // :26
  allColumns: ExportColumnDef<TRow>[] // define el ORDEN de salida
  requestedColumnIds: string[] // subconjunto; el orden lo manda allColumns, no éste
  rows: TRow[]
  title: string // título del PDF / nombre de hoja XLSX
}

export interface EncodedExport {
  buffer: Buffer
  contentType: string
  extension: 'csv' | 'xlsx' | 'pdf'
} // :37
```

### Funciones exportadas (4)

```ts
export async function encodeExport<TRow>(
  format: ExportFormat,
  { allColumns, requestedColumnIds, rows, title }: EncodeExportOptions<TRow>,
): Promise<EncodedExport> // :177
```

Filtra columnas con `pickColumns` (`:46`, preserva orden de `allColumns`, **ids desconocidos se ignoran en silencio**), y **lanza
`Error('No valid columns requested for export')` si quedan 0 columnas** (`:182-184`). Ese error sale por `next(error)` como 500 genérico —
el front sí valida antes, pero un cliente que mande `?columns=basura` obtiene un 500.

```ts
export function sendExport(res: Response, encoded: EncodedExport, filenameStem: string): void // :193
```

```ts
const stamp = new Date().toISOString().slice(0, 10) // YYYY-MM-DD, UTC del servidor
const filename = `${filenameStem}-${stamp}.${encoded.extension}`
res.setHeader('Content-Type', encoded.contentType)
res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
res.setHeader('Content-Length', encoded.buffer.length.toString())
res.status(200).send(encoded.buffer)
```

```ts
export function getRowCapForFormat(format: ExportFormat): number // :205
// pdf -> 1000, resto -> 10000
```

```ts
export function parseColumnsParam(raw: unknown): string[] // :212
// "a, b, ,a" -> ['a','b'] (trim, drop vacíos, dedup por Set). No-string -> []
```

```ts
export function parseFormatParam(raw: unknown): ExportFormat // :226
// 'xlsx'|'pdf'|'csv' -> tal cual; CUALQUIER otra cosa -> 'csv' (nunca 400)
```

### Encoders internos (no exportados)

- `encodeCsv` (`:64`) — RFC 4180 vía `csvField` (`:55`), separador `\r\n`, y **BOM UTF-8** (`:68`) porque sin él Excel destroza los acentos.
  `contentType: 'text/csv; charset=utf-8'`.
- `encodeXlsx` (`:77`) — `XLSX.utils.aoa_to_sheet`, autoajuste de ancho mirando encabezado + primeras 50 filas, clamp `[10, 40]` (`:84-92`).
  Nombre de hoja saneado y cortado a 28 chars (`:96`).
- `encodePdf` (`:106`) — PDFKit A4 **landscape**, margen 32, columnas de ancho igual, fuente 9 (7 si hay >8 columnas), encabezado repetido
  por página, zebra striping. Tabla naive: **no hay wrap**, todo es `ellipsis: true`. Por eso el cap duro de 1000 filas.

---

## 5. Lado dashboard

### 5.1 El componente reutilizable

`/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard/src/components/export-dialog.tsx` (381 líneas)

**Sí es reutilizable y lo usan pagos y órdenes.** Props (`:28-48`): `open`, `onClose`, `title`, `endpoint`, `baseParams`,
`columns: ExportColumnOption[]`, `initialDateFrom/To`, `estimatedCount?`, `filenameStem`, `activeFilterSummary?`.

`ExportColumnOption` (`:17-26`): `{ id, label, defaultSelected?, required? }`. `required` = checkbox deshabilitado y no se puede quitar.

Estructura visual: `FullScreenModal` con 4 secciones — rango de fechas (`DateRangePicker`), chips de filtros heredados (solo lectura), grid
de checkboxes de columnas con botones "Todas"/"Ninguna", y radio de formato con hints. Warning ámbar si
`format==='pdf' && estimatedCount > 1000` (`:98`).

### 5.2 Cómo pasa los filtros vigentes

**Explícitamente, vía `baseParams`.** No hay magia: cada página construye un `useMemo` que espeja los query params del listado.

- Pagos: `src/pages/Payment/Payments.tsx:1235-1244` → `merchantAccountIds`, `methods`, `sources`, `staffIds`, `search` (todos joined con
  coma, omitidos si vacíos).
- Órdenes: `src/pages/Order/Orders.tsx:1086-1095` → `statuses`, `types`, `tableIds`, `staffIds`, `search`.

El diálogo los aplana y **sobreescribe siempre `startDate`/`endDate`** con el rango elegido dentro del modal (`export-dialog.tsx:108-114`):

```ts
const params = {
  ...Object.fromEntries(Object.entries(baseParams).filter(([, v]) => v !== undefined)),
  format,
  startDate: dateRange.from.toISOString(),
  endDate: dateRange.to.toISOString(),
  columns: Array.from(selectedColumns).join(','),
}
```

Nota: el rango de fechas **no** viaja en `baseParams`; viaja del picker del modal, sembrado con `initialDateFrom/To` de la página.

### 5.3 Cómo dispara la descarga

**axios `responseType: 'blob'` + ancla sintética.** No `window.open` (perdería el header `Authorization`/cookie y no manejaría el 413).
`export-dialog.tsx:116-135`:

```ts
const response = await api.get(endpoint, { params, responseType: 'blob' })
const ext = format === 'xlsx' ? 'xlsx' : format
const stamp = DateTime.now().toFormat('yyyy-LL-dd')
const filename = `${filenameStem}-${stamp}.${ext}`
const url = window.URL.createObjectURL(response.data as Blob)
const link = document.createElement('a')
link.href = url
link.download = filename
document.body.appendChild(link)
link.click()
link.remove()
window.URL.revokeObjectURL(url)
```

`api` es la instancia axios de `src/api.ts:48-51` (`baseURL` resuelto + `withCredentials: true` — auth por cookie, no por header manual).
**El `endpoint` que se le pasa incluye el prefijo completo** `/api/v1/dashboard/...`.

⚠️ El front **reconstruye el nombre del archivo por su cuenta** en vez de leer el `Content-Disposition` que el backend ya manda. Funciona
porque ambos usan el mismo formato `stem-YYYY-MM-DD.ext`, pero son dos fuentes de verdad: la del backend es UTC (`export.helpers.ts:194`) y
la del front es hora local del navegador (`DateTime.now()`). Cerca de medianoche los nombres difieren — cosmético, pero es un acoplamiento
no declarado.

### 5.4 Estado de carga y error

- **Carga:** `isExporting` local (`:80`). El botón se deshabilita y cambia `Download` → `<Loader2 className="animate-spin" />` (`:176-184`).
  `finally { setIsExporting(false) }` (`:164-166`). **No usa TanStack Query** — es un `try/catch` a mano; no hay caché ni reintentos, y es
  lo correcto para una descarga.
- **Error — el detalle que hay que copiar sí o sí** (`:139-163`): con `responseType:'blob'`, **el cuerpo de error también llega como Blob**,
  así que `err.response.data.message` es `undefined`. Hay que desempacarlo:

```ts
if (data instanceof Blob) {
  try {
    const parsed = JSON.parse(await data.text())
    if (parsed?.message) message = parsed.message
  } catch {
    /* fallback genérico */
  }
} else if (data?.message) {
  message = data.message
}
if (status === 413) {
  toast({ title: 'Demasiados resultados', description: message, variant: 'destructive' })
} else {
  toast({ title: message, variant: 'destructive' })
}
```

- Guard previo: si `selectedColumns.size === 0` → toast y return sin llamar (`:101-104`). Éxito → toast + `onClose()`.
- **i18n:** todas las cadenas del diálogo pasan por `t('exportDialog.*')` con `defaultValue` en español. Las claves existen en
  `src/locales/{es,en,fr}/common.json` bajo `exportDialog` (verificado es/en completos).

### 5.5 Los botones que lo abren

Los tres son **markup a mano, no un componente**:

- Pagos: `Payments.tsx:1607-1613`, `<button>` ghost con `<Download className="h-3.5 w-3.5" />` y `data-tour="payments-export-btn"`.
- Órdenes: `Orders.tsx:1399-1405`, idéntico, `data-tour="orders-export-btn"`.
- Resumen: `SalesSummary.tsx:1212-1220`, `<Button variant="ghost" size="icon">`, `data-tour="sales-summary-export"`. **Envuelto en
  `{hasAccess && (...)}`** (`:738`, `useTierFeatureAccess('ADVANCED_REPORTS')`) — un venue Free ni ve el botón.

### 5.6 El diálogo de resumen de ventas — copia divergente

`/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard/src/pages/Reports/components/SalesSummaryExportDialog.tsx` (478 líneas)
**NO usa `ExportDialog`**. Es un fork con la misma mecánica de blob (`:153-165`) y el mismo desempaque de error-Blob (`:168-188`), pero con
lo suyo:

- Toggle `summary`/`detailed`, con `detailed` deshabilitado + badge PREMIUM cuando `useTierFeatureAccess('TRANSACTION_EXPORT')` es falso
  (`:56`, `:223-238`).
- **Filtros editables dentro del modal** (`FilterPill`: método de pago, tipo de tarjeta, cuenta comercial, staff, turno) en lugar de chips
  de solo lectura.
- Consultas propias de staff y turnos, sólo cuando `mode==='detailed'` (`:73-91`).
- **Las listas de ids están duplicadas a mano** del backend: `DETAIL_COLUMNS` (`:41-44`, 13 ids) y `SUMMARY_SECTIONS` (`:40`). Si el backend
  renombra un id, aquí no truena: `pickColumns` lo ignora en silencio y la columna simplemente desaparece del archivo.
- `REQUIRED_COLUMNS = new Set(['createdAt','amount'])` (`:45`) — pero **el backend no obliga nada**; es sólo UI.
- Filename stem lo decide el front (`:156`): `ventas-detalladas` / `resumen-ventas` — coincide con el backend por convención, no por
  contrato.

### 5.7 El cuarto patrón (el que NO se debe copiar)

`src/pages/playtelecom/Organization/StockControl/components/ExportButton.tsx` — export **100% cliente**: toma las filas ya cargadas en
memoria y las manda a `exportToExcel` de `@/utils/export`. Sin endpoint, sin cap, sin formato PDF/CSV, y limitado a lo que quepa en la
página. Si un módulo nuevo copia esto, no cumple "exportable" de verdad.

---

## 6. (a) RECETA CANÓNICA — agregar una exportación nueva

Sigue esto tal cual; no hace falta releer el código.

### Backend

**1. Extrae el `where` del listado a una función nombrada** en el servicio, en el archivo del listado:

```ts
function buildXWhereClause(venueId: string, filters?: XFilters): any {
  const where: any = { venueId, /* + los mismos defaults del listado */ }
  ...
  return where
}
```

Y — a diferencia de pagos y órdenes — **haz que `getX()` la use también**. No dejes la copia inline.

**2. Añade dos funciones al MISMO servicio del listado** (nunca un `x.export.service.ts` nuevo):

```ts
export async function countXForExport(venueId: string, filters?: XFilters): Promise<number> {
  return prisma.x.count({ where: buildXWhereClause(venueId, filters) })
}

export async function fetchXForExport(venueId: string, filters: XFilters | undefined, limit: number) {
  return prisma.x.findMany({
    where: buildXWhereClause(venueId, filters),
    include: {
      /* SOLO lo que plucan las columnas */
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], // ← desempate por id: el orderBy DEBE ser único
    take: limit,
  })
}
```

**3. Escribe el controlador** en el controlador existente del recurso (`src/controllers/dashboard/x.dashboard.controller.ts`), copiando
literalmente `payment.dashboard.controller.ts:275-393`:

```ts
import {
  encodeExport,
  sendExport,
  parseColumnsParam,
  parseFormatParam,
  getRowCapForFormat,
  type ExportColumnDef,
} from '../../services/dashboard/export.helpers'

export async function exportXData(req, res, next): Promise<void> {
  try {
    const { venueId } = req.params // multi-tenant: SIEMPRE del path/authContext
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = getRowCapForFormat(format)

    const filters: XFilters = {
      /* mismos nombres de query param que el listado */
    }

    const total = await countXForExport(venueId, filters)
    if (total > cap) {
      res.status(413).json({
        success: false,
        message:
          format === 'pdf'
            ? `El rango contiene ${total.toLocaleString()} filas. PDF está limitado a ${cap.toLocaleString()}. Usa CSV o Excel, o reduce el rango con filtros.`
            : `El rango contiene ${total.toLocaleString()} filas. El máximo por export es ${cap.toLocaleString()}. Reduce el rango con filtros.`,
      })
      return
    }

    const rows = await fetchXForExport(venueId, filters, cap)
    type Row = (typeof rows)[number]

    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'createdAt', label: 'Fecha', value: r => r.createdAt?.toISOString() ?? '' },
      { id: 'amount', label: 'Monto', value: r => Number(r.amount) || 0 }, // PESOS 1:1, número plano
      // ... etiquetas en duro, en español
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
      rows,
      title: 'Título en español',
    })

    logger.info('[X export]', { venueId, total, format, columns: requestedColumnIds.length })
    sendExport(res, encoded, 'x') // → x-2026-08-07.csv
  } catch (error) {
    logger.error('Error exporting X', { error: error instanceof Error ? error.message : 'Unknown' })
    next(error)
  }
}
```

**4. Registra la ruta ARRIBA de las dinámicas**, con el mismo permiso `read` del listado:

```ts
// Export route — must be declared BEFORE the `:xId` routes so Express matches it first.
router.get('/venues/:venueId/x/export', authenticateTokenMiddleware, checkPermission('x:read'), xController.exportXData)
```

Si tu router se monta con `router.use(...)`, confirma que `authenticateTokenMiddleware` esté en el `use` (patrón de `reports`,
`dashboard.routes.ts:4268`) o ponlo por ruta.

**5. Si el export es de tier de paga**, decide y aplica _antes_ del count. Copia el 403 **verbatim** de
`sales-summary.dashboard.controller.ts:232-237` (`error`/`message`/`featureCode`/`subscriptionRequired`) — el `FeatureGate` del dashboard
depende de esa forma exacta. Y usa el resolver correcto: `venueHasFeatureAccess` para `Feature`, `moduleService.isModuleEnabled` para
`Module`.

**6. MCP + ActivityLog**: no hay tool de MCP ni `ActivityLog` para ninguno de los tres exports hoy. Si tu módulo H0 lo requiere
(bitácora/contabilidad son candidatos obvios a "quién se llevó los datos"), decídelo explícitamente — no lo heredes por omisión del patrón
actual.

### Frontend

**7. Define las columnas** en la página, con etiquetas via `t()`, ids que **coincidan exactamente** con los del backend:

```ts
const exportColumns = useMemo<ExportColumnOption[]>(() => [
  { id: 'createdAt', label: t('columns.date'), defaultSelected: true, required: true },
  ...
], [t])
```

**8. Espeja los filtros** en `exportBaseParams` con **los mismos nombres de query param** que usa el listado, y arma `exportFilterSummary`
para los chips.

**9. Monta `<ExportDialog>`** y un botón que haga `setExportOpen(true)`:

```tsx
<ExportDialog
  open={exportOpen}
  onClose={() => setExportOpen(false)}
  title={t('export.title')}
  endpoint={`/api/v1/dashboard/venues/${venueId}/x/export`}
  baseParams={exportBaseParams}
  columns={exportColumns}
  initialDateFrom={dateRange.from}
  initialDateTo={dateRange.to}
  estimatedCount={filteredRows.length || total}
  filenameStem="x"
  activeFilterSummary={exportFilterSummary}
/>
```

`filenameStem` debe ser **igual** al que pasas a `sendExport`.

**10. Prueba**: modelo en `tests/api-tests/dashboard/salesSummaryExport.api.test.ts` (294 líneas, 7 casos): 200+content-type por formato,
413 al pasar el cap, 403 del gate de tier, y la no-fuga de datos de tier. Pagos y órdenes **no tienen ninguna prueba de export** — no copies
esa parte.

---

## 7. (b) Trampas que vas a pisar

1. **`/export` debajo de `/:id`** → la ruta es inalcanzable y Express se lo traga como "id = export". Los dos caminos vivos llevan el
   comentario `must be declared BEFORE the :xId routes` justo encima. (`dashboard.routes.ts:3136`, `:3174`)

2. **`parseFormatParam` NUNCA falla.** `?format=json` devuelve `'csv'` silenciosamente (`export.helpers.ts:226-229`). No esperes un 400.

3. **Un id de columna desconocido se ignora en silencio** (`pickColumns`, `:46-49`). Si renombras un id en el backend, el front sigue
   "funcionando" y la columna simplemente desaparece del archivo. **Y si TODOS los ids son inválidos, `encodeExport` lanza** (`:182`) →
   `next(error)` → **500 genérico**, no un 400 útil.

4. **El cuerpo de error llega como `Blob`** cuando pides `responseType:'blob'`. Si no desempacas con `await data.text()` + `JSON.parse`
   (`export-dialog.tsx:144-151`), el mensaje del 413 se pierde y el usuario ve "No se pudo generar el archivo" sin saber qué hacer.

5. **`orderBy` no único = filas perdidas.** `fetchPaymentsForExport` (`payment.dashboard.service.ts:347`) y `fetchOrdersForExport`
   (`order.dashboard.service.ts:216`) ordenan sólo por `createdAt desc`. Con `take: limit` y muchos timestamps empatados, el corte es
   no-determinista. **Pon siempre desempate por `id`.**

6. **Race entre el count y el fetch.** El pre-flight cuenta, luego el `findMany` trae. Si entran filas en medio, `take: cap` trunca en
   silencio y el usuario nunca se entera. El 413 protege el caso grande, no éste.

7. **Fechas en UTC crudo.** Los tres exports emiten `createdAt.toISOString()`. Un venue en México ve `2026-08-07T02:30:00.000Z` para una
   venta de las 20:30 del día **6**. Contabilidad y auditoría abren esos archivos: si tu módulo H0 se lee como bitácora fiscal, **formatea a
   hora local del venue** con `formatInTimeZone(..., venue.timezone, ...)`. No copies esto por inercia.

8. **`sendExport` estampa la fecha en UTC** (`export.helpers.ts:194`) mientras el front usa `DateTime.now()` local. Cerca de medianoche los
   nombres difieren. El front además **ignora** el `Content-Disposition` que ya viene bien formado.

9. **`toLocaleString()` sin locale** en los mensajes 413 (`payment.dashboard.controller.ts:327`) usa el locale del **proceso Node**, no el
   del usuario. En prod (sin `LANG`) da separadores de miles al estilo `en-US` dentro de un mensaje en español.

10. **El PDF no hace wrap: trunca con `…`** (`export.helpers.ts:154-157`) y las columnas son de ancho igual. Con >8 columnas la fuente baja
    a 7pt. Un PDF con muchas columnas o textos largos es ilegible. El cap de 1000 filas es un síntoma de esto, no la única limitación.

11. **`encodeXlsx` autoajusta mirando sólo las primeras 50 filas** (`:86`). Una descripción larga en la fila 900 sale cortada visualmente.

12. **CSV sin BOM = acentos rotos en Excel.** El helper ya lo pone (`:68`). Si alguien "optimiza" ese `bom` fuera, se rompe todo export en
    español.

13. **El export puede divergir de la pantalla y nadie lo nota.** Ya pasó: órdenes ordena distinto (`updatedAt` vs `createdAt`), y pagos
    omite la fusión legacy de MindForm que sí hace el listado. **Si el módulo tiene ramas especiales en el listado, el export las necesita
    también.**

14. **`req.params.venueId` vs `resolveRequestVenueId`.** Si tu ruta existe con y sin `:venueId` (patrón reports), usa
    `resolveRequestVenueId(req, req.authContext!)` (`sales-summary.dashboard.controller.ts:179`). Y **`authContext`, nunca `req.user`.**

15. **`authenticateTokenMiddleware` no está en las rutas de reports**, está en el `router.use` (`dashboard.routes.ts:4268`). Un router nuevo
    montado sin él deja el endpoint sin autenticar.

16. **Ningún export escribe `ActivityLog`.** Sólo `logger.info`. Descarga masiva de datos del venue sin rastro auditable — decisión
    heredada, no bendecida.

17. **Ningún export tiene rate-limit propio.** Un cliente puede pedir 10k filas en PDF (bueno, 1k) en bucle. Con el historial de OOM en
    Render (memoria `oom-render-analytics-512mb`), cuatro módulos nuevos de export sin protección merecen al menos una mirada.

---

## 8. (c) Lo que está DUPLICADO hoy y debería extraerse ANTES de agregar cuatro más

Ordenado por daño/esfuerzo.

### 🔴 D1 — `parseList` está copiado 4 veces

`payment.dashboard.controller.ts:53-60` y `:301-308`; `order.dashboard.controller.ts:39-46` y `:147-154`; variante en
`sales-summary.dashboard.controller.ts:202-209` (acepta `unknown` en vez de `string`). Cuatro módulos más = 8 copias. **→ Muévelo a
`export.helpers.ts` como `parseListParam(raw: unknown): string[] | undefined`.** Es la firma de sales-summary, que es la más general.

### 🔴 D2 — El bloque pre-flight + 413 está copiado 3 veces con el texto reescrito a mano

`payment…:320-331` ("filas"), `order…:166-176` ("órdenes"), `sales-summary…:251-261` ("transacciones"). Mismo shape, misma lógica, tres
redacciones. **→ Extrae a `export.helpers.ts`:**

```ts
export function sendRowCapExceeded(res: Response, opts: { total: number; cap: number; format: ExportFormat; noun: string }): void
```

Un solo texto en español, un solo lugar donde ajustar la copia. Sin esto, en siete módulos habrá siete mensajes distintos para el mismo
error.

### 🟠 D3 — `buildXWhereClause` es una copia literal del `where` inline del listado, no una extracción

`payment.dashboard.service.ts:272-324` vs `:47-114`; `order.dashboard.service.ts:157-195` vs `:53-107`. **Ambos llevan un docstring que dice
"extracted … without duplicating logic" — y no es cierto.** El costo ya se cobró: la rama MindForm y el `orderBy` divergen. **→ Antes de
tocar nada más, haz que `getPaymentsData` y `getOrders` llamen a su propio `build…WhereClause`.** Es un refactor mecánico, con test de
regresión evidente (mismo `where` = mismos resultados), y es la única forma de garantizar que "lo que exportas es lo que ves" en los cuatro
módulos nuevos.

### 🟠 D4 — El registry de ids de columnas está duplicado backend ↔ frontend, sin contrato

Pagos: `payment…controller.ts:337-378` vs `Payments.tsx:1216-1233`. Órdenes: `order…controller.ts:181-204` vs `Orders.tsx:1068-1085`.
Ventas: `sales-summary…controller.ts:267-293` vs `SalesSummaryExportDialog.tsx:41-44`. **Y las etiquetas son distintas a propósito**: el
backend en duro español, el front con `t()`. **→ Mínimo: un archivo de constantes compartido por módulo, o que el backend exponga
`GET …/export/columns` que el diálogo consuma.** Con 7 módulos y ~13 columnas cada uno son ~180 ids a sincronizar a mano; el fallo es
silencioso (columna que desaparece del archivo).

### 🟡 D5 — El `try/catch` con desempaque de error-Blob está copiado 2 veces

`export-dialog.tsx:139-163` y `SalesSummaryExportDialog.tsx:168-188`, más el disparo de descarga (`:116-135` / `:153-165`). **→ Extrae
`useBlobExport()` en el dashboard:** recibe `(endpoint, params, filenameStem, ext)` y devuelve `{ run, isExporting }`. Cualquier diálogo
nuevo (los cuatro de H0) lo consume y el manejo de 413/403/error-Blob queda resuelto en un lugar.

### 🟡 D6 — Dos diálogos con la misma mecánica y distinta UX

`ExportDialog` (chips de filtro de solo lectura) vs `SalesSummaryExportDialog` (pills editables + modos + gate PREMIUM). El fork está
justificado por los requisitos, pero significa que **hay dos "así se ve un export" en el producto**. Si contabilidad necesita filtros
editables va a forkear el fork. **→ La ruta barata: dar a `ExportDialog` una prop `extraFilters?: ReactNode` y una `modes?`**, y migrar el
de ventas encima. Hazlo antes de los cuatro nuevos, no después de los seis.

### 🟡 D7 — La misma columna, dos implementaciones divergentes

`international`: pagos usa `raw === true || raw === 'true'` (tolera el string, `payment…controller.ts:352-359`); ventas-detalladas usa
`?.isInternational ? 'Sí':'No'` (el string `'true'` truthy también cae en Sí, pero el `false` string sería Sí incorrectamente). `last4`
idem, dos `slice(-4)` separados. **→ Un módulo `export.cells.ts` con las celdas comunes**: `moneyCell`, `venueDateCell(tz)`,
`staffNameCell`, `last4Cell`, `boolSiNoCell`. Es donde debe vivir la decisión de fecha venue-local (trampa 7) para que se arregle una vez y
en todos.

### ⚪ D8 — Cobertura de pruebas asimétrica

Sólo `sales-summary` tiene pruebas (`tests/api-tests/dashboard/salesSummaryExport.api.test.ts`). Pagos y órdenes: cero. Ningún test unitario
toca `export.helpers.ts` (verificado: ningún archivo bajo `tests/` importa `encodeExport`/`sendExport`/`parseColumnsParam`). **→ Antes de
multiplicar por 7: un test unitario de `export.helpers.ts`** (BOM del CSV, escapado RFC-4180, id desconocido ignorado, 0 columnas lanza,
`getRowCapForFormat`) — es puro y barato, y protege los siete caminos de golpe.

---

## 9. Lo que NO pude verificar

- **No corrí ninguna exportación real** (levantamiento de solo lectura). Todo lo de arriba es lectura de código; el comportamiento del PDF
  con muchas columnas y del XLSX con textos largos lo deduzco del código de PDFKit/XLSX, no de un archivo generado.
- **No revisé `src/locales/fr/common.json`** más allá de confirmar que el archivo contiene la clave `exportDialog` (verifiqué el contenido
  completo sólo de `es` y `en`).
- **No busqué exhaustivamente otros exports client-side** fuera del de PlayTelecom (`utils/export.ts` / `exportToExcel`); puede haber más
  páginas usando ese atajo.
- **No verifiqué si `TRANSACTION_EXPORT` está en `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`** — es un `Feature` code, no un permiso, así que no
  aplica esa checklist; pero no confirmé su fila en la tabla `Feature` de la BD.

---

# Anexo B — Especificación por módulo

[ { "modulo": "Bitácora / Registro de actividad (ActivityLog) — nivel VENUE y nivel ORGANIZACIÓN", "quePrometimos": "Fila 35 (Área \"1
POS\", columna \"a.Avoqado*Cumplimiento en forma natural del sistema\" = 1): Función = \"El sistema puede generar una bitacora de las
operaciones realizadas por usuario\". Comentario TEXTUAL: \"Bitácora completa de operaciones por usuario, exportable y filtrable por
sucursal, fecha y tipo de operación.\" || Fila 28 (Área \"1 POS\", cumplimiento natural = 1): Función = \"El sistema puede tener la
trazabilidad del acceso de cada usuario (inicio de sesión, actividad, cierre de sesión)\". Comentario TEXTUAL: \"Bitácora de acceso y
actividad por usuario: inicio y cierre de sesión, y registro auditable de cada operación sensible (cancelación, cortesía, descuento,
devolución, cambio de precio).\" || Fila 4 (Área \"0 General\", cumplimiento natural = 1), que es el paraguas: \"Reportes predefinidos,
configurables y exportables (XLS/PDF/CSV) nativos.\" — La palabra \"exportable\" de la fila 35 es la que NO se cumple: hoy NO existe ningún
endpoint ni botón de exportación de la bitácora, en ninguno de los dos alcances. Lo demás de la fila 35 (filtrable por sucursal, fecha y
tipo de operación) SÍ existe.", "queExisteHoy": "HAY TRES BITÁCORAS, NINGUNA EXPORTABLE. (1) POR VENUE — servicio `queryVenueActivityLogs`
en src/services/dashboard/activity-log.service.ts:244, con `getVenueDistinctActions`:301 y `getVenueDistinctEntities`:312. Ruta GET
/api/v1/dashboard/venues/:venueId/activity-log en src/routes/dashboard/activityLog.routes.ts:28-34 (+ /actions:40, /entities:46), montada en
src/routes/dashboard.routes.ts:3511 con `authenticateTokenMiddleware` en el `router.use`. Gates por-ruta:
`checkFeatureAccess('VENUE_AUDIT_LOG')` (Feature PRO, sembrada en scripts/seed-venue-audit-log.ts:22) + `checkPermission('activity:read')`.
Controlador src/controllers/dashboard/activityLog.dashboard.controller.ts:4-22. Zod en src/schemas/dashboard/activityLog.schema.ts. Pantalla
avoqado-web-dashboard/src/pages/Venue/VenueActivityLog.tsx (ruta montada en src/routes/venueRoutes.tsx:789-793). SIN botón de exportar (leí
el archivo completo: no importa Download ni ExportDialog). (2) POR ORGANIZACIÓN — servicio `queryActivityLogs` :109 y `getDistinctActions`
:207. Ruta GET /dashboard/organizations/:orgId/activity-log en src/routes/dashboard/organizationDashboard.routes.ts:1532 (+ /actions:1564).
Gate: SÓLO `checkOrgAccess` (definido local en :43-66, valida pertenencia a la org) — NO hay `checkPermission` NI `checkFeatureAccess`.
Pantalla OrganizationActivityLog.tsx. SIN exportación. (3) SUPERADMIN — src/routes/superadmin/activityLog.routes.ts +
`querySuperadminActivityLogs` :358; herramienta interna de Avoqado, NO es entregable PITS, la excluyo del alcance. || MODELO:
prisma/schema.prisma:5725-5745 — campos staffId?, venueId?, action, entity?, entityId?, data Json?, ipAddress?, userAgent?, createdAt;
índices en staffId, venueId, (entity,entityId), createdAt. || ESCRITURA: 475 sitios que llaman `logAction({...})` + 32
`prisma.activityLog.create` directos ≈ 507 puntos de escritura, con ~398 strings de acción distintos y payloads `data` totalmente
heterogéneos (ej.: `{status:'PENDING_APPROVAL'}` purchaseOrderWorkflow.service.ts:141, `{from,to,reason}` :404, `{orderNumber,supplierId}`
purchaseOrder.service.ts:713, `{source,method,rememberMe}` auth.service.ts:456). || LOGIN/LOGOUT (lo nuevo, y lo de mayor volumen): 7 rutas
de acceso escriben a ActivityLog — STAFF_LOGIN en auth.service.ts:453 (dashboard/contraseña), googleOAuth.service.ts:488 (SSO),
auth.mobile.service.ts:256 (passkey) y :621 (contraseña), auth.tpv.service.ts:180 (NIP en terminal); STAFF_LOGOUT en
auth.dashboard.controller.ts:802 y auth.tpv.service.ts:389. || DATO DURO QUE CAMBIA EL DISEÑO: sólo 29 de los 475 sitios de `logAction`
mandan `ipAddress` y sólo 23 mandan `userAgent`. De las 7 rutas de acceso, únicamente DOS traen IP (auth.service.ts:453 y
auth.dashboard.controller.ts:802). Las otras cinco (SSO, móvil passkey, móvil contraseña, TPV login, TPV logout) llegan con ipAddress NULL;
en TPV el \"desde dónde\" vive dentro del jsonb como `data.terminalSerialNumber` (auth.tpv.service.ts:183). || MCP: `get_activity_log` ya
existe en src/mcp/tools/activity-log.ts:13 y deliberadamente NO expone ipAddress ni userAgent (el `select` de :50-59 los omite) — precedente
útil para la decisión de PII. || PRUEBAS ya existentes que la exportación no debe romper:
tests/unit/services/dashboard/venueActivityLog.service.test.ts, tests/unit/services/dashboard/activity-log.pagination-stability.test.ts,
tests/api-tests/dashboard/venueActivityLog.api.test.ts.", "listados": [ { "nombre": "Bitácora por sucursal (pantalla del dueño / gerente de
tienda)", "servicioActual": "queryVenueActivityLogs — src/services/dashboard/activity-log.service.ts:244 (where en :252-271, orderBy único
[{createdAt:'desc'},{id:'desc'}] en :279, fechas venue-local con fromZonedTime en :268-269). Catálogos de filtro: getVenueDistinctActions
:301 y getVenueDistinctEntities :312. Extraer de :252-271 una función nombrada buildVenueActivityLogWhere(venueId, venueTz, filters) y hacer
que queryVenueActivityLogs la USE (no dejar la copia inline, que es el defecto D3 del patrón), y agregar countVenueActivityLogsForExport +
fetchVenueActivityLogsForExport en el MISMO archivo, reusando el orderBy [{createdAt:'desc'},{id:'desc'}] y ampliando el select de staff
(:277) a {id,firstName,lastName,email}.", "rutaActual": "GET /api/v1/dashboard/venues/:venueId/activity-log —
src/routes/dashboard/activityLog.routes.ts:28-34, montada en src/routes/dashboard.routes.ts:3511", "rutaExportPropuesta": "GET
/api/v1/dashboard/venues/:venueId/activity-log/export — VERIFICADO que NO existe hoy (leí src/routes/dashboard/activityLog.routes.ts
completo: sólo '/', '/actions', '/entities'). El sub-router NO tiene NINGUNA ruta dinámica :param, así que no hay trampa de orden
estático-antes-de-dinámico aquí; colócala junto a /entities. authenticateTokenMiddleware YA viene del router.use en
dashboard.routes.ts:3511, NO lo repitas; SÍ repite por-ruta checkFeatureAccess('VENUE_AUDIT_LOG') + checkPermission('activity:read') porque
este sub-router no los tiene a nivel use. El montaje en :3511 está antes de /venues/:venueId/payments/:paymentId (:3513) y 'activity-log' es
segmento estático distinto: sin conflicto.", "permiso": "activity:read — VERIFICADO que EXISTE: src/lib/permissions.ts:1468
(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.activity = ['activity:read']) y src/lib/permissions.ts:967 (DEFAULT_PERMISSIONS[OWNER]). Sólo lo tiene
OWNER (y SUPERADMIN vía *:_): NO ADMIN, NO MANAGER. Usar el MISMO permiso que el listado, igual que pagos/órdenes ('quien puede ver la lista
puede exportarla'). 'activity:export' NO EXISTE — lo verifiqué: no aparece en permissions.ts. Si el founder quiere separarlo hay que
agregarlo en DOS lugares (:1468 en el catálogo y :967 en los defaults de OWNER) o el endpoint nace muerto.", "columnas": [ "createdAt —
'Fecha y hora': formatInTimeZone(r.createdAt, venue.timezone ?? 'America/Mexico_City', 'yyyy-MM-dd HH:mm:ss'). DESVIACIÓN DELIBERADA del
patrón: pagos/órdenes emiten toObject ISO en UTC; un contralor que abre la bitácora no puede leer un acceso de las 20:30 de Querétaro como
02:30Z del día siguiente.", "venueName — 'Sucursal': constante en este alcance, pero el archivo se manda por correo y se despega del
contexto. Default ON.", "staffName — 'Usuario': `${firstName} ${lastName}`.trim(); si staff es null poner 'Sistema' (mismo criterio que la
pantalla, VenueActivityLog.tsx:378).", "staffEmail — 'Correo del usuario': desambigua dos homónimos. REQUIERE ampliar el select de staff en
activity-log.service.ts:277, que hoy es {id,firstName,lastName}.", "action — 'Código de acción': el string crudo (STAFF_LOGIN,
ORDER_CANCELLED). Es la llave para cruzar con otros reportes. Default ON.", "actionLabel — 'Acción': etiqueta legible en español. ATENCIÓN:
HOY NO EXISTE en el backend — las traducciones viven sólo en el i18n del dashboard (clave activityLog.actions.*) con formatActionFallback
como respaldo (VenueActivityLog.tsx:97). Hay ~398 acciones distintas. Decisión propuesta: portar al backend un mapa de las ~40 acciones que
un contralor audita y para el resto aplicar el mismo fallback (guiones bajos → espacios, Capitalizado). NO bloquear la exportación esperando
traducir 398.", "entity — 'Entidad'", "entityId — 'ID de entidad'", "origen — 'Origen': DERIVADA, no es columna de tabla. Se arma de
data.source ('dashboard'|'tpv'|'mobile') + data.terminalSerialNumber + data.method. Es lo ÚNICO que responde '¿desde dónde?' en TPV y móvil,
donde ipAddress viene NULL.", "ipAddress — 'Dirección IP': default ON, pero con la salvedad medida: sólo 29 de 475 sitios de logAction la
escriben, y de las 7 rutas de acceso sólo 2. Ver riesgo #1.", "resumen — 'Detalle': el jsonb `data` APLANADO a `clave=valor; clave=valor`,
profundidad 1, arreglos como [n], objetos anidados como {…}, tope ~200 caracteres, y pasado por la MISMA redacción de claves sensibles.
Default ON. Es la columna que hace la exportación legible.", "dataJson — 'Detalle técnico (JSON)': JSON.stringify del data REDACTADO.
Default OFF, para el caso forense. Nunca tiene sentido en PDF (encodePdf de export.helpers.ts no hace wrap: trunca con '…').", "userAgent —
'Dispositivo / navegador': default OFF. Es larguísimo, arruina el ancho del CSV y del PDF, y sólo 23 de 475 sitios lo escriben.", "id —
'Folio de bitácora': default OFF. Sirve para citar un renglón exacto en un informe de auditoría." ], "pantallaDashboard":
"/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard/src/pages/Venue/VenueActivityLog.tsx — el botón va en el encabezado
(:191-195, hoy es un <div> con h1+p; convertirlo en flex row con el botón a la derecha), como los tres caminos vivos que ya existen
(Payments.tsx:1607, Orders.tsx:1399, SalesSummary.tsx:1212). SÍ HAY COMPONENTE REUTILIZABLE:
/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard/src/components/export-dialog.tsx (verificado que existe, 16 KB) — se usa
tal cual, NO forkear como hizo SalesSummaryExportDialog.tsx. El servicio de front a extender es src/services/venueActivity.service.ts (los
nombres de query param a espejar están en :36-43).", "reusaFiltros": "La pantalla ya tiene TODO el estado de filtro en :108-113 (searchTerm,
actionFilter, staffFilter, startDate, endDate, page) y lo arma en un useMemo en :119-130. Se agrega un exportBaseParams (useMemo hermano)
con EXACTAMENTE los mismos nombres de query param que consume el listado — search, action, staffId, entity, startDate, endDate — verificados
contra venueActivity.service.ts:38-43, y se pasa a <ExportDialog baseParams=...>, más un activeFilterSummary con los chips de sólo lectura.
Así se exporta LO QUE SE VE. TRAMPA REAL: ExportDialog SOBREESCRIBE siempre startDate/endDate con su propio DateRangePicker y los manda como
.toISOString() (export-dialog.tsx:108-114), mientras que la pantalla los manda como 'YYYY-MM-DD' pelón y el servicio los mete en una
plantilla `${startDate}T00:00:00.000` (activity-log.service.ts:268). Un ISO completo produce '2026-08-07T00:00:00.000ZT00:00:00.000' = fecha
inválida. El controlador de export DEBE normalizar (recortar a los primeros 10 caracteres) antes de llamar al servicio. Ver riesgo #4." }, {
"nombre": "Bitácora consolidada por organización (pantalla del contralor / corporativo — la que PITS realmente va a usar con sus
sucursales)", "servicioActual": "queryActivityLogs — src/services/dashboard/activity-log.service.ts:109 (resuelve los venueIds de la org en
:113-122, where en :126-155, orderBy único en :173). Catálogo de acciones: getDistinctActions :207. Mismo trabajo: extraer
buildOrgActivityLogWhere de :126-155, hacer que queryActivityLogs la use, y agregar countOrgActivityLogsForExport +
fetchOrgActivityLogsForExport en el MISMO archivo con el orderBy [{createdAt:'desc'},{id:'desc'}] idéntico. NOTA: este servicio NO tiene el
arreglo de zona horaria que sí tiene el de venue — usa new Date(params.startDate) en :152-153 (la trampa de tz del repo). Hay que corregirlo
AL EXTRAER, no después.", "rutaActual": "GET /api/v1/dashboard/organizations/:orgId/activity-log —
src/routes/dashboard/organizationDashboard.routes.ts:1532 (y /:orgId/activity-log/actions en :1564)", "rutaExportPropuesta": "GET
/api/v1/dashboard/organizations/:orgId/activity-log/export — VERIFICADO que NO existe. Orden: en este archivo NO hay ninguna ruta dinámica
después del segmento 'activity-log' (las rutas son /:orgId/activity-log y /:orgId/activity-log/actions), así que /export no queda capturada.
En ESTE archivo authenticateTokenMiddleware va POR RUTA (no en un router.use), así que la nueva ruta debe declarar:
router.get('/:orgId/activity-log/export', authenticateTokenMiddleware, checkOrgAccess, checkPermission('activity:read'),
exportOrgActivityLog).", "permiso": "activity:read — el mismo permiso verificado en src/lib/permissions.ts:1468 y :967. 🔴 OJO: la ruta de
LISTADO de org (organizationDashboard.routes.ts:1532) HOY NO LLEVA NINGÚN checkPermission, sólo checkOrgAccess (:43-66), que únicamente
comprueba que authContext.orgId == req.params.orgId. Es decir, hoy CUALQUIER staff de la organización (incluido un WAITER) puede leer la
bitácora completa de todas las sucursales. Agregar una exportación masiva encima de eso sin candado convierte una sobre-exposición de
lectura paginada en una vía de extracción masiva con IPs. La exportación DEBE llevar checkPermission('activity:read'); y el listado sin
permiso hay que reportarlo como hallazgo aparte (no lo arreglo aquí porque cambiaría el comportamiento vigente de una pantalla en
producción).", "columnas": [ "createdAt — 'Fecha y hora': ⚠️ aquí NO hay una sola zona horaria. Cada sucursal tiene su Venue.timezone. Hay
que traer el timezone de cada venue en el mapa que ya se construye en :113-123 (hoy sólo trae {id,name}) y formatear CADA renglón en la tz
de SU sucursal, no en la de la organización. Si no, un consolidado de sucursales en husos distintos miente.", "venueName — 'Sucursal': ya
está resuelta en el mapa de :123 y se estampa en :189. Es la columna que PITS pidió textualmente ('filtrable por sucursal'). Default ON.",
"staffName — 'Usuario': 'Sistema' cuando staff es null.", "staffEmail — 'Correo del usuario': requiere ampliar el select de staff en
:163-165.", "action — 'Código de acción'", "actionLabel — 'Acción' (mismo mapa de etiquetas del backend que el listado por sucursal; una
sola fuente para ambos)", "entity — 'Entidad'", "entityId — 'ID de entidad'", "origen — 'Origen' (derivada de data.source +
data.terminalSerialNumber + data.method)", "ipAddress — 'Dirección IP' (misma salvedad de cobertura: 29/475 sitios)", "resumen — 'Detalle'
(data aplanado, profundidad 1, redactado, tope ~200 chars). Default ON.", "dataJson — 'Detalle técnico (JSON)' (redactado, default OFF,
nunca en PDF)", "userAgent — 'Dispositivo / navegador' (default OFF)", "id — 'Folio de bitácora' (default OFF)" ], "pantallaDashboard":
"/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard/src/pages/Organization/OrganizationActivityLog.tsx — botón en el
encabezado :166-169 (mismo tratamiento que la pantalla de sucursal). Reutiliza src/components/export-dialog.tsx. Servicio de front a
extender: src/services/organizationDashboard.service.ts (getOrgActivityLog / getOrgActivityLogActions).", "reusaFiltros": "El estado vive en
:100-104 (searchTerm, venueFilter, actionFilter, page) y se arma en el useMemo de :109-118. exportBaseParams debe espejar venueId, action y
search con los MISMOS nombres que ya manda el listado (verificado en la ruta, :1536-1548: venueId, staffId, action, entity, search,
startDate, endDate). ⚠️ ASIMETRÍA REAL: esta pantalla NO tiene filtro de fechas ni de usuario (a diferencia de la de sucursal), pero
ExportDialog SÍ impone un rango de fechas propio. Resultado: el archivo puede filtrar por un rango que la tabla nunca filtró. Es aceptable
(el diálogo es dueño del rango y así funciona en pagos/órdenes), pero el activeFilterSummary debe decirlo explícito, y el rango inicial del
diálogo debe sembrarse con algo acotado (últimos 30 días) o el primer clic pega contra el tope de 10 000 filas. Aplica la MISMA
normalización de .toISOString() → 'YYYY-MM-DD' del riesgo #4." } ], "riesgos": [ "🔴 PII / DESVÍO MÁS GRAVE: hoy la redacción de claves
sensibles es SÓLO DE CLIENTE y sólo en una de las dos pantallas. VenueActivityLog.tsx:44-56 define un regex
(pass/secret/token/api-key/authorization/cvv/clabe/pan/card-number/account-number/private-key) y lo aplica al pintar el jsonb (:405);
OrganizationActivityLog.tsx:364 hace JSON.stringify(log.data) CRUDO, sin ninguna redacción. Una exportación NO pasa por la UI: si se envía
`data` tal cual, se crea una fuga NUEVA (no heredada) de todo lo que 507 sitios de escritura hayan metido en ese jsonb, en un archivo que
sale por correo. NO NEGOCIABLE: la redacción se porta al BACKEND (una función compartida en el servicio de bitácora o en export.helpers) y
se aplica tanto a la columna 'resumen' como a 'dataJson'. Y el mismo regex debe seguir vigente en las dos pantallas. Precedente a favor: el
tool del MCP `get_activity_log` (src/mcp/tools/activity-log.ts:50-59) YA omite deliberadamente ipAddress y userAgent de su select.", "🔴 LA
COLUMNA 'DESDE DÓNDE' SALDRÍA CASI VACÍA — y es justo lo que promete la fila 28 de la matriz. Medido: sólo 29 de 475 sitios de logAction
mandan ipAddress y 23 mandan userAgent. De las SIETE rutas de acceso, sólo DOS la escriben: auth.service.ts:453 (dashboard con contraseña) y
auth.dashboard.controller.ts:802 (cierre de sesión de dashboard). Llegan con IP NULL: googleOAuth.service.ts:488 (SSO),
auth.mobile.service.ts:256 (passkey) y :621 (contraseña), auth.tpv.service.ts:180 (login por NIP en terminal) y :389 (logout de TPV). Si se
exporta así, el contralor recibe una columna 'Dirección IP' en blanco en ~5 de cada 7 renglones de acceso. Dos consecuencias: (a) la columna
derivada 'Origen' (data.source + data.terminalSerialNumber) NO es un adorno, es lo único que responde la pregunta hoy en TPV y móvil; (b)
hilar ipAddress/userAgent por esas 5 rutas es un PRE-REQUISITO barato de este mismo hito — el patrón ya existe (basta pasar req.ip y
req.get('user-agent') desde el controlador al servicio, como hace auth.service.ts). Exportar sin eso es entregar una columna que parece
mentir.", "🔴 VENUE EQUIVOCADO: el candado y la consulta miran venues DISTINTOS. checkPermission y checkFeatureAccess resuelven el venue con
resolveRequestVenueId (checkPermission.middleware.ts:39-46: param :venueId → header x-venue-id → JWT), pero el controlador consulta (req as
any).authContext.venueId (activityLog.dashboard.controller.ts:6, :26, :35), que se construye SÓLO del JWT
(authenticateToken.middleware.ts:65, buildAuthContextFromPayload — verificado que nunca lee req.params). Con la ruta
/venues/:venueId/activity-log y mergeParams:true, el param SIEMPRE está disponible. Escenario real: un OWNER con token de la sucursal A
navega a /venues/B/activity-log → el candado se evalúa contra B y los datos devueltos son de A. Si tiene activity:read en B pero no en A,
lee la bitácora de A sin permiso. El export DEBE usar resolveRequestVenueId(req, authContext) para quedar alineado con su propio candado; y
el listado vigente arrastra el mismo defecto (reportarlo aparte).", "🟠 FECHAS: la exportación introduce un bug de rango si se copia el
patrón a ciegas. ExportDialog manda siempre startDate/endDate como .toISOString() (export-dialog.tsx:108-114), mientras
queryVenueActivityLogs los mete en la plantilla fromZonedTime(`${startDate}T00:00:00.000`, venueTz) (activity-log.service.ts:268-269), que
espera 'YYYY-MM-DD' pelón. Un ISO completo produce '2026-08-07T00:00:00.000ZT00:00:00.000' → fecha inválida. El controlador de export debe
recortar a los primeros 10 caracteres antes de llamar al servicio. Aparte: el servicio de ORG (queryActivityLogs :152-153) todavía usa new
Date(params.startDate) — la trampa de tz documentada en critical-warnings.md, que en prod (Node en UTC) corre el día completo. Y en el
consolidado de organización el formateo de la celda debe usar el timezone DE CADA SUCURSAL, no uno solo: hoy el mapa de venues de :113-123
sólo trae {id,name}, hay que sumarle timezone.", "🟠 VOLUMEN: el tope de 10 000 filas se va a alcanzar y STAFF_LOGIN/LOGOUT es la razón. El
comentario de activity-log.service.ts:167-172 cita producción con 15 508 filas y grupos de empate de hasta 71 — pero esa medición es
ANTERIOR a que empezáramos a registrar accesos. Login/logout es por-persona × por-dispositivo × por-turno: una organización tipo PITS con
decenas de sucursales genera del orden de cientos a miles de renglones de acceso por día, y son los de MAYOR volumen de toda la tabla (la
propia pantalla ya los pinta en gris a propósito para que no compitan con las anomalías, OrganizationActivityLog.tsx:63-67). Un export
mensual a nivel organización pega contra el 413 casi seguro, y en PDF (tope 1 000) contra cualquier rango útil. Mitigación recomendada: una
casilla 'Excluir inicios y cierres de sesión' que se traduzca en un filtro excludeActions=STAFF_LOGIN,STAFF_LOGOUT — PERO tiene que
agregarse al LISTADO Y al export a la vez, o se rompe la regla de 'lo que exportas es lo que ves'. No lo pude medir contra la base de
producción (levantamiento de sólo lectura, sin ejecutar consultas): el 15 508 es lectura del comentario en código, no una medición mía de
hoy.", "🟡 ORDEN Y AUDITORÍA DEL PROPIO EXPORT. (a) orderBy: los dos listados YA son estables — [{createdAt:'desc'},{id:'desc'}] en :173 y
:279, con un comentario que explica que las escrituras en ráfaga producen createdAt idénticos y que sin desempate una página pierde filas en
silencio; el fetch del export debe reusar EXACTAMENTE esa tupla, y hay un test que lo protege
(tests/unit/services/dashboard/activity-log.pagination-stability.test.ts). Nota aparte: el tool del MCP src/mcp/tools/activity-log.ts:60
ordena sólo por createdAt, sin el desempate. (b) ActivityLog del export: la receta dice decidirlo explícito y aquí NO es opcional — una
descarga masiva de quién-hizo-qué con IPs es precisamente el evento que un auditor quiere ver registrado. Escribir ACTIVITY_LOG_EXPORTED con
{ alcance, formato, filas, filtros, columnas } DESPUÉS de pasar el 413 y con logAction fire-and-forget (nunca dentro de una transacción). Es
1 renglón por descarga: no es ruido. (c) MCP: no hace falta tool nuevo — get_activity_log ya cubre la lectura y una exportación es una
comodidad de UI, no una capacidad nueva." ], "esfuerzo": "DIAS" }, { "modulo": "INVENTARIO (existencias insumos + mercancía de reventa,
kardex, conteos físicos, lotes/caducidad, valorización)", "quePrometimos": "Fila 196 (7 Sistemas) — Función: \"Reportes para usuarios. La
plataforma permite exportar en archivos xls, csv, txt las bases de información.\" → contestada \"Cumplimiento en forma natural\" (=1) con el
comentario: \"Exportación de la información a XLS y CSV desde todos los reportes y listados del sistema.\" || Fila 93 (3 Operaciones
(Inventarios)) — \"El sistema podrá registrar y consultar el historial completo de entradas, salidas, transferencias, ajustes y mermas por
producto.\" → natural, comentario: \"Historial completo de entradas, salidas, traspasos, ajustes y mermas por producto, consultable y
exportable.\" || Fila 85 — reporte pedido: \"Movimientos de inventario / El sistema podra consultar el inventario disponible por tienda, SKU
en tiempo real.\" → natural: \"Consulta de existencias en tiempo real por producto y punto de venta, con historial completo de
movimientos.\" || Fila 95 — reporte pedido: \"Diferencias de inventario\" → natural: \"Captura de inventario físico y comparación contra el
inventario en sistema, con reporte de diferencias.\" || Fila 94 — \"El sistema podrá realizar el cálculo del valor económico del inventario
por tienda, familia y línea de negocio\" → natural: \"Valorización económica del inventario por tienda, familia y línea de negocio, con
costeo PEPS por lote.\" || Fila 4 (0 General) — natural: \"Reportes predefinidos, configurables y exportables (XLS/PDF/CSV) nativos.\" ||
CONTRASTE (lo único que SÍ marcamos como Desarrollo): Fila 250 y Fila 80 — lote/caducidad: \"Para insumos de restaurante y cafetería el
control de lote y caducidad es nativo y opera hoy... Para la MERCANCÍA DE REVENTA de las 18 tiendas extendemos el mismo control... Tiempo de
entrega: 2 a 3 días.\"", "queExisteHoy": "CERO exportación en todo el módulo de inventario. El barrido de rutas (`grep \"'/[^']*export'\"
src/routes/`) devuelve sólo 8 rutas /export en TODO el server y NINGUNA es de inventario: pagos (`src/routes/dashboard.routes.ts:3138`), órdenes (`:3175`), resumen de ventas (`src/routes/dashboard/reports.routes.ts:110-111`), y 4 de superadmin/org. `src/routes/dashboard/inventory.routes.ts`(1576 líneas, ~120 rutas) no tiene una sola ruta`/export`, y `export.helpers.ts`no se importa en ningún controlador de inventario.\n\nPEOR QUE \"no existe\": EXISTE UN BOTÓN \"Exportar\" QUE NO HACE NADA. En`avoqado-web-dashboard/src/pages/Inventory/InventorySummary.tsx:643-648` — la pantalla de aterrizaje del módulo (`/inventory/stock-overview`, `src/routes/venueRoutes.tsx:826-827`) — hay `<button
type=\"button\" className=\"...\">…<Download/>
Exportar</button>`SIN`onClick`. Al lado, otro botón \"Importar\" igual de muerto (`:635-641`). Un contralor de PITS abre Inventario, ve \"Exportar\", hace clic y no pasa absolutamente nada.\n\nEstado real de cada listado que un contralor exportaría:\n1) EXISTENCIAS DE INSUMOS — `getRawMaterials` (`src/services/dashboard/rawMaterial.service.ts:59-101`) sirve `GET
/inventory/raw-materials` (`inventory.routes.ts:131`). Trae todo sin paginar, `orderBy: { name: 'asc'
}`(:93) sin desempate. Es el único listado del módulo listo para exportar casi tal cual.\n2) EXISTENCIAS DE MERCANCÍA DE REVENTA — NO EXISTE SERVICIO. La pantalla`ProductStock.tsx:101-113`llama`getProducts(venueId)`→`GET
/venues/:venueId/products` (`dashboard.routes.ts:6951-6957`, permiso `menu:read`, NO `inventory:read`), que devuelve el catálogo COMPLETO con `include:
{ inventory: true }` (`src/services/dashboard/product.dashboard.service.ts:407-415`), y el filtro `trackInventory===true &&
inventoryMethod==='QUANTITY' &&
p.inventory` corre EN EL NAVEGADOR (`ProductStock.tsx:117-121`). Lo mismo en `InventorySummary.tsx:71-89`, que además fusiona insumos en cliente. No hay un `where`de servidor que se pueda reusar.\n3) KARDEX UNIFICADO —`getGlobalMovements` (`src/services/dashboard/productInventory.service.ts:185-327`) sirve `GET
/inventory/movements` (`inventory.routes.ts:1374`). Está roto para exportar: `take: limit _
page`(:239, :262), merge y paginación EN MEMORIA (:308-317), y`total: 1000, // Dummy
total`hardcodeado (:322). El propio código lo admite (:306-307: \"For large datasets this isn't efficient... Proper solution would be SQL UNION\"). Y la pantalla lo llama SIN filtros:`getGlobalMovements(venueId!,
{})` (`InventoryHistory.tsx:146-148`) → con `limit` default 50 (`src/schemas/dashboard/inventory.schema.ts:1037`), el \"historial completo\" que el contralor ve son los ÚLTIMOS 50 MOVIMIENTOS, y los filtros de la pantalla (fecha, tipo, SKU, proveedor) filtran sólo esas 50 filas. Además el payload no devuelve `supplier`ni`unitCost`(que SÍ existen en`schema.prisma:1702-1703`), así que la columna \"Proveedor\" (`InventoryHistory.tsx:405-410`) siempre sale \"Sin proveedor\".\n4) CONTEOS FÍSICOS — `listStockCounts` (`src/controllers/dashboard/inventory/stockCount.controller.ts:26-87`) sirve `/inventory/stock-counts` (`inventory.routes.ts:1415`). No hay servicio: el controlador llama `inventoryMobileService.getStockCounts(venueId)` (`src/services/mobile/inventory.mobile.service.ts:152-177`), que trae TODOS los conteos con TODOS sus items sin `take`, y luego filtra y pagina en memoria (:35-57). La lista sólo devuelve cabeceras (`:60-72`); el detalle línea-por-línea (expected/counted/difference) sólo se obtiene conteo por conteo en `/stock-counts/:countId` (`:1424`). SÍ cubre ambos mundos: `StockCountItem`tiene`productId`O`rawMaterialId` (`schema.prisma:2237-2244`).\n5) LOTES CON CADUCIDAD — no hay listado de venue. Sólo `getBatchesForRawMaterial(venueId,
rawMaterialId)` (`src/services/dashboard/fifoBatch.service.ts:533-579`, ruta `inventory.routes.ts:301`) y agregados en `getBatchStatistics` (`:882-914`, ruta `:308`). Y NINGUNA pantalla del dashboard consume lotes (`grep
-rln \"batches\"
src/pages/`→ sin resultados): las rutas existen y no hay UI.\n6) VALORIZACIÓN —`getInventoryValuation` (`src/services/dashboard/report.service.ts:427-513`, ruta `inventory.routes.ts:1086`) consulta ÚNICAMENTE `prisma.rawMaterial.findMany`(:434). No toca`Inventory`/`Product`.\n\nÚnico precedente de export en el vecindario: `PurchaseOrdersPage.tsx:430-458`arma un CSV a mano en el navegador con las filas de UNA orden (el 4º patrón que el levantamiento marca como \"el que NO se debe copiar\"), y`src/routes/dashboard/organizationStockControl.routes.ts:64` (`/stock-control/export.xlsx`, SIMs, org-level) que no usa `export.helpers.ts`.",     "listados": [       {         "nombre": "Existencias actuales de INSUMOS (RawMaterial)",         "servicioActual": "getRawMaterials — src/services/dashboard/rawMaterial.service.ts:59-101 (where inline :68-76, orderBy name asc :93, filtro lowStock en memoria :96-98). Sin paginar.",         "rutaActual": "GET /api/v1/dashboard/venues/:venueId/inventory/raw-materials — src/routes/dashboard/inventory.routes.ts:131-136",         "rutaExportPropuesta": "GET /api/v1/dashboard/venues/:venueId/inventory/raw-materials/export — VERIFICADO que no existe. 🔴 DEBE declararse ANTES de inventory.routes.ts:145 (`/raw-materials/:rawMaterialId`) o Express la traga como id (mismo tropiezo que /purchase-orders/stats, ya comentado en :297-299). Servicio: extraer buildRawMaterialsWhereClause + countRawMaterialsForExport + fetchRawMaterialsForExport en el MISMO rawMaterial.service.ts, y hacer que getRawMaterials use el where extraído (no dejar la copia inline). orderBy [{ name: 'asc' }, { id: 'asc' }].",         "permiso": "inventory:read — EXISTE. Deps: src/lib/permissions.ts:156-159. Catálogo INDIVIDUAL_PERMISSIONS_BY_RESOURCE: :1498. DEFAULT_PERMISSIONS: literal en MANAGER (:761), vía wildcard `inventory:_`en ADMIN (:907) y OWNER (:1014),`_:_`en SUPERADMIN. No hace falta permiso nuevo (mismo criterio que pagos/órdenes: quien ve la lista la exporta).",         "columnas": [           "sku → 'SKU'",           "name → 'Insumo'",           "category → 'Categoría'",           "currentStock → 'Existencia'",           "unit → 'Unidad'",           "minimumStock → 'Mínimo'",           "reorderPoint → 'Punto de reorden'",           "costPerUnit → 'Costo unitario'",           "avgCostPerUnit → 'Costo promedio (PEPS)'",           "valorInventario → 'Valor inventario' (currentStock × avgCostPerUnit, PESOS 1:1)",           "shelfLifeDays → 'Vida útil (días)'",           "bajoMinimo → 'Bajo mínimo' (Sí/No, derivado currentStock <= reorderPoint)",           "recetasQueLoUsan → 'Recetas que lo usan' (_count.recipeLines)",           "active → 'Activo'"         ],         "reusaFiltros": "El listado ya acepta category / lowStock / active / search validados por GetRawMaterialsQuerySchema (inventory.routes.ts:134). El export recibe LOS MISMOS nombres de query param y construye el mismo objeto de filtros; en el dashboard se espejan en`exportBaseParams`desde el estado de RawMaterials.tsx (FilterPill de categoría/stock, :57-62 imports) e InventorySummary.tsx. ⚠️`lowStock`hoy se aplica DESPUÉS del findMany (rawMaterial.service.ts:96-98): si se queda así, el pre-flight count NO puede usar el mismo where y el 413 mentiría — hay que bajarlo al where (currentStock <= reorderPoint no es expresable en Prisma con comparación entre columnas, así que va por $queryRaw o se cuenta el arreglo filtrado; decidirlo explícitamente, no heredarlo).",         "pantallaDashboard": "src/pages/Inventory/InventorySummary.tsx:643-648 — el botón 'Exportar' YA ESTÁ PINTADO Y ESTÁ MUERTO (sin onClick); ahí va el`onClick={()
=>
setExportOpen(true)}`. Alternativa/adicional: src/pages/Inventory/RawMaterials.tsx (barra de FilterPill, imports :60-63). NO hay componente de export reutilizable en /pages/Inventory: el reutilizable es src/components/export-dialog.tsx (381 líneas, usado hoy sólo por Payments.tsx y Orders.tsx) y ninguna pantalla de inventario lo importa (verificado: grep ExportDialog en src/pages/Inventory/ → 0 resultados)."       },       {         "nombre": "Existencias actuales de MERCANCÍA DE REVENTA (Product + Inventory) — 🔴 EL DE LAS 18 TIENDAS DE PITS",         "servicioActual": "NO EXISTE servicio de existencias de reventa. Se recicla el catálogo: getProducts — src/services/dashboard/product.dashboard.service.ts:389-449 (include inventory:true en :415, where sólo venueId + deletedAt + categoryId en :408-412). El filtro que define 'esto es una existencia' vive en el navegador: src/pages/Inventory/ProductStock.tsx:117-121 (trackInventory===true && inventoryMethod==='QUANTITY' && p.inventory) y el mapeo de stock en :123-134.",         "rutaActual": "GET /api/v1/dashboard/venues/:venueId/products — src/routes/dashboard.routes.ts:6951-6957 (permiso `menu:read`, NO `inventory:read`; sin paginación)",         "rutaExportPropuesta": "GET /api/v1/dashboard/venues/:venueId/inventory/product-stock/export — VERIFICADO que no existe. Usar el segmento nuevo `product-stock`(NO`/products/export`): bajo /inventory ya viven `/products/:productId/...`(inventory.routes.ts:339, 1201, 1253, 1268) y`/products/export`chocaría con`:productId`. Colgarla junto al bloque PRODUCT INVENTORY (inventory.routes.ts:1241-1273). 🔴 REQUIERE ESCRIBIR SERVICIO NUEVO en src/services/dashboard/productInventory.service.ts: buildProductStockWhereClause({ venueId, trackInventory: true, inventoryMethod: 'QUANTITY', inventory: { isNot: null }, deletedAt: null }) + countProductStockForExport + fetchProductStockForExport, con orderBy [{ name: 'asc' }, { id: 'asc' }]. Y ProductStock.tsx debe migrar a consumirlo, o el archivo y la pantalla divergirán desde el día 1.",         "permiso": "inventory:read (mismo que arriba; existe). ⚠️ Ojo a la incoherencia heredada: la PANTALLA se sirve hoy con `menu:read`(dashboard.routes.ts:6954) pero la ruta del dashboard está protegida por`inventory:read`(src/routes/venueRoutes.tsx:818). El export debe ir con`inventory:read`, que es el candado del módulo.",         "columnas": [           "sku → 'SKU'",           "gtin → 'Código de barras'",           "name → 'Producto'",           "categoryName → 'Categoría'",           "currentStock → 'Existencia'",           "unit → 'Unidad'",           "minimumStock → 'Mínimo'",           "maximumStock → 'Máximo'",           "reservedStock → 'Reservado'",           "cost → 'Costo unitario'",           "price → 'Precio de venta'",           "valorInventario → 'Valor inventario' (currentStock × cost, PESOS 1:1)",           "bajoMinimo → 'Bajo mínimo' (Sí/No)",           "lastRestockedAt → 'Última reposición' (venue-local)",           "lastCountedAt → 'Último conteo' (venue-local)",           "active → 'Activo'"         ],         "reusaFiltros": "Hoy NO hay filtros de servidor que reusar — búsqueda y 'sólo bajo mínimo' son estado local de ProductStock.tsx:135-143. Al crear el servicio hay que definir los query params (search, categoryId, lowStock, active) con LOS MISMOS nombres en listado y export, y hacer que la pantalla los mande al servidor; si no, el export exportará TODO mientras el usuario ve una tabla filtrada — exactamente la divergencia que ya sufren pagos (rama MindForm) y órdenes (updatedAt vs createdAt).",         "pantallaDashboard": "src/pages/Inventory/ProductStock.tsx (ruta `/inventory/product-stock`, src/routes/venueRoutes.tsx:850) — hoy NO tiene ningún botón de exportar. Y src/pages/Inventory/InventorySummary.tsx:643-648 (el botón muerto), que es la pantalla que mezcla productos + insumos y por tanto la que el contralor usará primero. Reutilizable disponible: src/components/export-dialog.tsx (props endpoint/baseParams/columns/filenameStem)."       },       {         "nombre": "Movimientos / Kardex unificado (RawMaterialMovement + InventoryMovement)",         "servicioActual": "getGlobalMovements — src/services/dashboard/productInventory.service.ts:185-327. 🔴 INSERVIBLE PARA EXPORTAR TAL CUAL: take: limit*page (:239, :262), merge+paginado en memoria (:308-317), `total:
1000, // Dummy
total`(:322), orderBy createdAt desc sin desempate, y no devuelve`supplier`ni`unitCost`aunque existen en schema.prisma:1702-1703.",         "rutaActual": "GET /api/v1/dashboard/venues/:venueId/inventory/movements — src/routes/dashboard/inventory.routes.ts:1374-1379 (schema GetGlobalMovementsQuerySchema, src/schemas/dashboard/inventory.schema.ts:1034-1043)",         "rutaExportPropuesta": "GET /api/v1/dashboard/venues/:venueId/inventory/movements/export — VERIFICADO que no existe.`/movements`es estática y no hay`/movements/:id`, así que basta declararla inmediatamente encima de inventory.routes.ts:1374. 🔴 NO reusar getGlobalMovements: escribir buildProductMovementsWhere + buildRawMaterialMovementsWhere y DOS count() reales sumados para el pre-flight (o un $queryRaw UNION ALL con ORDER BY createdAt DESC, id DESC y LIMIT), y traer las filas por separado con take:cap cada una antes de fusionar. Sin esto el 413 nunca dispara y el CSV sale truncado en silencio.",         "permiso": "inventory:read — existe (src/lib/permissions.ts:156, catálogo :1498, MANAGER+ / ADMIN+OWNER por wildcard). Es el mismo que ya usa el listado (inventory.routes.ts:1376).",         "columnas": [           "createdAt → 'Fecha y hora' (🔴 venue-local con formatInTimeZone(venue.timezone), NO toISOString: esto se lee como kardex fiscal)",           "origen → 'Tipo de artículo' (Insumo / Mercancía de reventa)",           "sku → 'SKU'",           "itemName → 'Artículo'",           "type → 'Tipo de movimiento' (Compra/Venta/Ajuste/Merma/Traspaso/Conteo/Devolución — traducir el enum, no volcarlo crudo)",           "quantity → 'Cantidad'",           "unit → 'Unidad'",           "previousStock → 'Existencia anterior'",           "newStock → 'Existencia nueva'",           "unitCost → 'Costo unitario del movimiento' (InventoryMovement.unitCost / batch.costPerUnit — NO el costo actual del producto, que es lo que devuelve hoy productInventory.service.ts:278)",           "costImpact → 'Impacto en costo'",           "batchNumber → 'Lote'",           "reason → 'Motivo'",           "reference → 'Referencia'",           "supplier → 'Proveedor' (InventoryMovement.supplier, schema.prisma:1703)",           "createdByName → 'Usuario' (🔴 resolver el Staff: createdBy es un String suelto sin relación, schema.prisma:1704 y :2166 — exportar el cuid no sirve a contraloría)"         ],         "reusaFiltros": "El listado ya define startDate/endDate/search/type en GetGlobalMovementsQuerySchema (inventory.schema.ts:1034-1043); el export debe aceptar exactamente esos nombres. ⚠️ DOS trampas verificadas: (a) la pantalla InventoryHistory.tsx:146-148 llama con `{}`y filtra en cliente sobre 50 filas — hay que subir esos filtros al servidor ANTES de colgar el export, o el archivo no será 'lo que se ve'; (b) el enum`type`del schema (ALL/RECEIVED/COUNT/WASTE/RETURN/SALE/TRANSFER) NO coincide con los enums de Prisma MovementType (schema.prisma:7091-7098: PURCHASE/SALE/ADJUSTMENT/LOSS/TRANSFER/COUNT) ni RawMaterialMovementType (:8403-8413: PURCHASE/USAGE/ADJUSTMENT/SPOILAGE/TRANSFER/TRANSFER_OUT/TRANSFER_IN/COUNT/RETURN): sólo 'RECEIVED' está mapeado a mano (productInventory.service.ts:227-229) y 'WASTE' no existe en ningún enum. NO verifiqué en runtime qué hace Prisma con`{
type: 'WASTE'
}`; hay que revisar ese mapeo antes de exportar por tipo, porque 'merma' es justo lo que la matriz promete (filas 90 y 93).",         "pantallaDashboard": "src/pages/Inventory/InventoryHistory.tsx (ruta `/inventory/history`, src/routes/venueRoutes.tsx:829). Hoy tiene FilterPill + ColumnCustomizer (:20-23) y CERO botón de exportar. El picker de columnas ya define los ids visibles en :141 y :487-492 — reusar esos ids como los del backend. Reutilizable: src/components/export-dialog.tsx."       },       {         "nombre": "Conteos físicos y diferencias de inventario (StockCount / StockCountItem)",         "servicioActual": "No hay servicio de dashboard: la lógica está inline en el controlador — listStockCounts, src/controllers/dashboard/inventory/stockCount.controller.ts:26-87, que llama getStockCounts (src/services/mobile/inventory.mobile.service.ts:152-177, findMany SIN take con todos los items incluidos) y filtra+pagina EN MEMORIA (:35-57). El detalle por línea sólo sale de getStockCount (:94-115).",         "rutaActual": "GET /api/v1/dashboard/venues/:venueId/inventory/stock-counts — src/routes/dashboard/inventory.routes.ts:1415 (y el detalle en :1424)",         "rutaExportPropuesta": "GET /api/v1/dashboard/venues/:venueId/inventory/stock-counts/export — VERIFICADO que no existe. 🔴 DEBE ir ANTES de inventory.routes.ts:1424 (`/stock-counts/:countId`). Proponer `?level=detail|header`(default`detail`): la matriz pide 'Diferencias de inventario' (fila 95), o sea LÍNEAS, no cabeceras. El nivel `detail`requiere una query nueva sobre`stockCountItem`(where: { stockCount: { venueId, ...filtros } }) — NO reusar getStockCounts, que carga todos los conteos con todos sus items en memoria. orderBy [{ stockCount: { createdAt: 'desc' } }, { id: 'asc' }].",         "permiso": "inventory:read — existe y es el que ya usa la ruta (inventory.routes.ts:1415). ⚠️ Nota: la matriz (fila 88) dice 'Solo se realizará ajustes por el área de contraloría'; el candado de AJUSTE es`inventory:adjust`(permissions.ts:162), pero LEER/exportar conteos es`inventory:read`. No confundirlos.",         "columnas": [           "countNumber → 'Folio de conteo' (hoy sólo hay `id`cuid — decidir si se expone el id o se agrega folio)",           "createdAt → 'Fecha del conteo' (venue-local)",           "type → 'Tipo' (Cíclico / Total)",           "status → 'Estatus' (En progreso / Completado)",           "createdByName → 'Capturó' (StockCount.createdByUser SÍ es relación a Staff, schema.prisma:2220-2221 — aquí sí hay nombre)",           "note → 'Nota'",           "itemType → 'Tipo de artículo' (Insumo / Mercancía de reventa)",           "sku → 'SKU'",           "itemName → 'Artículo'",           "unit → 'Unidad'",           "expected → 'Existencia en sistema'",           "counted → 'Contado físico'",           "difference → 'Diferencia' (counted - expected)",           "valorDiferencia → 'Valor de la diferencia' (difference × costo, PESOS 1:1)",           "countedAt → 'Fecha de captura de la línea' (venue-local; null = línea no tocada)",           "completedAt → 'Fecha de cierre' (venue-local)"         ],         "reusaFiltros": "El listado ya acepta status / type / startDate / endDate / page / pageSize (documentados en inventory.routes.ts:1395-1414 y leídos en stockCount.controller.ts:29). El export recibe los mismos nombres. ⚠️ Dos cosas verificadas que hay que arreglar al pasarlos al where: (a) hoy se filtran en memoria sobre`new
Date(startDate)`y`end.setHours(23,59,59,999)`(:43-49) — eso es hora del HOST (prod corre en UTC), no venue-local; usar parseDbDateRange(from, to, venue.timezone) o venueStartOfDay/venueEndOfDay; (b) la pantalla StockCountsPage.tsx:50 ya mete statusFilter y typeFilter en el queryKey, así que espejarlos en`exportBaseParams`es directo.",         "pantallaDashboard": "src/pages/Inventory/StockCounts/StockCountsPage.tsx (ruta`/inventory/stock-counts`, src/routes/venueRoutes.tsx:831). Sin botón de exportar hoy. Reutilizable: src/components/export-dialog.tsx (no usado aún por ninguna pantalla de inventario)."       },       {         "nombre": "Lotes con caducidad (StockBatch) — ⚠️ SÓLO INSUMOS, IMPOSIBLE HOY PARA MERCANCÍA DE REVENTA",         "servicioActual": "getBatchesForRawMaterial — src/services/dashboard/fifoBatch.service.ts:533-579 (POR INSUMO, no por venue; ya trae desempate correcto orderBy [receivedDate asc, id asc] :549-555). Agregados: getBatchStatistics :882-914. NO existe una función que liste los lotes de un venue.",         "rutaActual": "GET /api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/batches — src/routes/dashboard/inventory.routes.ts:301-306. NO existe `GET
/batches`(sólo`/batches/stats`:308 y`/batches/:batchId`:310). Y NINGUNA pantalla del dashboard consume lotes:`grep -rln batches
src/pages/` → 0 resultados. Las rutas están vivas y no hay UI.",         "rutaExportPropuesta": "GET /api/v1/dashboard/venues/:venueId/inventory/batches/export — VERIFICADO que no existe. 🔴 DEBE declararse ANTES de inventory.routes.ts:310 (`/batches/:batchId`); el propio archivo ya avisa de esta trampa en :297-299 por `/batches/stats`. Requiere ESCRIBIR buildBatchesWhereClause(venueId, { status, rawMaterialId, expiringInDays, includeDepleted }) + count + fetch en fifoBatch.service.ts, con orderBy [{ expirationDate: 'asc' }, { id: 'asc' }] (para 'próximos a vencer', fila 81 de la matriz). Recomendable exponer también el listado (no sólo el export) o el botón exportará algo que el usuario nunca vio.",         "permiso": "inventory:read — existe y es el que ya usan las rutas de lotes (inventory.routes.ts:303, :308, :310). Las mutaciones de lote (quarantine/release) van con `inventory:adjust`(:316, :323), que también existe (permissions.ts:162, catálogo :1498, MANAGER :765 / ADMIN·OWNER wildcard). Para exportar basta`inventory:read`.",         "columnas": [           "batchNumber → 'Lote'",           "sku → 'SKU del insumo'",           "rawMaterialName → 'Insumo'",           "receivedDate → 'Fecha de recepción' (venue-local)",           "expirationDate → 'Caducidad' (venue-local)",           "diasParaCaducar → 'Días para caducar' (derivado)",           "status → 'Estatus' (Activo / Agotado / Caducado / En cuarentena)",           "initialQuantity → 'Cantidad inicial'",           "remainingQuantity → 'Cantidad restante'",           "unit → 'Unidad'",           "costPerUnit → 'Costo unitario del lote' (PESOS 1:1, Decimal(10,4))",           "valorRemanente → 'Valor restante' (remainingQuantity × costPerUnit)",           "purchaseOrderNumber → 'Orden de compra' (purchaseOrderItem.purchaseOrder.orderNumber, ya viene en el include :565-574)",           "depletedAt → 'Fecha de agotamiento' (venue-local)"         ],         "reusaFiltros": "No hay filtros vigentes que reusar: hoy el único consumidor es por-insumo con `status`e`includeExpired`(fifoBatch.service.ts:536-539) y no hay pantalla. Al crear el listado de venue hay que definir status / rawMaterialId / expiringInDays / includeDepleted con los MISMOS nombres en listado y export desde el principio, y sembrarlos en`exportBaseParams`.",         "pantallaDashboard": "NO EXISTE PANTALLA DE LOTES. Hay que crearla (p. ej. tab `/inventory/batches`en src/routes/venueRoutes.tsx, junto a :828 raw-materials) o, como mínimo, colgar el botón en src/pages/Inventory/RawMaterials.tsx. Reutilizable: src/components/export-dialog.tsx. 🔴 ADVERTENCIA PARA PITS:`StockBatch`sólo tiene`rawMaterialId`(schema.prisma:2273-2274) — NO tiene`productId`. La mercancía de reventa NO PUEDE tener lote ni caducidad hoy. Este export cubre insumos de cafetería/restaurante y devolverá 0 filas en las 18 tiendas de conveniencia hasta que se entregue lo que contestamos como Desarrollo en las filas 80 y 250."       },       {         "nombre": "Valorización de inventario (reporte, fila 94)",         "servicioActual": "getInventoryValuation — src/services/dashboard/report.service.ts:427-513. 🔴 Consulta ÚNICAMENTE prisma.rawMaterial.findMany (:434-451). No toca Inventory/Product. Ordena en memoria (:506) y el `hasMore`es una heurística (:510).",         "rutaActual": "GET /api/v1/dashboard/venues/:venueId/inventory/reports/valuation — src/routes/dashboard/inventory.routes.ts:1086",         "rutaExportPropuesta": "GET /api/v1/dashboard/venues/:venueId/inventory/reports/valuation/export — VERIFICADO que no existe.`/reports/valuation`es estática y no hay`/reports/:id`, así que basta declararla encima de inventory.routes.ts:1086. 🔴 ANTES de exportarlo hay que EXTENDER getInventoryValuation a Product+Inventory: exportar hoy la valorización sería entregar a contraloría un archivo que dice que 18 tiendas de conveniencia valen ~$0. Patrón del modo `summary` de ventas (src/controllers/dashboard/sales-summary.dashboard.controller.ts:341-343): reusar el MISMO servicio del reporte y aplanarlo con un flattenValuationForExport, para que el archivo no pueda diferir de la pantalla.",         "permiso": "inventory:read — existe y es el que ya usa la ruta (inventory.routes.ts:1086).",         "columnas": [           "sku → 'SKU'",           "name → 'Artículo'",           "origen → 'Tipo' (Insumo / Mercancía de reventa)",           "category → 'Categoría'",           "currentStock → 'Existencia'",           "unit → 'Unidad'",           "costPerUnit → 'Costo actual' (PESOS 1:1)",           "avgCostPerUnit → 'Costo promedio (PEPS)'",           "currentValue → 'Valor a costo actual'",           "avgValue → 'Valor a costo promedio'",           "valueDifference → 'Diferencia de valuación'",           "porcentajeDelTotal → '% del inventario'"         ],         "reusaFiltros": "El servicio hoy sólo acepta limit/offset (report.service.ts:429-432) y la ruta no valida nada (inventory.routes.ts:1086, sin validateRequest). Es una foto 'a hoy' (`asOf:
new
Date()`, :498), no un rango. Si se le agrega filtro por categoría/tipo, mismos nombres en listado y export. NO inventarle un rango de fechas: la valorización es puntual y prometer 'al corte X' sin costeo histórico sería otro renglón que no cumple.",         "pantallaDashboard": "No verifiqué qué pantalla consume /reports/valuation (no la encontré entre las páginas de /pages/Inventory/; puede estar en Profitability.tsx o no tener consumidor). El botón natural es src/pages/Inventory/InventorySummary.tsx:643-648 (el botón 'Exportar' muerto), que es donde el contralor espera el valor del inventario. Reutilizable: src/components/export-dialog.tsx."       }     ],     "riesgos": [       "🔴 EL RIESGO QUE MATA EL RENGLÓN — 'parece que funciona y está incompleta': tres de los seis listados son estructural o efectivamente CIEGOS a la mercancía de reventa, que es el 100% del negocio de las 18 tiendas de PITS. (a) LOTES/CADUCIDAD: `StockBatch`sólo tiene`rawMaterialId`(prisma/schema.prisma:2273-2274), no hay`productId`— es imposible hoy, y es justo lo que contestamos como Desarrollo en las filas 80 y 250; (b) VALORIZACIÓN:`getInventoryValuation`sólo consulta rawMaterial (src/services/dashboard/report.service.ts:434) → una tienda de conveniencia valuaría ~$0; (c) EXISTENCIAS DE REVENTA: no hay servicio, el filtro vive en el navegador (src/pages/Inventory/ProductStock.tsx:117-121). Si se conectan los exports 'baratos' (insumos y kardex) sin tocar estos tres, PITS recibe archivos que abren bien y mienten. Recomendación explícita: NO entregar el export de lotes ni el de valorización hasta que cubran Product/Inventory, o etiquetarlos en la UI como 'sólo insumos'.",       "🔴 AISLAMIENTO MULTI-TENANT —`InventoryMovement`NO tiene`venueId`(prisma/schema.prisma:1673-1711): el único camino al tenant es la relación`inventory.venueId`, como hace productInventory.service.ts:214-223. Cualquier `buildXWhereClause`nuevo del kardex que olvide anidar`inventory:
{ venueId
}`cruza venues en silencio y el archivo saldría con existencias de otro cliente.`RawMaterialMovement`sí tiene venueId (:2145) — la asimetría es la trampa. Igual`StockCountItem`: el filtro va por `stockCount:
{ venueId
}`(:2231-2233), el item no lo tiene.",       "🔴 VOLUMEN / TIMEOUT / OOM — ninguno de los servicios actuales soporta un pre-flight count honesto.`getGlobalMovements`devuelve`total:
1000, // Dummy total`(productInventory.service.ts:322), pagina en memoria (:308-317) y limita con`take: limit _
page`(:239, :262);`getStockCounts`trae TODOS los conteos con TODOS sus items sin`take`(src/services/mobile/inventory.mobile.service.ts:153-165) y el controlador filtra y pagina después (stockCount.controller.ts:35-57);`getRawMaterials`y`getInventoryValuation`no paginan. Reusarlos para exportar salta el 413 (que nunca dispararía) y trunca en silencio. Con el historial de OOM en Render (memoria oom-render-analytics-512mb) y 18 tiendas × meses de kardex, un export sin count real y sin`take:
cap`es un incidente de producción, no una molestia.",       "🔴 orderBy NO ÚNICO = FILAS PERDIDAS EN SILENCIO —`getGlobalMovements`ordena sólo por`createdAt:
'desc'`(productInventory.service.ts:238, :261) y los movimientos de una recepción o de un conteo se escriben en el MISMO instante en lote, así que hay empates masivos: con`take:
cap`el corte es no determinista.`getRawMaterials`ordena sólo por`name:
'asc'`(rawMaterial.service.ts:93) y`getInventoryValuation`ordena en memoria (report.service.ts:506). El único que ya lo hace bien es`getBatchesForRawMaterial`(fifoBatch.service.ts:549-555, con desempate por id y el comentario que explica por qué). Todo fetch de export debe llevar desempate por`id`.",       "🟠 PII / TRAZABILIDAD DEL ACTOR y FECHAS — `InventoryMovement.createdBy`(schema.prisma:1704) y`RawMaterialMovement.createdBy`(:2166) son String sueltos SIN relación a Staff: la columna 'Usuario' exportaría un cuid, y la matriz promete explícitamente motivo+usuario (fila 88: 'ajustes... con motivo, usuario y trazabilidad'; fila 90: 'con motivo (daño, caducidad, desperdicio), usuario responsable'). Hay que resolver los nombres con un lookup por lote. Y las fechas: los tres exports vivos emiten`toISOString()`(UTC crudo) — para un kardex que contraloría abre como bitácora fiscal eso corre las ventas de las 20:30 al día siguiente. Usar formatInTimeZone(venue.timezone) y parseDbDateRange para los filtros; hoy stockCount.controller.ts:43-49 parsea con`new
Date(startDate)`+`setHours`= hora del HOST, y prod corre en UTC.",       "🟠 GATE PREMIUM Y AUSENCIA DE AUDITORÍA — todo el router de inventario está bajo`router.use(checkFeatureAccess('INVENTORY*TRACKING'))`(src/routes/dashboard/inventory.routes.ts:108), que es PREMIUM: cualquier ruta /export nueva nace con 403 si el venue de PITS no tiene el feature — hay que confirmar el tier ANTES de construir, no después. Y: ninguno de los tres exports existentes escribe`ActivityLog`, sólo `logger.info`— descarga masiva de existencias, costos y kardex de 18 tiendas sin rastro auditable. Para un módulo de contraloría es una decisión que hay que tomar explícitamente (la regla de ActivityLog del repo aplica a mutaciones, no a lecturas, así que aquí es criterio, no obligación — pero heredarlo por omisión en el módulo que PITS va a auditar es la peor forma de decidirlo)."     ],     "esfuerzo": "SEMANA"   },   {     "modulo": "COMPRAS (órdenes de compra, renglones, recepciones, proveedores y precios por proveedor)",     "quePrometimos": "Matriz PITS, hoja \"2. Matriz de Requerimientos\". Fila 196 (área \"7 Sistemas\", marcada \"Cumplimiento en forma natural\") — requerimiento: «Reportes para usuarios. La plataforma permite exportar en archivos xls, csv, txt las bases de información.»; contestamos: «Exportación de la información a XLS y CSV desde todos los reportes y listados del sistema.» — Fila 4 (\"0 General\", natural): «Reportes predefinidos, configurables y exportables (XLS/PDF/CSV) nativos.» — Fila 75 (\"3 Operaciones (Recibo)\", natural), columna Reportes: «El sistema deberá generar un reporte detallado de las recepciones con filtros por fecha, tienda, proveedor, orden de compra y usuario, permitiendo visualizar diferencias, exportar la información (Excel y PDF) e imprimirla.»; contestamos: «Recepción de mercancía asociada a la orden de compra, con reporte filtrable por fecha, tienda, proveedor, OC y usuario, exportable a Excel y PDF.» — Fila 58 (\"2 Compras\", natural), Reportes: «Compras en el periodo, Gastos». Fila 59 (natural), Reportes: «Reporte de OC en proceso». Fila 77 (natural): «Reporte de faltantes, sobrantes y productos no solicitados.» Fila 78 (natural): «Órdenes pendientes por recibir / Fille rate». Fila 79 (natural): «Reporte de faltantes, sobrantes y rechazos». Fila 56 (\"2 Compras\", marcada DESARROLLO, no H0): expediente digital de proveedor «Consultable desde la ficha del proveedor y exportable.»",     "queExisteHoy": "CERO exportación en todo el namespace de compras/inventario. Verificado:`grep
-rn \"/export\"
src/routes/` sólo devuelve pagos (`src/routes/dashboard.routes.ts:3138`), órdenes de venta (`:3175`), resumen de ventas (`src/routes/dashboard/reports.routes.ts:110-111`), stock control PlayTelecom (`src/routes/dashboard/organizationStockControl.routes.ts:64`), reporte de cierre org (`src/routes/dashboard/organizationDashboard.routes.ts:1469`) y superadmin profit (`src/routes/dashboard/superadmin.routes.ts:382`). En `src/routes/dashboard/inventory.routes.ts`(1576 líneas, 130+ rutas) NO hay una sola ruta`/export`. Lo único descargable de compras hoy es el PDF de UNA orden individual: `GET
/purchase-orders/:purchaseOrderId/pdf` (`inventory.routes.ts:914`→`purchaseOrder.service.ts:2224
generatePurchaseOrderPDF`), y en el dashboard `PurchaseOrdersPage.tsx:407-416
handleSaveAsPDF` (una orden a la vez, sin filtros, sin CSV/XLSX). El helper genérico existe y está completo (`src/services/dashboard/export.helpers.ts:12-13,177,193,205,212,226`) y el diálogo reutilizable también (`avoqado-web-dashboard/src/components/export-dialog.tsx:28-48`); ninguno de los dos está referenciado desde compras. Servicios de listado que SÍ existen y sirven de base: `getPurchaseOrders` (`src/services/dashboard/purchaseOrder.service.ts:442`, where inline `:451-457`, include con items+rawMaterial+product `:461-495`, orderBy `:496-498`) y `getSuppliers` (`src/services/dashboard/supplier.service.ts:11`, where `:19-31`, orderBy `:64`). NO existe servicio, ruta ni pantalla de RECEPCIONES: la evidencia de recepción está dispersa en `PurchaseOrder.receivedDate/receivedBy` (`prisma/schema.prisma:1968,1988`), `PurchaseOrderItem.quantityReceived/receiveStatus` (`:2049,2060`), `StockBatch` (`:2272-2315`, con `purchaseOrderItemId` `:2280`) y `InventoryMovement.purchaseOrderItemId/createdBy` (`:1696,1703`). Tampoco existe listado de `SupplierPricing`a nivel venue: sólo`getSupplierPricingHistory(venueId,
rawMaterialId)` (`supplier.service.ts:280`), por insumo, y sin pantalla propia (sólo embebido en `RawMaterialDialog.tsx:259`). Todo el router de inventario ya está tras `checkFeatureAccess('INVENTORY_TRACKING')` (`inventory.routes.ts:108`)
= PREMIUM, así que cualquier /export hereda ese gate y su contrato 403 sin código extra.", "listados": [ { "nombre": "Órdenes de compra —
fila por ORDEN (gasto)", "servicioActual": "getPurchaseOrders — src/services/dashboard/purchaseOrder.service.ts:442 (where inline :451-457;
orderBy :496-498; sin paginación, devuelve TODAS las órdenes con TODOS sus renglones)", "rutaActual": "GET
/api/v1/dashboard/venues/:venueId/inventory/purchase-orders — src/routes/dashboard/inventory.routes.ts:685-690", "rutaExportPropuesta": "GET
/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/export?granularity=order (default). VERIFICADO que NO existe. Insertar entre
inventory.routes.ts:703 (/purchase-orders/stats) y :712 (/purchase-orders/:purchaseOrderId) — el comentario de :699-702 documenta que esa
ruta dinámica ya mató a /stats una vez. Servicio nuevo en el MISMO archivo: buildPurchaseOrdersWhereClause + countPurchaseOrdersForExport +
fetchPurchaseOrdersForExport, con getPurchaseOrders llamando también al build (no dejar la copia inline, que es la deuda D3 del patrón).",
"permiso": "inventory:read — EXISTE. Catálogo: src/lib/permissions.ts:1498 (INDIVIDUAL_PERMISSIONS_BY_RESOURCE). Dependencias: :156-159.
Defaults: MANAGER :761, ADMIN via 'inventory:*' :907, OWNER via 'inventory:_' :1014, SUPERADMIN '_:_'. Mismo permiso que el listado (quien
ve la lista la exporta), igual que payments:read/orders:read. NO crear 'inventory:export': nacería sin defaults y el audit lo marcaría
PHANTOM. ⚠️ VIEWER (:561-580) y CASHIER NO tienen inventory:read: un contralor con rol VIEWER no podrá exportar; hay que darle MANAGER o un
rol custom con inventory:read (es asignable individualmente porque está en el catálogo).", "columnas": [ "orderNumber → Folio", "orderDate →
Fecha de orden", "supplierName → Proveedor", "supplierTaxId → RFC del proveedor", "status → Estatus", "expectedDeliveryDate → Entrega
comprometida", "receivedDate → Fecha de recepción", "itemsCount → Renglones", "subtotal → Subtotal", "taxRate → Tasa de IVA", "taxAmount →
IVA", "commission → Comisión / otros cargos", "total → Total", "createdByName → Capturó", "approvedByName → Autorizó", "approvedAt → Fecha
de autorización", "rejectedByName → Rechazó", "rejectionReason → Motivo de rechazo", "autoGenerated → Generada automáticamente", "notes →
Notas" ], "pantallaDashboard": "avoqado-web-dashboard/src/pages/Inventory/PurchaseOrders/PurchaseOrdersPage.tsx:681 — el botón va junto a
<Button onClick={handleCreateClick} data-tour=\"po-new-btn\"> dentro del bloque de header :673-685, como DropdownMenu con dos entradas
(Exportar órdenes / Exportar renglones). SÍ hay componente reutilizable: src/components/export-dialog.tsx:28-48 (ExportDialog), el mismo que
usan Payments.tsx y Orders.tsx; ambas entradas abren ese mismo diálogo cambiando columns, filenameStem y baseParams.granularity — cero
cambios al componente.", "reusaFiltros": "🔴 ES EL PUNTO MÁS CARO Y NO ES GRATIS. Hoy la pantalla manda al backend SÓLO `status`
(PurchaseOrdersPage.tsx:111-116; también manda `search` pero el backend lo tira: GetPurchaseOrdersQuerySchema no lo declara,
inventory.schema.ts:480-488, y el servicio no lo usa). TODO lo demás se filtra en memoria en el cliente: búsqueda general (:137-147), número
de orden (:150-154), proveedor (:157-159), fecha de orden y fecha de entrega con operadores last/before/after/between/on (:162-266), rango
de total (:269-277) y rango de renglones (:280-287). Si el /export sólo acepta status+fechas, el archivo traerá órdenes que el usuario ya
había descartado en pantalla — exactamente el defecto que pagos tiene hoy con la fusión legacy de MindForm. Por eso el where compartido debe
aceptar: status[], supplierIds[], orderNumber, search, startDate/endDate (sobre orderDate), expectedFrom/expectedTo, totalMin/totalMax,
itemsMin/itemsMax; y la pantalla debe SUBIR esos filtros al backend en el mismo cambio (el useMemo de :133-289 se reduce a nada).
ExportDialog aplana baseParams y siempre sobrescribe startDate/endDate con su propio picker (export-dialog.tsx:108-114), así que el pill de
fecha de la pantalla se traduce a un rango concreto al armar baseParams." }, { "nombre": "Renglones de órdenes de compra — fila por RENGLÓN
(cotejo contra factura)", "servicioActual": "getPurchaseOrders — src/services/dashboard/purchaseOrder.service.ts:442; el include ya trae
items con rawMaterial y product (:471-494), así que el renglón sale del MISMO fetch, sólo cambia el aplanado. No hay servicio propio de
renglones.", "rutaActual": "Ninguna propia. Los renglones se ven en GET /purchase-orders (inventory.routes.ts:685) y en el detalle GET
/purchase-orders/:purchaseOrderId (:712).", "rutaExportPropuesta": "GET
/api/v1/dashboard/venues/:venueId/inventory/purchase-orders/export?granularity=item — MISMA ruta que la anterior, con branch en el
controlador. Es el precedente exacto de sales-summary, que resuelve modo `summary` vs `detailed` en UNA función y UNA ruta
(src/controllers/dashboard/sales-summary.dashboard.controller.ts:177-366). Dos granularidades = dos registries de columnas y dos tipos de
fila, pero un solo pre-flight/413 y un solo where. Validar `granularity` contra whitelist ['order','item'] con default 'order' (NO usar
parseFormatParam-style silencioso para esto: un valor raro debe ser 400 con mensaje en español).", "permiso": "inventory:read — mismo que
arriba (src/lib/permissions.ts:1498, defaults MANAGER :761 / ADMIN :907 / OWNER :1014). No requiere permiso adicional: el renglón ya es
visible en el detalle con inventory:read.", "columnas": [ "orderNumber → Folio", "orderDate → Fecha de orden", "supplierName → Proveedor",
"status → Estatus de la orden", "itemType → Tipo (Insumo / Mercancía de reventa)", "itemSku → SKU", "itemName → Artículo", "presentationName
→ Presentación de compra", "presentationFactor → Unidades base por presentación", "unit → Unidad", "quantityOrdered → Cantidad pedida",
"quantityReceived → Cantidad recibida", "quantityDifference → Diferencia (faltante/sobrante)", "receiveStatus → Estatus del renglón",
"unitPrice → Precio unitario", "lineTotal → Importe del renglón", "itemNotes → Notas del renglón" ], "pantallaDashboard":
"avoqado-web-dashboard/src/pages/Inventory/PurchaseOrders/PurchaseOrdersPage.tsx:681 — segunda entrada del mismo DropdownMenu, abre el mismo
ExportDialog (src/components/export-dialog.tsx:28) con filenameStem 'ordenes-compra-renglones'. También conviene una entrada en el detalle:
PurchaseOrderDetailPage.tsx (42 KB, misma carpeta), acotada a esa orden.", "reusaFiltros": "Idénticos a la granularidad ORDEN (mismo where
sobre PurchaseOrder), más dos propios de renglón que el contralor pide de inmediato: receiveStatus[]
(PENDING/RECEIVED/DAMAGED/NOT_PROCESSED, prisma/schema.prisma:8384-8389) y `soloConDiferencia=true` (quantityReceived ≠ quantityOrdered)
para el «reporte de faltantes, sobrantes y rechazos» de las filas 77/79. El pre-flight cuenta RENGLONES (prisma.purchaseOrderItem.count con
`purchaseOrder: { <where de la orden> }`), no órdenes — si cuentas órdenes y traes renglones, el cap de 10 000 no protege nada." }, {
"nombre": "Recepciones (reporte detallado con diferencias) — fila por renglón recibido", "servicioActual": "NO EXISTE. Verificado: no hay
servicio, ruta ni pantalla de recepciones. Los datos están dispersos: PurchaseOrder.receivedDate/receivedBy
(prisma/schema.prisma:1968,1988), PurchaseOrderItem.quantityReceived/receiveStatus (:2049,:2060), StockBatch para insumos (:2272-2315,
ligado por purchaseOrderItemId :2280, con receivedDate/costPerUnit/batchNumber/expirationDate) e InventoryMovement para mercancía de reventa
(:1673-1710, purchaseOrderItemId :1696, createdBy :1703). El escritor es receivePurchaseOrder (purchaseOrder.service.ts:970) para insumos y
applyItemReceiveStatusInTx (:1623) para reventa.", "rutaActual": "Ninguna.", "rutaExportPropuesta": "GET
/api/v1/dashboard/venues/:venueId/inventory/receipts/export (+ GET /receipts para la pantalla, porque exportar algo que no se puede ver es
peor que no exportarlo). VERIFICADO que no colisiona: no existe ningún segmento /receipts en inventory.routes.ts, y ninguna ruta dinámica de
primer nivel lo pueda capturar (el router sólo tiene literales de primer nivel). Colocar el par junto al bloque de PURCHASE ORDERS, después
de :914.", "permiso": "inventory:read — src/lib/permissions.ts:1498 (catálogo), :156-159 (deps), defaults MANAGER :761 / ADMIN :907 / OWNER
:1014. Es lectura de operación de almacén; no inventar 'receipts:read' (nacería PHANTOM).", "columnas": [ "receiptDate → Fecha de
recepción", "orderNumber → Folio de OC", "supplierName → Proveedor", "itemSku → SKU", "itemName → Artículo", "unit → Unidad",
"quantityOrdered → Cantidad pedida", "quantityReceived → Cantidad recibida", "quantityDifference → Diferencia", "receiveStatus → Resultado
(recibido / dañado / no procesado)", "batchNumber → Lote", "expirationDate → Caducidad", "costPerUnit → Costo unitario recibido",
"receivedValue → Importe recibido", "receivedByName → Usuario que recibió", "venueName → Tienda" ], "pantallaDashboard": "NO EXISTE pantalla
de recepciones. Hay que crearla: nueva ruta bajo avoqado-web-dashboard/src/pages/Inventory/ (hermana de PurchaseOrders/ y StockCounts/,
siguiendo el patrón read-only de StockCounts). El botón de export va en su header y abre el ExportDialog existente
(src/components/export-dialog.tsx:28) — el componente ya es reutilizable, la pantalla es lo que falta.", "reusaFiltros": "La matriz PITS
(fila 75) exige textualmente filtros por «fecha, tienda, proveedor, orden de compra y usuario» y «visualizar diferencias». Traducción:
startDate/endDate sobre la fecha REAL de recepción (StockBatch.receivedDate / InventoryMovement.createdAt, no PurchaseOrder.orderDate),
supplierIds[], purchaseOrderId, receivedByStaffIds[], soloConDiferencia. «Tienda» = el venueId de la ruta (una tienda por export; el
consolidado multi-tienda es org-level y NO está en este alcance — decirlo explícito o PITS lo va a pedir en la demo). 🔴 Hueco real:
`StockBatch` NO tiene columna de quién lo recibió (prisma/schema.prisma:2272-2315), así que «usuario» sólo se puede resolver vía
RawMaterialMovement.createdBy (:2166, con venueId propio :2145 y batchId :2158) para insumos e InventoryMovement.createdBy (:1703) para
reventa, o caer a PurchaseOrder.receivedBy (nivel orden, :1988). Tampoco existe `receivedAt` por renglón: la fecha real de recepción sale
del lote/movimiento, nunca de PurchaseOrderItem." }, { "nombre": "Proveedores (padrón)", "servicioActual": "getSuppliers —
src/services/dashboard/supplier.service.ts:11 (where :19-31 con venueId + deletedAt:null; include pricing activo + últimas 5 OC :35-63;
orderBy [{rating:desc},{name:asc}] :64 — ES único porque Supplier tiene @@unique([venueId,name]) en prisma/schema.prisma:1914)",
"rutaActual": "GET /api/v1/dashboard/venues/:venueId/inventory/suppliers — src/routes/dashboard/inventory.routes.ts:571",
"rutaExportPropuesta": "GET /api/v1/dashboard/venues/:venueId/inventory/suppliers/export — VERIFICADO que NO existe. 🔴 Insertar entre
inventory.routes.ts:571 y :580: si queda debajo de `/suppliers/:supplierId` (:580) Express capturará 'export' como supplierId y la ruta nace
muerta. El include de export debe ser MÁS ligero que el del listado (no traer `pricing` completo ni las 5 últimas OC por proveedor: para 10
000 filas eso revienta memoria); sólo \_count.purchaseOrders y la última orderDate.", "permiso": "inventory:read —
src/lib/permissions.ts:1498 (catálogo), :156-159 (deps), defaults MANAGER :761 / ADMIN via 'inventory:_' :907 / OWNER :1014. Mismo que el
listado (:571).", "columnas": [ "name → Proveedor", "taxId → RFC", "contactName → Contacto", "email → Correo", "phone → Teléfono", "address
→ Dirección", "city → Ciudad", "state → Estado", "zipCode → C.P.", "country → País", "leadTimeDays → Días de entrega", "minimumOrder →
Pedido mínimo", "rating → Calificación", "reliabilityScore → Confiabilidad", "active → Estatus", "notes → Observaciones", "createdAt → Fecha
de alta", "purchaseOrdersCount → Órdenes de compra", "lastOrderDate → Última compra" ], "pantallaDashboard":
"avoqado-web-dashboard/src/pages/Inventory/Suppliers/SuppliersPage.tsx:269-278 — junto al <Button> de crear proveedor, dentro del header
:263-278. Reutiliza src/components/export-dialog.tsx:28 (ExportDialog). Toda la página ya está envuelta en <FeatureGate
feature=\"INVENTORY_TRACKING\"> (:261), consistente con el gate del router backend.", "reusaFiltros": "La pantalla manda `search` al backend
(SuppliersPage.tsx:66-73 → supplier.service.ts:24-30) pero filtra activo/inactivo en el CLIENTE (SuppliersPage.tsx:227-235). El /export debe
aceptar `search` y `active` (o `activeStates[]` para reproducir el multi-select), o el archivo traerá los inactivos que el usuario ocultó.
🔴 PROBLEMA DE ENCAJE CON EL PATRÓN: ExportDialog SIEMPRE manda startDate/endDate (export-dialog.tsx:108-114, con initialDateFrom/To
obligatorios en las props :40-41), pero un padrón de proveedores NO es una serie temporal. Si el backend los aplica sobre createdAt en
silencio, el contralor exporta «proveedores» y recibe sólo los dados de alta en el rango — pérdida silenciosa, el peor modo de falla. Dos
salidas, hay que elegir una explícitamente: (a) cambio ADITIVO mínimo a ExportDialog — prop opcional `dateRangeMode?: 'range'|'hidden'`
(default 'range', no rompe pagos ni órdenes) que oculta el picker y no manda las fechas; sirve también para los otros catálogos de H0; o (b)
el endpoint IGNORA startDate/endDate y lo documenta en el JSDoc de la ruta. Recomiendo (a): (b) deja un parámetro que miente." }, {
"nombre": "Precios por proveedor (SupplierPricing)", "servicioActual": "getSupplierPricingHistory —
src/services/dashboard/supplier.service.ts:280, pero es POR INSUMO (recibe rawMaterialId) y la query a supplierPricing NO filtra por venue
(:292-295: where { rawMaterialId } a secas); se apoya en haber validado antes que el rawMaterial es del venue (:281-290). No existe listado
a nivel venue. También aparece embebido en getSuppliers (supplier.service.ts:36-49).", "rutaActual": "GET
/api/v1/dashboard/venues/:venueId/inventory/raw-materials/:rawMaterialId/supplier-pricing —
src/routes/dashboard/inventory.routes.ts:645-649", "rutaExportPropuesta": "GET
/api/v1/dashboard/venues/:venueId/inventory/supplier-pricing/export — VERIFICADO que no existe ni colisiona (el único /supplier-pricing vive
bajo /raw-materials/:rawMaterialId, segmento distinto). Colocar junto a /suppliers/export. Requiere una función nueva en supplier.service.ts
que liste a nivel VENUE, no por insumo.", "permiso": "inventory:read — src/lib/permissions.ts:1498, deps :156-159, defaults MANAGER :761 /
ADMIN :907 / OWNER :1014. Mismo que la ruta actual (inventory.routes.ts:647).", "columnas": [ "supplierName → Proveedor", "rawMaterialSku →
SKU del insumo", "rawMaterialName → Insumo", "pricePerUnit → Precio por unidad", "unit → Unidad", "minimumQuantity → Cantidad mínima",
"bulkDiscount → Descuento por volumen", "effectiveFrom → Vigente desde", "effectiveTo → Vigente hasta", "active → Estatus", "lastOrderDate →
Última compra a este precio" ], "pantallaDashboard": "NO EXISTE pantalla de precios por proveedor. Sólo aparece embebido en
avoqado-web-dashboard/src/pages/Inventory/components/RawMaterialDialog.tsx:255-262 (detalle de un insumo). Opción barata sin pantalla nueva:
poner el botón de export en SuppliersPage.tsx:269-278 como segunda entrada de un DropdownMenu («Exportar padrón» / «Exportar lista de
precios»), reutilizando src/components/export-dialog.tsx:28. Es el listado de menor prioridad de los cinco: la matriz no lo pide por nombre,
lo cubre el paraguas de la fila 196.", "reusaFiltros": "Como no hay pantalla, no hay filtros vigentes que reusar. Filtros mínimos para que
sea útil y no sea un volcado: supplierIds[], rawMaterialIds[], `soloVigentes=true` (active:true y effectiveTo null o futuro, contra la fecha
VENUE-LOCAL, no `new Date()` del host). Si se monta el botón en SuppliersPage, heredar su `search` y `active` restringiendo por
`supplier: { ... }`. Aplica la misma objeción del rango de fechas que en proveedores (ver ese renglón)." } ], "riesgos": [ "TENANT — dos
tablas de este módulo NO tienen venueId propio. `SupplierPricing` (prisma/schema.prisma:1922-1953) se aísla sólo vía supplier.venueId /
rawMaterial.venueId, y `getSupplierPricingHistory` hoy consulta `where { rawMaterialId }` sin filtro de venue (supplier.service.ts:292-295),
apoyándose en una validación previa (:281-290). `InventoryMovement` tampoco tiene venueId (schema.prisma:1673-1710) y se filtra por
`inventory: { venueId }`. Cualquier where de export sobre estas dos DEBE ir por la relación (`supplier: { venueId }`,
`inventory: { venueId }`) — un where directo por id sin venue es fuga cross-tenant.", "ORDERBY NO ÚNICO — `getPurchaseOrders` ordena sólo
por `orderDate: 'desc'` (purchaseOrder.service.ts:496-498) y `orderDate` empata a diario: el job de auto-reorder (`autoGenerated`,
schema.prisma:1989) crea varias OC el mismo día. Con `take: cap` el corte es no determinista y se pierden filas EN SILENCIO — es la memoria
`paginacion-inestable-orderby-no-unico`. Desempatar SIEMPRE con `{ id: 'desc' }` (u `orderNumber`, que es @unique global,
schema.prisma:1964). El fetch de renglones necesita además desempate por `purchaseOrderItem.id`. `getSuppliers` sí es único ([rating desc,
name asc] + @@unique([venueId,name]) :1914).", "VOLUMEN Y N+1 — `getPurchaseOrders` NO pagina y trae TODOS los renglones con sus relaciones
(purchaseOrder.service.ts:459-499); ya es un riesgo de OOM en Render (memoria `oom-render-analytics-512mb`), y un export de 10 000 órdenes ×
N renglones lo multiplica. Además `getStaffSummary` (purchaseOrder.service.ts:260) resuelve el nombre de UN staff por consulta: las columnas
Capturó/Autorizó/Rechazó/Recibió leen `createdBy`/`approvedBy`/`rejectedBy`/`receivedBy`, que son String? planos, NO relaciones
(schema.prisma:1986-1995), así que NO se pueden `include`. Hay que batchearlos en un solo
`staff.findMany({ where: { id: { in: [...] } } })` + Map, o son 40 000 queries. El pre-flight count debe contar la MISMA entidad que se
exporta (órdenes vs renglones).", "FECHAS Y DINERO — los tres exports vivos emiten `createdAt.toISOString()` (UTC crudo). Contabilidad y el
contralor abren estos archivos: una compra de las 20:30 del día 6 en México sale fechada el día 7. Para compras hay que formatear en
`venue.timezone` y parsear el rango con `parseDbDateRange(from, to, venueTz)` (src/utils/datetime.ts:151-185), nunca
`new Date('YYYY-MM-DD')`. Dinero: pesos 1:1 como Decimal, sin centavos. 🔴 Trampa aritmética específica del módulo: sumar
`PurchaseOrderItem.total` NO da el total de la OC — el IVA (`taxAmount`) y la comisión (`commission`) viven en la ORDEN, no en el renglón
(schema.prisma:1978-1983). Por eso el export de renglones NO debe repetir taxAmount/commission/total de la orden en cada fila (doble conteo
al pivotear) y por eso el export de gasto no se puede derivar del de renglones.", "LO QUE SE VE ≠ LO QUE SE EXPORTA — la pantalla de OC
filtra en el CLIENTE todo menos `status` (PurchaseOrdersPage.tsx:111-116 manda status; el bloque :133-289 filtra en memoria búsqueda, folio,
proveedor, fecha de orden, fecha de entrega, rango de total y rango de renglones; incluso manda `search` que el backend descarta porque no
está en GetPurchaseOrdersQuerySchema, inventory.schema.ts:480-488). SuppliersPage filtra activo/inactivo en el cliente (:227-235). Si el
/export no recibe esos filtros, el archivo trae filas que el usuario ya había descartado en pantalla y nadie lo nota — es exactamente el
defecto vivo de pagos con MindForm. Subir esos filtros al backend en el MISMO cambio es la mitad del trabajo real de este renglón, no un
extra.", "GATE, PII Y AUDITORÍA — (1) Todo el namespace está tras `checkFeatureAccess('INVENTORY_TRACKING')` (inventory.routes.ts:108), que
es PREMIUM: si el venue de PITS no queda en ese tier (o exento/grandfathered), NINGÚN export de compras existirá y el 403 no dirá 'no
implementado' sino 'tu plan no lo incluye'. Verificarlo antes de la demo. (2) `inventory:read` NO lo tienen VIEWER (permissions.ts:561-580)
ni CASHIER: un contralor con rol VIEWER no puede exportar; necesita MANAGER+ o rol custom. (3) El export de proveedores lleva RFC, correo,
teléfono y dirección — descarga masiva de PII. Ningún export del sistema escribe `ActivityLog` hoy (sólo `logger.info`), y la regla del repo
prohíbe loguear lecturas; recomiendo mantener esa línea (sólo `logger.info` con venueId/total/format/granularity) pero dejarlo como DECISIÓN
EXPLÍCITA del founder, no heredada por omisión, porque PITS ya nos compró 'bitácora de operaciones por usuario' (fila 35)." ], "esfuerzo":
"DIAS" }, { "modulo": "Contabilidad (Capa A gerencial + Capa B fiscal) — `src/routes/dashboard/accounting.routes.ts`", "quePrometimos":
"Hoja \"2. Matriz de Requerimientos\", 5 filas de \"5 Contabilidad\" marcadas como cumplimiento natural (columna e = 1):\n\n• Fila 142 —
\"El sistema cuenta con la funcionalidad para generar estados de resultados de forma predeterminada, es configurable y exportable en XLS y
PDF\" → contestamos: \"Estado de resultados predeterminado, configurable y exportable a XLS y PDF, en el módulo contable. Incluido en la
suscripción propuesta: PITS no adquiere módulos adicionales ni paga costo extra por esta funcionalidad.\"\n\n• Fila 143 — \"…generar balance
general de forma predeterminada, es configurable y exportable en XLS y PDF\" → \"Balance general predeterminado, configurable y exportable a
XLS y PDF, en el módulo contable. Incluido en la suscripción propuesta…\"\n\n• Fila 145 — \"…generar estado de flujo de efectivo de forma
predeterminada, es configurable y exportable en xls,pdf\" → \"Estado de flujo de efectivo predeterminado, configurable y exportable a XLS y
PDF, en el módulo contable.\"\n\n• Fila 155 — \"El sistema genera un reporte de Ganancias / perdidas de actividades de P&L\" → \"Reporte de
rentabilidad y resultados (P&L) con corte configurable por periodo, sucursal, formato y producto, exportable. Incluye rentabilidad por
producto y mezcla de venta (PMIX).\"\n\n• Fila 158 — \"El sistema genera el reporte de gastos\" → \"Reporte de gastos con clasificación por
categoría y centro de costo, en el módulo contable.\"\n\nY dos renglones transversales que obligan a TODO listado contable:\n• Fila 196 (7
Sistemas) — \"Reportes para usuarios. La plataforma permite exportar en archivos xls, csv, txt las bases de información.\" → \"Exportación
de la información a XLS y CSV desde **todos los reportes y listados del sistema**.\"\n• Fila 4 (0 General) — \"El sistema permite
personalizacion de reporteria\" → \"Reportes predefinidos, configurables y **exportables (XLS/PDF/CSV) nativos**.\"", "queExisteHoy": "CERO
exportación en todo el módulo contable. Leí las 881 líneas de `src/routes/dashboard/accounting.routes.ts`: no hay ni una sola ruta
`/export`. Los únicos consumidores de `src/services/dashboard/export.helpers.ts` en todo el repo son 3 controladores, ninguno contable:
`sales-summary.dashboard.controller.ts:31`, `payment.dashboard.controller.ts:13`, `order.dashboard.controller.ts:10`.\n\n(a) ESTADO DE
RESULTADOS Y BALANCE GENERAL — SÍ tienen endpoint, NO tienen exportación.\n• Endpoint:
`GET /venues/:venueId/accounting/reports?period=YYYY-MM` en `accounting.routes.ts:373-379` (`checkFeatureAccess('CFDI')` +
`checkPermission('accounting:read')`). Devuelve AMBOS estados en una sola respuesta.\n• Servicio:
`src/services/fiscal/accountingReports.service.ts:89` `getAccountingReports(venueId, period)` → `incomeStatement`
(ingresos/costos/utilidadBruta/gastos/resultado) + `balanceSheet` (activo/pasivo/capital + `balanced`, la ecuación contable, `:209`).\n•
Pantalla: `avoqado-web-dashboard/src/pages/Reports/AccountingReports.tsx`, ruta `contabilidad/reportes`
(`src/routes/venueRoutes.tsx:440-446`). El ÚNICO botón de descarga que existe hoy en esa pantalla es `ContaElectronicaCard`
(`AccountingReports.tsx:175-218`), y baja **XML del SAT** (catálogo y balanza, Anexo 24) — NO es XLS ni PDF, y NO cubre el estado de
resultados ni el balance general.\n• OJO, hay DOS \"estados de resultados\" distintos y hay que decidir cuál le enseñamos a PITS: el fiscal
de Capa B (`/reports`, sobre pólizas, gateado PREMIUM CFDI) y el gerencial de Capa A (`GET /accounting/income-statement`,
`accounting.routes.ts:134`, sólo ingresos/IVA/propinas, `src/services/dashboard/accounting.dashboard.service.ts`, pantalla
`Reports/IncomeStatement.tsx`, ruta `contabilidad/ingresos`, `venueRoutes.tsx:352-357`) que NO está gateado por CFDI. El de la fila 142/155
es el de Capa B.\n• ESTADO DE FLUJO DE EFECTIVO (fila 145): NO EXISTE. Busqué `flujo de efectivo|cash-flow|cashFlow` en `src/routes`,
`src/controllers` y `src/services/fiscal`: el único hit es `/accounting/vat-flow` (`accounting.routes.ts:382-388`,
`src/services/fiscal/ivaFlujo.service.ts`), que es **IVA sobre base de flujo de efectivo** (LIVA 1-B), NO un estado de flujo de efectivo.
Ese renglón no se cierra con exportación: falta el reporte completo.\n\n(b) EL LEDGER ESTÁ EN CENTAVOS ENTEROS. VERIFICADO Y ES EL RIESGO
PRINCIPAL.\n`JournalEntry.totalDebitCents/totalCreditCents` y `JournalLine.debitCents/creditCents` son `Int` en centavos
(`prisma/schema.prisma:13082` y `:13110`); `Expense` tiene 11 campos `...Cents` `Int` (`schema.prisma:13172`); `LedgerAccount` no tiene
montos. Los servicios devuelven centavos SIEMPRE, a propósito: `accountingReports.service.ts:26` (\"Monto en positivo… amountCents\"),
`trialBalance.service.ts:15` (\"Money en centavos enteros\"), `accountLedger.service.ts:14`, `accountsPayable.service.ts:21-27`. Incluso la
Capa A convierte pesos→centavos para su API (`accounting.dashboard.service.ts:84` `toCents = Math.round(Number(d) * 100)`).\n\nCómo lo
resuelven HOY las pantallas: dividen entre 100 en el RENDER, con `Currency(x, true)` — `src/utils/currency.tsx:13-19`
(`const number = inCents ? Number(amount) / 100 : Number(amount)`). Ejemplos verificados: `AccountingReports.tsx:50,55,131,136`,
`TrialBalance.tsx:33,129,130,139,140,142`, `Journal.tsx:142,159,160`, `AccountsPayable.tsx:46,94,137-142`, `Expenses.tsx:122-124,181,182`. O
sea: la conversión vive ENTERAMENTE en el frontend. Un export de backend que copie el patrón de pagos/órdenes tal cual
(`value: r => Number(r.amount) || 0`) sacaría CENTAVOS a un XLSX.\n\nDÓNDE DEBE OCURRIR LA CONVERSIÓN, exactamente: en el `value()` de cada
`ExportColumnDef` del controlador de export, y en NINGÚN otro lado. Razón técnica: `encodeExport` (`export.helpers.ts:177-191`) escribe
`col.value(row)` verbatim — `encodeCsv` (`:64`) y `encodeXlsx` (`:77`) no transforman nada, y XLSX escribe el número como número, así que
`debitCents = 116000` cae en la celda como 116000 y el contador carga $116,000 en vez de $1,160.00. Propongo UN solo helper, en
`export.helpers.ts` (el archivo ya es agnóstico del dominio), junto a `parseFormatParam` (`:226`):\n
`export const pesosFromCents = (c: number | null | undefined): number => (c == null ? 0 : Math.round(c) / 100)`\ny que las 8 exportaciones
usen `value: r => pesosFromCents(r.debitCents)`. NO convertir en los servicios: las pantallas, los tools del MCP (`accounting_reports`,
`trial_balance`, `journal_entries`, `account_ledger`, `accounts_payable`, `expenses`) y el XML del SAT
(`contabilidadElectronica.service.ts`) dependen de que sigan devolviendo centavos — convertir río arriba rompe los tres a la vez.\n\nOtras
dos cosas verificadas que el export debe respetar y que NO son obvias:\n• Los saldos de la balanza y del auxiliar son NETOS CON SIGNO (\"+ =
deudor\"): `trialBalance.service.ts:28-33,150-151` y `accountLedger.service.ts:31`. La pantalla los parte en dos columnas con `Math.abs`
(`TrialBalance.tsx:33`). El archivo debe partirlos igual (Saldo deudor / Saldo acreedor); si sale un número negativo en una columna
\"Saldo\", el contralor lo postea al revés.\n• El estado de resultados/balance mete DOS renglones sintéticos con código que empieza con `~`:
`~RETAINED` y `~RESULT` (`accountingReports.service.ts:183,185`). La pantalla oculta ese código (`AccountingReports.tsx:47`,
`!l.code.startsWith('~')`). El export debe dejar la celda de código VACÍA, no escribir \"~RESULT\" como si fuera una cuenta del
catálogo.\n\nPermiso: `accounting:read` YA EXISTE y sirve — `src/lib/permissions.ts:291` (dependencias), `:713` (MANAGER), `:853` (ADMIN),
`:971` (OWNER), y está en el catálogo individual `:1471`. NO hace falta crear ningún permiso nuevo.\nMontaje:
`src/routes/dashboard.routes.ts:4151` → `router.use('/venues/:venueId/accounting', authenticateTokenMiddleware, accountingRoutes)`. El
`authenticateTokenMiddleware` SÍ está en el `use`, así que las rutas nuevas no quedan sin autenticar (misma trampa #15 de la receta).",
"listados": [ { "nombre": "Estado de resultados (Capa B fiscal, sobre pólizas) — filas 142 y 155 de la matriz", "servicioActual":
"getAccountingReports() en src/services/fiscal/accountingReports.service.ts:89 (secciones ingresos/costos/gastos + utilidadBruta:173 +
resultado:174). Se REUSA COMPLETO y se aplana, como sales-summary modo summary reusa getSalesSummary
(sales-summary.dashboard.controller.ts:341-343): así los números del archivo no pueden diferir de los de la pantalla.", "rutaActual": "GET
/api/v1/dashboard/venues/:venueId/accounting/reports?period=YYYY-MM — src/routes/dashboard/accounting.routes.ts:373-379",
"rutaExportPropuesta": "GET /api/v1/dashboard/venues/:venueId/accounting/reports/export?period=YYYY-MM&statement=income&format=xlsx|pdf|csv
— VERIFICADO que no existe. Declararla INMEDIATAMENTE después de la línea 379 (no hay ninguna ruta dinámica /reports/:algo, así que no queda
sombreada; se mantiene la convención estático-antes-de-dinámico). Un solo controlador sirve income y balance vía `statement` (Zod enum en
español: \"El tipo de estado debe ser 'income' o 'balance'.\"). filenameStem 'estado-de-resultados'. Sin cap ni 413: son agregados de unas
decenas de renglones, igual que el modo summary de sales-summary (sales-summary.dashboard.controller.ts:307-361).", "permiso":
"accounting:read — CONFIRMADO en src/lib/permissions.ts:291 (deps), :713 MANAGER, :853 ADMIN, :971 OWNER, catálogo :1471. Además hay que
conservar checkFeatureAccess('CFDI') ANTES del permiso, igual que la ruta /reports (accounting.routes.ts:374-376), y si se rechaza usar el
403 verbatim de sales-summary.dashboard.controller.ts:232-237.", "columnas": [ "Sección (Ingresos/Costos/Utilidad bruta/Gastos/Resultado)",
"Código de cuenta (VACÍO si empieza con ~)", "Cuenta", "Importe (PESOS = amountCents/100)", "% sobre ingresos", "Periodo (YYYY-MM)", "Inicio
del ejercicio (fiscalYearStart)", "RFC del contribuyente" ], "pantallaDashboard":
"avoqado-web-dashboard/src/pages/Reports/AccountingReports.tsx — botón en el <header> de la línea 76 (junto al selector de periodo, patrón
de TrialBalance.tsx:60-62). Ruta contabilidad/reportes en src/routes/venueRoutes.tsx:440-446. NO hay componente de exportación reutilizable
montado aquí: lo único que existe es ContaElectronicaCard (:175-218) que baja XML del SAT. SÍ existe ExportDialog reutilizable en
src/components/export-dialog.tsx (usado por Payments.tsx:1607 y Orders.tsx:1399) y ES el que se debe usar.", "reusaFiltros": "El único
filtro de la pantalla es `period` (useState en AccountingReports.tsx:64, <Input type=\"month\">). Va en `baseParams={{ period }}`. ⚠️ TRAMPA
REAL: ExportDialog SIEMPRE inyecta startDate/endDate desde su propio DateRangePicker (export-dialog.tsx:107-114) y exige initialDateFrom/To
(props :41-43); los endpoints contables son por `period`, no por rango. Hay que agregarle a ExportDialog una prop OPCIONAL
`hideDateRange?: boolean` que, cuando es true, no pinta el picker y no inyecta startDate/endDate — cambio aditivo, no toca
pagos/órdenes/ventas. Sin eso el usuario mueve un rango de fechas dentro del modal y el archivo sale del mes del selector: parece bug y lo
es." }, { "nombre": "Balance general (Capa B fiscal) — fila 143 de la matriz", "servicioActual": "getAccountingReports() en
src/services/fiscal/accountingReports.service.ts:89 → balanceSheet (activo/pasivo/capital, :203-210), incluye los renglones sintéticos
~RETAINED (:183) y ~RESULT (:185) y el flag `balanced` (:209).", "rutaActual": "GET
/api/v1/dashboard/venues/:venueId/accounting/reports?period=YYYY-MM — src/routes/dashboard/accounting.routes.ts:373-379 (mismo endpoint que
el estado de resultados)", "rutaExportPropuesta": "GET .../accounting/reports/export?period=YYYY-MM&statement=balance&format= — MISMA ruta
nueva que el renglón anterior, distinto valor de `statement`; filenameStem 'balance-general'. El archivo DEBE cerrar con el renglón de
comprobación de la ecuación contable (Activo = Pasivo + Capital) usando `balanced`, porque es lo primero que revisa un contralor.",
"permiso": "accounting:read (CONFIRMADO, src/lib/permissions.ts:1471 y defaults :713/:853/:971) + checkFeatureAccess('CFDI') delante",
"columnas": [ "Sección (Activo/Pasivo/Capital)", "Código de cuenta (VACÍO si empieza con ~)", "Cuenta", "Importe (PESOS = amountCents/100)",
"Total de la sección (PESOS)", "Cuadre: Activo = Pasivo + Capital (Sí/No)", "Periodo (YYYY-MM)", "RFC del contribuyente" ],
"pantallaDashboard": "src/pages/Reports/AccountingReports.tsx — mismo <header> línea 76; un solo botón 'Exportar' que abre el diálogo con un
selector de qué estado bajar, o dos botones. No hay export reutilizable montado hoy.", "reusaFiltros": "Igual que arriba: `period` vía
baseParams + `hideDateRange` en ExportDialog. La pantalla no tiene más filtros que el mes." }, { "nombre": "Libro diario · Pólizas
(JournalEntry + JournalLine)", "servicioActual": "listEntries() en src/services/fiscal/journalEntry.service.ts:359 (orderBy
[{date:desc},{folio:desc}] :369, take min(limit??100,500) :370). ⚠️ NO usar ésta para exportar: tiene tope duro de 500 e incluye pólizas
no-POSTED. Usar listPeriodEntries() :403 como base — sin tope, sólo POSTED, orderBy [{date:asc},{folio:asc}] :410, que es exactamente el
mismo universo de la balanza.", "rutaActual": "GET /api/v1/dashboard/venues/:venueId/accounting/journal?period=YYYY-MM —
src/routes/dashboard/accounting.routes.ts:272-278", "rutaExportPropuesta": "GET .../accounting/journal/export?period=YYYY-MM&format= —
VERIFICADO que no existe. Declararla justo después de la línea 278, ANTES del POST /journal (:281). No hay /journal/:id, así que no queda
sombreada. El export es POR LÍNEA (un renglón por JournalLine), que es lo que un contador carga a su sistema, no por póliza. Pre-flight con
prisma.journalLine.count({ where: { journalEntry: { organizationId, rfc, period, status: POSTED } } }) → 413 con el mensaje en español del
patrón (payment.dashboard.controller.ts:320-331), sustantivo 'renglones'. filenameStem 'libro-diario'.", "permiso": "accounting:read —
CONFIRMADO (permissions.ts:1471, defaults :713/:853/:971); + checkFeatureAccess('CFDI') delante, igual que la ruta actual
(accounting.routes.ts:273)", "columnas": [ "Fecha (usar el string YYYY-MM-DD del DTO, journalEntry.service.ts:375 — NUNCA re-formatear con
new Date())", "Periodo (YYYY-MM)", "Folio", "Tipo de póliza", "Origen (source)", "Estatus", "Concepto de la póliza", "Código de cuenta",
"Nombre de cuenta", "Descripción del renglón", "Cargo (PESOS = debitCents/100)", "Abono (PESOS = creditCents/100)", "Total cargos de la
póliza (PESOS)", "Total abonos de la póliza (PESOS)", "Centro de costo / sucursal (JournalEntry.venueId, hay que agregarlo al select del
fetch de export: HOY el DTO no lo expone — lo pide la fila 137/144 de la matriz)", "RFC del contribuyente" ], "pantallaDashboard":
"src/pages/Reports/Journal.tsx — <header> línea 66; ya hay un bloque de botones a la derecha en :75+ (el de 'generar pólizas', condicionado
a canManage) donde cabe el de exportar sin condicionarlo a canManage. Ruta contabilidad/libro-diario en src/routes/venueRoutes.tsx:426-431.
Sin export reutilizable montado.", "reusaFiltros": "⚠️ HOY LA PANTALLA NO TIENE FILTRO DE PERIODO: llama useJournal(undefined)
(Journal.tsx:56) → el backend devuelve las últimas 100 pólizas de TODOS los meses (journalEntry.service.ts:370). Si el export se hace por
`period` y la pantalla no lo tiene, el archivo NO es 'lo que se ve'. Hay que agregar el <Input type=\"month\"> a Journal.tsx (copiando
TrialBalance.tsx:59-62) y pasar ese mismo `period` a useJournal Y a baseParams. Sin ese paso el renglón queda mal cerrado." }, { "nombre":
"Balanza de comprobación", "servicioActual": "getTrialBalance() en src/services/fiscal/trialBalance.service.ts:71; filas ordenadas por
`code` (:172, único por (org,rfc) — LedgerAccount @@unique([organizationId,rfc,code]), schema.prisma:12974) y totales + flags de cuadre en
:180-188.", "rutaActual": "GET /api/v1/dashboard/venues/:venueId/accounting/trial-balance?period=YYYY-MM —
src/routes/dashboard/accounting.routes.ts:344-350", "rutaExportPropuesta": "GET .../accounting/trial-balance/export?period=YYYY-MM&format= —
VERIFICADO que no existe. Declararla justo después de la línea 350; no hay ruta dinámica hermana. Reusar getTrialBalance() completo (los
saldos ya vienen calculados y cuadrados) y aplanar; sin cap real (son cuentas, cientos como mucho) pero conservar el pre-flight/413 por
uniformidad. filenameStem 'balanza-de-comprobacion'.", "permiso": "accounting:read — CONFIRMADO (permissions.ts:1471); +
checkFeatureAccess('CFDI')", "columnas": [ "Código de cuenta", "Cuenta", "Tipo (ACTIVO/PASIVO/CAPITAL/INGRESO/COSTO/GASTO/ORDEN)",
"Naturaleza (DEUDORA/ACREEDORA)", "Saldo inicial deudor (PESOS; = saldoInicialCents/100 si >= 0, si no 0)", "Saldo inicial acreedor (PESOS;
= -saldoInicialCents/100 si < 0)", "Cargos del periodo (PESOS = debeCents/100)", "Abonos del periodo (PESOS = haberCents/100)", "Saldo final
deudor (PESOS)", "Saldo final acreedor (PESOS)", "Periodo", "RFC del contribuyente" ], "pantallaDashboard":
"src/pages/Reports/TrialBalance.tsx — <header> línea 50, el selector de mes está en :59-62 y el botón va a su lado. Ruta
contabilidad/balanza en src/routes/venueRoutes.tsx:433-438. Sin export reutilizable montado.", "reusaFiltros": "`period` (useState, <Input
type=\"month\"> TrialBalance.tsx:60) → baseParams={{ period }} + hideDateRange. Es el único filtro; el archivo sale idéntico a la tabla." },
{ "nombre": "Catálogo de cuentas", "servicioActual": "getChartOfAccounts() en src/services/fiscal/chartOfAccounts.service.ts:~180, que
delega en listAccounts() :156 (orderBy { code: 'asc' } :159 — único por (org,rfc), no pierde filas).", "rutaActual": "GET
/api/v1/dashboard/venues/:venueId/accounting/chart-of-accounts — src/routes/dashboard/accounting.routes.ts:173-179", "rutaExportPropuesta":
"GET .../accounting/chart-of-accounts/export?format= — VERIFICADO que no existe. ⚠️ ESTA ES LA ÚNICA CON RIESGO DE ORDEN: existe PATCH
/chart-of-accounts/:accountId en :200-206. Como es PATCH y el export es GET, Express no la sombrea por método, PERO hay que declarar el GET
/export inmediatamente después de la línea 179 (antes del POST /seed de :182 y del PATCH de :200) para no dejar la trampa armada si alguien
agrega mañana un GET /chart-of-accounts/:accountId. filenameStem 'catalogo-de-cuentas'.", "permiso": "accounting:read — CONFIRMADO
(permissions.ts:1471); + checkFeatureAccess('CFDI') delante, igual que :174", "columnas": [ "Código de cuenta", "Nombre", "Código agrupador
SAT", "Tipo", "Naturaleza", "Nivel", "Cuenta padre (código)", "Afectable (Sí/No — isPostable)", "Activa (Sí/No)" ], "pantallaDashboard":
"src/pages/Reports/ChartOfAccounts.tsx — <header> línea 70. Ruta contabilidad/catalogo en src/routes/venueRoutes.tsx:412-417. Sin export
reutilizable montado.", "reusaFiltros": "La pantalla no tiene filtros de servidor: agrupa en memoria por tipo (ChartOfAccounts.tsx:58-67).
baseParams={} + hideDateRange; el export saca el catálogo completo, que es exactamente lo que se ve. Sin columna de dinero → aquí NO aplica
la conversión de centavos." }, { "nombre": "Auxiliar por cuenta (libro mayor de UNA cuenta)", "servicioActual": "getAccountLedger() en
src/services/fiscal/accountLedger.service.ts:74 — saldo inicial (:104), movimientos con saldo corrido (:109-123), orderBy
[{journalEntry.date asc},{journalEntry.folio asc},{createdAt asc}] (:100).", "rutaActual": "GET
/api/v1/dashboard/venues/:venueId/accounting/account-ledger?accountCode=&period=YYYY-MM —
src/routes/dashboard/accounting.routes.ts:364-370", "rutaExportPropuesta": "GET
.../accounting/account-ledger/export?accountCode=&period=YYYY-MM&format= — VERIFICADO que no existe; no hay ruta dinámica hermana,
declararla después de la línea 370. filenameStem 'auxiliar-de-cuenta'. Agregar {id:'asc'} como desempate al orderBy (folio ya es único por
contribuyente — schema.prisma:13082 @@unique([organizationId,rfc,folio]) — pero un asiento puede tocar la misma cuenta dos veces en la misma
póliza).", "permiso": "accounting:read — CONFIRMADO (permissions.ts:1471); + checkFeatureAccess('CFDI')", "columnas": [ "Código de cuenta",
"Nombre de cuenta", "Fecha (string YYYY-MM-DD del servicio, accountLedger.service.ts:114)", "Folio de la póliza", "Origen (source)",
"Concepto de la póliza", "Descripción del renglón", "Cargo (PESOS = debitCents/100)", "Abono (PESOS = creditCents/100)", "Saldo corrido
(PESOS = saldoCents/100; poner el signo o una columna 'Naturaleza del saldo')", "Saldo inicial del periodo (PESOS)", "Saldo final del
periodo (PESOS)", "Periodo", "RFC del contribuyente" ], "pantallaDashboard": "🔴 NO EXISTE PANTALLA. Verificado: no hay ni una referencia a
`account-ledger` / `accountLedger` en todo avoqado-web-dashboard/src, ni archivo en src/services/fiscal/ (que sí tiene
trialBalance/accountingReports/accountsPayable/etc.). El endpoint está huérfano. Hay que construir la pantalla (drill-down natural desde
TrialBalance.tsx, click en la fila de la cuenta) o, como mínimo para H0, exponer el export desde la balanza. Sin pantalla no hay dónde poner
el botón.", "reusaFiltros": "`accountCode` + `period`. Si el disparo es desde la balanza, ambos salen de la fila clickeada + el <Input
type=\"month\"> de TrialBalance.tsx:60. baseParams={{ accountCode, period }} + hideDateRange." }, { "nombre": "Cuentas por pagar (antigüedad
de saldos a proveedores)", "servicioActual": "getAccountsPayableAging() en src/services/fiscal/accountsPayable.service.ts:69; agrega en
memoria por RFC de proveedor (:93-120) y ordena por pendienteCents desc (:122).", "rutaActual": "GET
/api/v1/dashboard/venues/:venueId/accounting/accounts-payable?asOf=YYYY-MM-DD — src/routes/dashboard/accounting.routes.ts:536-542",
"rutaExportPropuesta": "GET .../accounting/accounts-payable/export?asOf=YYYY-MM-DD&format= — VERIFICADO que no existe; sin ruta dinámica
hermana, declararla después de la línea 542. Reusar getAccountsPayableAging() completo (mismos números que la pantalla) y aplanar
`suppliers` + el renglón de `totals`. ⚠️ Agregar desempate al sort de :122
(`b.pendienteCents - a.pendienteCents || a.proveedorRfc.localeCompare(b.proveedorRfc)`): hoy no es único y dos proveedores con el mismo
saldo salen en orden no determinista. filenameStem 'cuentas-por-pagar'.", "permiso": "accounting:read — CONFIRMADO (permissions.ts:1471); +
checkFeatureAccess('CFDI')", "columnas": [ "RFC del proveedor", "Proveedor", "Comprobantes con saldo", "Saldo pendiente (PESOS =
pendienteCents/100)", "Por vencer 0-30 días (PESOS)", "31-60 días (PESOS)", "61-90 días (PESOS)", "Más de 90 días (PESOS)", "Días del
comprobante más antiguo", "Fecha de corte (asOf)", "RFC del contribuyente" ], "pantallaDashboard": "src/pages/Reports/AccountsPayable.tsx —

<header> línea 52; el <Input type=\"date\"> de corte está en :65 y el botón va a su lado. Ruta contabilidad/cuentas-por-pagar en
src/routes/venueRoutes.tsx:454-459. Sin export reutilizable montado.", "reusaFiltros": "`asOf` (useState + <Input type=\"date\">
AccountsPayable.tsx:65) → baseParams={{ asOf }} + hideDateRange. ⚠️ NO usar el DateRangePicker: `asOf` es UNA fecha de corte, no un rango;
si el diálogo manda startDate/endDate el backend los ignora y el usuario cree que filtró." }, { "nombre": "Gastos / Buzón de CFDIs recibidos
— fila 158 de la matriz", "servicioActual": "listExpenses() en src/services/fiscal/expense.service.ts:415; where por org+rfc (:427) con
filtros status/paymentStatus/proveedorRfc/period (:428-439), orderBy { fechaEmision: 'desc' } (:443) y take min(limit,500) default 200
(:444).", "rutaActual": "GET /api/v1/dashboard/venues/:venueId/accounting/expenses?period=&paymentStatus=&proveedorRfc= —
src/routes/dashboard/accounting.routes.ts:471-477", "rutaExportPropuesta": "GET
.../accounting/expenses/export?period=&paymentStatus=&proveedorRfc=&includeCancelled=&format= — VERIFICADO que no existe. Declararla
inmediatamente después de la línea 477, ANTES del POST /expenses/generate-policies (:480) y sobre todo antes del POST
/expenses/:expenseId/pay (:514) — hoy no colisiona por método, pero es la trampa de /purchase-orders/stats esperando. 🔴 DOS COSAS QUE HAY
QUE ARREGLAR EN EL FETCH DE EXPORT: (1) el tope de 500 de :444 es del listado, el export debe usar EXPORT_ROW_CAP (10 000 / 1 000 PDF) con
pre-flight prisma.expense.count + 413; (2) el orderBy { fechaEmision:'desc' } NO ES ÚNICO (decenas de CFDIs el mismo día) → con `take` se
pierden filas en silencio: usar orderBy [{fechaEmision:'desc'},{id:'desc'}]. filenameStem 'gastos'.", "permiso": "accounting:read —
CONFIRMADO (permissions.ts:1471); + checkFeatureAccess('CFDI') delante, igual que :472", "columnas": [ "Fecha de emisión", "Fecha de pago",
"UUID (folio fiscal)", "Serie", "Folio", "RFC del proveedor", "Proveedor", "Tipo de comprobante", "Uso del CFDI (usoCfdi: está en el modelo,
schema.prisma Expense, pero NO en el DTO — el fetch de export debe seleccionarlo)", "Método de pago (PUE/PPD)", "Forma de pago (formaPago:
igual que arriba, en modelo no en DTO)", "Categoría", "Subtotal (PESOS = subtotalCents/100)", "Descuento (PESOS)", "IVA (PESOS =
ivaCents/100)", "IEPS (PESOS)", "ISR retenido (PESOS)", "IVA retenido (PESOS)", "Total (PESOS = totalCents/100)", "Estatus de pago / Pagado
(PESOS = paidCents/100)" ], "pantallaDashboard": "src/pages/Reports/Expenses.tsx — <header> línea 84 (ya hay botones de importar XML /
generar pólizas a la derecha). Ruta contabilidad/buzon en src/routes/venueRoutes.tsx:376-382. Sin export reutilizable montado.",
"reusaFiltros": "La pantalla hoy sólo usa `period` (Expenses.tsx:59, useExpenses({ period }) :62), aunque el hook
(src/hooks/useExpenses.ts:21) y el backend (accounting.routes.ts:447-459) aceptan además paymentStatus, proveedorRfc, includeCancelled y
limit. baseParams={{ period, paymentStatus, proveedorRfc }} con los que estén activos + hideDateRange, y chips de solo lectura con
activeFilterSummary (patrón Payments.tsx:1235-1244). Si se agregan filtros a la pantalla después, hay que espejarlos en baseParams con EL
MISMO nombre de query param." } ], "riesgos": [ "🔴 100x EN UN ARCHIVO QUE VA A UN SISTEMA CONTABLE. Todo el ledger es Int en centavos
(JournalLine.debitCents/creditCents schema.prisma:13110; los 11 campos ...Cents de Expense schema.prisma:13172) y los servicios los
devuelven SIN convertir a propósito (accountingReports.service.ts:26, trialBalance.service.ts:15, accountLedger.service.ts:14). Hoy nadie
divide entre 100 en el backend: sólo el render, con Currency(x, true) (src/utils/currency.tsx:17). Si se copia el patrón de pagos literal
(`value: r => Number(r.amount) || 0`, payment.dashboard.controller.ts:370-376) el XLSX sale en centavos y NADIE lo nota: encodeXlsx
(export.helpers.ts:77) escribe el número tal cual, así que la celda dice 116000 y el contador postea $116,000 en vez de $1,160.00 — y el
archivo CUADRA consigo mismo, o sea que ni la balanza ni la ecuación contable delatan el error. La conversión va ÚNICAMENTE en el value() de
cada ExportColumnDef, con un solo `pesosFromCents` en export.helpers.ts. Convertirlo en el servicio rompe a la vez las pantallas, los tools
del MCP (accounting_reports, trial_balance, journal_entries, account_ledger, accounts_payable, expenses) y el XML del SAT de
contabilidadElectronica.service.ts.", "🔴 TENANT: el alcance contable NO es el venue, es el CONTRIBUYENTE (organizationId + rfc).
resolveScopeOrNull (chartOfAccounts.service.ts:130-145) resuelve el RFC del venue de la ruta y a partir de ahí TODA query filtra por {
organizationId, rfc } — nunca por venueId (accountingReports.service.ts:96, trialBalance.service.ts:94, journalEntry.service.ts:363,
expense.service.ts:427, accountsPayable.service.ts:83). JournalEntry.venueId y Expense.venueId son nullable e 'informativo: centro de costo'
(schema.prisma:13082 y :13172). Consecuencia para PITS, que es multi-sucursal: un contralor con accounting:read en UNA sucursal exporta las
pólizas y los gastos de TODAS las sucursales que comparten ese RFC. Es correcto fiscalmente y ya es el comportamiento de las pantallas, pero
un archivo es portable y sale del edificio: el export DEBE estampar 'Contribuyente / RFC' en cada archivo y decirlo en la UI, o van a
reportarlo como fuga o como número mal.", "🟠 EL ARCHIVO PUEDE NO SER 'LO QUE SE VE' EN DOS PANTALLAS. (a) Journal.tsx llama
useJournal(undefined) (:56) → sin periodo, y listEntries corta en 100 (journalEntry.service.ts:370) e incluye pólizas NO POSTED; hay que
agregarle el selector de mes a la pantalla y exportar con listPeriodEntries (:403, sólo POSTED, sin tope) o el archivo y la tabla nunca
coincidirán. (b) ExportDialog SIEMPRE sobreescribe startDate/endDate desde su propio picker (export-dialog.tsx:107-114) y los endpoints
contables filtran por `period`/`asOf`: sin la prop nueva `hideDateRange` el usuario mueve fechas en el modal y el archivo sale de otro mes.
Es exactamente la divergencia que ya existe entre el listado y el export de órdenes (updatedAt vs createdAt) — trampa 13 de la receta.", "🟠
orderBy NO ÚNICO → filas perdidas en silencio, en dos de los seis listados. expense.service.ts:443 ordena sólo por fechaEmision desc
(decenas de CFDIs el mismo día) y accountsPayable.service.ts:122 sólo por pendienteCents desc. Con `take: cap` el corte es no determinista:
el contralor exporta dos veces el mismo mes y le faltan facturas distintas cada vez. Desempatar SIEMPRE por id (o por proveedorRfc en CxP).
En balanza y catálogo no hay problema: ordenan por `code`, único por (org,rfc) (schema.prisma:12974).", "🟠 SIGNOS Y CUENTAS FANTASMA. Los
saldos de balanza y auxiliar son NETOS con signo, '+ = deudor' (trialBalance.service.ts:28-33, accountLedger.service.ts:31) y la pantalla
los parte con Math.abs en dos columnas (TrialBalance.tsx:33): el archivo debe partirlos igual o un saldo acreedor sale como número negativo
bajo un encabezado 'Saldo' y se postea al revés. Y el estado de resultados/balance emite dos renglones sintéticos con código ~RETAINED /
~RESULT (accountingReports.service.ts:183,185) que la pantalla oculta (AccountingReports.tsx:47): si salen al XLS parecen cuentas del
catálogo y no existen en el catálogo del contador.", "⚪ ALCANCE: dos renglones de la matriz NO se cierran sólo con exportación. (1) Fila
145 'estado de flujo de efectivo… exportable en xls,pdf' — busqué flujo de efectivo|cash-flow|cashFlow en src/routes, src/controllers y
src/services/fiscal: NO EXISTE el reporte; lo único parecido es /accounting/vat-flow (accounting.routes.ts:382), que es el IVA sobre base de
flujo (LIVA 1-B), otra cosa. (2) El auxiliar por cuenta tiene endpoint (accounting.routes.ts:364) pero NO tiene pantalla: cero referencias a
accountLedger en todo avoqado-web-dashboard/src. Además, punto no verificado que hay que decidir explícitamente: HOY ninguna exportación del
repo escribe ActivityLog (sólo logger.info) — una descarga masiva del libro diario y del buzón de CFDIs de todo un RFC es justo el evento
que la bitácora de la fila 35/193 debería registrar, y heredarlo por omisión del patrón actual es una decisión, no un descuido." ],
"esfuerzo": "DIAS" } ]
