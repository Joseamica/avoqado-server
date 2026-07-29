# MCP — Custodia de inventario serializado por promotor — Design Spec

**Fecha:** 2026-07-29 **Repo:** `avoqado-server` (MCP + servicios en el mismo repo) **Rama base:** `develop`
**Estado:** Diseño aprobado, pendiente de plan de implementación
**Tier:** Sin decisión nueva. Todo es LECTURA gateada por el módulo `SERIALIZED_INVENTORY` ya existente, siguiendo el precedente de
[`2026-07-08-playtelecom-mcp-coverage-design.md`](2026-07-08-playtelecom-mcp-coverage-design.md). Cero writes.

---

## 1. Contexto

El MCP customer-facing (`src/mcp/`) expone el inventario serializado (SIMs / ICCIDs) de organizaciones con el módulo
`SERIALIZED_INVENTORY`. En tres ocasiones distintas un operador pidió un corte que **sí existe en la base de datos** y el modelo respondió
que "no existe en Avoqado", porque el MCP sólo exponía los datos crudos y no la agregación.

El patrón se repite con la misma forma cada vez:

1. **2026-07-08** — corte por supervisor. El MCP no exponía el mapeo supervisor → tienda → promotor, así que el modelo intentó **adivinarlo
   con un subset-sum** cruzando totales semanales. Se resolvió con `org_structure` + `promoterWeekly`.
2. **2026-07-29 (mañana)** — corte promotor × tipo de SIM. El modelo declaró, tras intentarlo por tres vías, que el cruce "no existe". El dato
   siempre estuvo ahí: `SerializedItem` guarda `assignedPromoterId` **y** `categoryId`, y el vínculo con el promotor sobrevive a la venta.
   Se resolvió con `serialized_sales_by_promoter` (commit `74db19e9`).
3. **2026-07-29 (ahora)** — inventario en poder de cada promotor. Este spec.

La causa raíz no es falta de datos: es **falta de descubribilidad**. Un dato al que sólo se llega haciendo N llamadas y sumando a mano es,
para un modelo, indistinguible de un dato que no existe. La defensa es nombrar la capacidad en un tool cuyo texto diga qué pregunta contesta.

**Por qué ahora:** estos cortes alimentan reportes que el cliente usa para conciliar operación e inventario físico. Un corte que no cuadra
contra los otros erosiona la confianza en todo el catálogo, no sólo en el tool nuevo. Por eso el cuadre entre tools es criterio de
aceptación duro y no una buena intención.

**Cómo sabemos que está hecho:** un operador puede pedir "cuántos SIMs trae hoy cada promotor, y cuáles" y obtenerlo en dos llamadas, sin
captura manual y sin que ningún total se contradiga con `serialized_stock_by_category`.

---

## 2. Estado actual (verificado 2026-07-29)

### 2.1 Lo que el operador pidió y qué falta

| Corte solicitado | ¿Existe hoy? | Camino actual |
| --- | --- | --- |
| Por promotor: asignados / vendidos / rechazados / en revisión / saldo | ❌ No | 1 llamada por combinación promotor × estado (~130 para ~65 promotores) |
| Mismo corte agregado por supervisor | ❌ No | No hay camino |
| Lista promotor + supervisor + ICCID | ⚠️ Parcial | `list_serialized_items` filtra por promotor pero **no lo devuelve** → 1 llamada por promotor |
| Filtrar por sucursal receptora | ❌ No | `registeredFromVenueId` existe en el modelo pero ningún tool lo expone |

### 2.2 Inventario de tools serializados (13 hoy)

`serialized_inventory` · `mark_serialized_item` · `sim_custody` · `change_sim_category` · `serialized_stock_by_category` ·
`list_serialized_items` · `serialized_sales_by_promoter` · `serialized_low_stock` · `serialized_stock_movements` · `serialized_stock_trend` ·
`serialized_stock_metrics` · `sim_pending_approvals` · (+ `record_serialized_sale` en `manualSale.ts`)

Ninguno agrega custodia por titular. `sim_custody` es **un serial a la vez**; `serialized_stock_by_category` agrupa por categoría, no por
persona.

### 2.3 El dashboard tampoco lo tiene

`src/services/organization-dashboard/orgStockControl.service.ts` agrupa por **carga masiva** (`groupByBulkUpload`, línea 58), no por
promotor. Lleva `assignedPromoterId` / `assignedSupervisorId` a nivel ítem (líneas 297-301) pero nunca los agrega. O sea: este corte no
existe en **ninguna** de las dos superficies. No estamos espejando algo que el dashboard ya hace; es capacidad nueva, y por decisión del
founder se construye **sólo en el MCP**.

### 2.4 Frontera con el dashboard (verificado con grep — no romper)

Existen dos familias de métodos en `serializedInventory.service.ts`, y están separadas a propósito: el spec de julio §4.0 documentó que las
venue-scoped **no son seguras** de reusar en el MCP porque filtran `venueId` estricto y pierden todo el pool org-level (`venueId=null`).

| Familia | Métodos | Consumidores |
| --- | --- | --- |
| **Org-aware** (MCP) | `listOrgItems`, `getOrgStockByCategory`, `getOrgSalesByPromoterAndCategory` | **Sólo** `src/mcp/tools/serialized.ts` (líneas 377, 333, 421). Cero callers en dashboard. |
| **Venue-scoped** (dashboard + TPV) | `listItems` (9 usos), `getCategories` (3), `scan`, `registerBatch`, `registerBatchOrg`, `getStockByCategory`, `ensureSellable`, `createCategory` | Controllers de dashboard y TPV |

### 2.5 Semántica de custodia (verificada en `custody.service.ts`)

| Transición | Qué le pasa a `assignedPromoterId` | Evidencia |
| --- | --- | --- |
| `REJECT` | **se conserva** (sólo cambia `custodyState` + `promoterRejectedAt`) | `custody.service.ts:444-447` |
| `COLLECT_FROM_PROMOTER` | **se borra** (`null`, junto con `assignedPromoterAt`, `promoterAcceptedAt`, `promoterRejectedAt`) | `custody.service.ts:516-522` |
| Venta (`SOLD`) | **se conserva permanentemente** | docstring de `getOrgSalesByPromoterAndCategory`, `serializedInventory.service.ts:1011-1015` |

Índices ya presentes en `prisma/schema.prisma`: `@@index([assignedPromoterId, custodyState])` y `@@index([assignedSupervisorId, custodyState])`.
**No se requiere migración.**

---

## 3. Cambio propuesto

### 3.1 Tool nuevo: `serialized_custody_by_promoter`

Archivo: `src/mcp/tools/serialized.ts` (registrado dentro de `registerSerializedTools`, que ya sólo se registra si el módulo está activo).

**Parámetros**

```ts
{
  venueId: z.string(),                          // venue en scope — gate del módulo + resolución de org
  registeredFromVenueId: z.string().optional(), // filtrar por sucursal receptora
}
```

**No hay parámetro `includeZero`.** El corte es un `groupBy` sobre `SerializedItem`, así que **sólo aparecen promotores que tienen al menos
un ítem** en alguno de los 4 estados. Un promotor con inventario cero no existe en esas filas y no puede materializarse sin unir contra el
roster (`StaffVenue`), lo cual es otro query y otro concepto. El roster completo ya lo da `org_structure`; el `description` de este tool debe
decir que quien no aparece trae cero, y remitir a `org_structure` para la lista completa de promotores.

**Salida**

```jsonc
{
  "orgId": "…",
  "registeredFromVenueId": null,
  "totals": { "asignados": 5063, "enRevision": 44, "enSuPoder": 1824, "rechazados": 2, "vendidos": 3193 },
  "promoters": [
    {
      "promoterId": "…",             // null ⇒ fila "Sin promotor asignado"
      "promoterName": "…",
      "supervisors": [               // SIEMPRE arreglo: un promotor puede tener ítems bajo >1 supervisor
        { "supervisorId": "…", "supervisorName": "…" }
      ],
      "asignados": 456, "enRevision": 0, "enSuPoder": 79, "rechazados": 0, "vendidos": 377
    }
  ],
  "supervisors": [
    { "supervisorId": "…", "supervisorName": "…", "promoterCount": 12,
      "asignados": 1204, "enRevision": 8, "enSuPoder": 310, "rechazados": 1, "vendidos": 885 }
  ]
}
```

`asignados` = `enRevision + enSuPoder + rechazados + vendidos`. Cuadra por construcción.

**Regla de merge (el groupBy devuelve una fila por combinación promotor × supervisor × estado).** Un promotor cuyos ítems traen supervisores
distintos produce varias filas. Se resuelven así:

- `promoters[]` se agrega **por `promoterId`**, sumando a través de supervisores. Cada promotor aparece **exactamente una vez**. Su campo
  `supervisors` lista los distintos supervisores que aparecen en sus ítems (normalmente uno).
- `supervisors[]` se agrega **por `supervisorId`**, independientemente. Como cada ítem tiene exactamente un par (promotor, supervisor), las
  dos agregaciones suman lo mismo y AC-2 se sostiene.
- `promoterCount` = promotores **distintos** en los ítems de ese supervisor. Un promotor repartido entre dos supervisores cuenta en ambos,
  así que **`Σ promoterCount` puede exceder `promoters.length`**. Es correcto, no un bug; el `description` lo dice.

**Filas nulas.** El filtro es por `custodyState`, no por titular, así que existen ítems en esos estados sin promotor o sin supervisor (p. ej.
una venta directa desde el pool admin conserva `SOLD` con `assignedPromoterId = null`). No se descartan: caen en
`promoterId: null` → `"Sin promotor asignado"` y `supervisorId: null` → `"Sin supervisor asignado"`. Descartarlos rompería el cuadre.

**Orden determinista** (para que la respuesta y las pruebas sean reproducibles): `promoters[]` y `supervisors[]` van por `asignados`
descendente, desempatando por nombre ascendente (`localeCompare`, es-MX); la fila nula va **al final** de su lista sin importar su conteo.
El arreglo interno `supervisors` de cada promotor va por nombre ascendente. Sin esto, dos llamadas idénticas devuelven el mismo contenido en
distinto orden y toda comparación en la conversación parece un cambio de datos.

**Mapeo de estados** (los 4 estados atribuibles a un promotor; `ADMIN_HELD` y `SUPERVISOR_HELD` no lo son y quedan fuera):

| `custodyState` | Campo |
| --- | --- |
| `PROMOTER_PENDING` | `enRevision` |
| `PROMOTER_HELD` | `enSuPoder` |
| `PROMOTER_REJECTED` | `rechazados` |
| `SOLD` | `vendidos` |

**Semántica — MIXTA, y el `description` del tool DEBE decirlo.** `vendidos` es acumulado histórico (el vínculo sobrevive a la venta); los
otros tres son foto de hoy (se borran al recoger). Por lo tanto `asignados` significa *"lo que está o estuvo a su nombre y no le fue
recogido"*, **no** *"todo lo que se le entregó alguna vez"*. Es la semántica correcta para conteo físico: un SIM recogido ya no es
responsabilidad del promotor. Efecto secundario útil: `rechazados` = rechazados **y aún no recogidos**, o sea pendientes de recoger.

**Gates, en este orden exacto:**

1. `guard.venueFilter(venueId)` — lanza `ScopeError` si el venue no está en la conexión.
2. `moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)` — si no, `text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })`.
3. `guard.requirePermission('inventory:read', venueId)`.
4. **Rol MANAGER+**: `const role = scope.perVenueAccess.get(venueId)?.role` y `ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[StaffRole.MANAGER]`;
   si no, `text({ ok: false, error: 'Solo OWNER, ADMIN o MANAGER pueden ver el inventario por promotor de la organización.' })`.

El gate de rol replica literalmente el de `sim_custody` (`serialized.ts:149-152`): es visibilidad org-wide de custodia atribuida a personas
con nombre, la misma clase de dato que el timeline forense. Un staffer de rol bajo dentro del scope no debe leer cuánto trae cada promotor
de la organización.

**Envelope.** Toda respuesta sale por `text({...})` de `src/mcp/respond.ts`, igual que el resto del archivo. Los errores son objetos
`{ ok: false, error }` en español, nunca excepciones sin capturar (salvo `ScopeError`, que el runtime del MCP ya maneja).

**`promoterId` / `supervisorId` sí se devuelven.** Son ids de staff de la propia organización del caller y sirven para encadenar la
siguiente llamada (`list_serialized_items?assignedPromoterId=…`). Lo que nunca se devuelve es un id **en lugar del nombre**: si el staff fue
borrado, el nombre es `'(empleado eliminado)'`, replicando `serialized.ts:185-187`.

### 3.2 Método nuevo en el servicio

`src/services/serialized-inventory/serializedInventory.service.ts`:

```ts
type CustodyCounts = { asignados: number; enRevision: number; enSuPoder: number; rechazados: number; vendidos: number }

async getOrgCustodyByPromoter(opts: {
  orgId: string
  allowedVenueIds: string[]
  registeredFromVenueId?: string
}): Promise<{
  totals: CustodyCounts
  promoters: Array<CustodyCounts & {
    promoterId: string | null
    promoterName: string
    supervisors: Array<{ supervisorId: string | null; supervisorName: string }>
  }>
  supervisors: Array<CustodyCounts & { supervisorId: string | null; supervisorName: string; promoterCount: number }>
}>
```

Implementación: **un solo** `groupBy(['assignedPromoterId', 'assignedSupervisorId', 'custodyState'])` con
`where: { ...this.orgPoolWhere(orgId, allowedVenueIds), custodyState: { in: [PROMOTER_PENDING, PROMOTER_HELD, PROMOTER_REJECTED, SOLD] }, ...(registeredFromVenueId ? { registeredFromVenueId } : {}) }`.
Ambas agregaciones (`promoters`, `supervisors`) y `totals` se derivan **en memoria de esas mismas filas** siguiendo la regla de merge de
§3.1 — no hay un segundo query. Nombres de staff resueltos en **una** lectura bulk sobre el set de ids distintos, nunca N+1 — mismo patrón
que `getOrgSalesByPromoterAndCategory` (`serializedInventory.service.ts:1052-1062`).

`orgPoolWhere(orgId, allowedVenueIds)` es el predicado compartido que incluye el pool org-level (`venueId=null`) además de los venues en
scope. **Usar ese, nunca una igualdad de `venueId` pelada.**

### 3.3 Dos arreglos a `list_serialized_items`

`src/mcp/tools/serialized.ts:343-400` y `listOrgItems` en el servicio.

1. **Devolver el titular.** Añadir `promoter` y `supervisor` a cada ítem del output (hoy sólo sale
   `serialNumber, status, custodyState, category, venueId`, línea 391). Forma exacta, igual en ambos campos:

   ```ts
   promoter: { id: string; name: string } | null   // name = '(empleado eliminado)' si el staff fue borrado
   supervisor: { id: string; name: string } | null
   ```

   Objeto y no string, para que el `id` sirva de insumo a la siguiente llamada. Hoy el tool **filtra** por `assignedPromoterId` pero no lo
   regresa, lo que obliga a una llamada por promotor para saber quién trae qué. Con esto, listar 1,824 ICCIDs con su titular baja de ~65
   llamadas a ~10 páginas.
2. **Filtrar por sucursal receptora.** Añadir `registeredFromVenueId?: string` a los parámetros y al `where` de `listOrgItems`. **Se valida
   con `guard.venueFilter(registeredFromVenueId)` antes de usarlo**, igual que el `venueId` principal: es un id de venue que entra por
   parámetro y no debe poder apuntar fuera del scope de la conexión. Mismo trato en `serialized_custody_by_promoter`.

Resolución de nombres: una lectura bulk por página, igual que arriba. Si el staff fue borrado, `'(empleado eliminado)'` — **nunca** el id
crudo, replicando `sim_custody` (`serialized.ts:185-187`).

### 3.4 Descubribilidad (parte del entregable, no cosmética)

Los `description` de los tools son el único lugar donde el modelo descubre que una capacidad existe. Requisitos:

- `serialized_custody_by_promoter` nombra las preguntas que contesta, en español y en los términos del operador: *"¿cuántos SIMs trae hoy
  cada promotor?"*, *"saldo por promotor"*, *"¿cuántos le quedan por entregar?"*, *"inventario por supervisor"*.
- Dice explícitamente que **este desglose SÍ existe** y que sustituye a llamar `list_serialized_items` promotor por promotor — el patrón que
  ya usa `serialized_sales_by_promoter` (`serialized.ts:404`).
- Declara la semántica mixta de §3.1 en el propio `description`, no sólo en este documento.
- `list_serialized_items` y `sim_custody` apuntan a él para el caso agregado.

---

## 4. Restricción dura

**Sólo métodos NUEVOS en la familia org-aware.** Prohibido modificar `listItems`, `getStockByCategory`, `getCategories`, `scan`,
`registerBatch`, `registerBatchOrg`, `ensureSellable`, `createCategory`: los consumen dashboard y TPV (§2.4). El dashboard white-label no se
toca en este trabajo — ni servicios, ni controllers, ni rutas, ni UI.

Modificar `listOrgItems` **sí** está permitido: su único caller es el MCP (verificado).

---

## 5. Criterios de aceptación

1. `serialized_custody_by_promoter` devuelve, por promotor, los 5 campos, y `asignados == enRevision + enSuPoder + rechazados + vendidos` para
   **cada** fila (de `promoters[]`, de `supervisors[]` y de `totals`).
2. `Σ promoters[].asignados == totals.asignados == Σ supervisors[].asignados`. Lo mismo para los otros 4 campos.
3. **Cada `promoterId` aparece exactamente una vez en `promoters[]`**, aun cuando sus ítems traigan supervisores distintos (regla de merge,
   §3.1). El caso se cubre con un fixture que tiene un promotor repartido entre dos supervisores.
4. **Cuadre entre tools, sin `registeredFromVenueId`:** invocado sin ese filtro, `totals.vendidos` es idéntico a
   `serialized_sales_by_promoter.totalSold` invocado sin rango de fechas, y a `serialized_stock_by_category.totalSold`, sobre la misma org y
   la misma conexión. Los tres resuelven su `where` con `orgPoolWhere(orgId, allowedVenueIds)`. Con el filtro activo el cuadre entre tools
   **no aplica** (los otros dos no lo aceptan); sólo se sostiene el cuadre interno de AC-1/AC-2.
5. Un venue sin el módulo recibe `{ ok: false, moduleRequired: true }` y **ningún dato**.
6. Un venue fuera del scope de la conexión lanza `ScopeError` vía `guard.venueFilter`.
7. Un caller con rol menor a MANAGER recibe el mensaje de rechazo en español y ningún dato.
8. Los ítems del pool org-level (`venueId = null`) **sí** entran en los conteos; los de otra organización **no**.
9. Con `registeredFromVenueId`, los tres bloques (`totals`, `promoters`, `supervisors`) quedan filtrados de forma consistente y AC-1/AC-2
   siguen cumpliéndose sobre el subconjunto.
10. Ítems sin promotor aparecen como fila `"Sin promotor asignado"` (`promoterId: null`) y sin supervisor como
    `"Sin supervisor asignado"` (`supervisorId: null`). No se descartan: descartarlos rompería AC-2.
11. `promoterCount` cuenta promotores distintos por supervisor; `Σ promoterCount >= promoters.length` es un resultado válido y no falla
    ninguna prueba.
12. `list_serialized_items` devuelve `promoter` y `supervisor` en cada ítem y acepta `registeredFromVenueId`.
13. Ningún nombre de staff cae de vuelta a un id: staff borrado se muestra como `'(empleado eliminado)'`. (Los campos `promoterId` /
    `supervisorId` sí se devuelven, por diseño — ver §3.1.)
14. Los 8 métodos venue-scoped de §2.4 no aparecen en el diff: `git diff develop -- src/services/serialized-inventory/serializedInventory.service.ts`
    no toca ninguno de esos bloques de función. Verificación asistida por los 2 tests de regresión sobre `listItems` y `getStockByCategory`,
    que son los únicos dos que este trabajo podría rozar (comparten archivo con `listOrgItems`); los otros 6 no comparten código con nada
    que se modifique.
15. `promoters[]` y `supervisors[]` salen ordenados de forma determinista según §3.1, con la fila nula al final.
16. `registeredFromVenueId` fuera del scope de la conexión lanza `ScopeError`; no se usa como filtro sin validar.
17. `npm run pre-deploy` pasa.

## 6. Plan de pruebas

| Archivo | Qué | Nuevos |
| --- | --- | --- |
| `tests/unit/services/serialized-inventory/getOrgCustodyByPromoter.test.ts` | Mapeo de los 4 estados; `ADMIN_HELD`/`SUPERVISOR_HELD` excluidos; `asignados` = suma (AC-1); filtro `registeredFromVenueId` (AC-9) | +5 |
| ídem | **Merge**: promotor con ítems bajo 2 supervisores aparece 1 sola vez y su arreglo `supervisors` trae los 2 (AC-3); `promoterCount` los cuenta en ambos (AC-11) | +2 |
| ídem | Filas nulas: `promoterId: null` → "Sin promotor asignado"; `supervisorId: null` → "Sin supervisor asignado" (AC-10) | +2 |
| ídem | Cuadre interno AC-2 sobre el fixture compartido | +1 |
| ídem | Aislamiento: `venueId=null` incluido, otra org excluida (AC-8) | +2 |
| `tests/unit/services/serialized-inventory/listOrgItems.test.ts` | `registeredFromVenueId` llega al `where`; nombres resueltos en una lectura bulk (sin N+1) | +2 |
| ídem | Orden determinista: `asignados` desc, desempate por nombre, fila nula al final (AC-15) | +1 |
| `tests/unit/mcp/tools/serializedCustodyByPromoter.test.ts` | Gates en orden: módulo apagado (AC-5), venue fuera de scope (AC-6), rol < MANAGER (AC-7), staff borrado → `'(empleado eliminado)'` (AC-13) | +4 |
| ídem | `registeredFromVenueId` fuera de scope lanza `ScopeError` (AC-16) | +1 |
| `tests/unit/services/serialized-inventory/dashboardRegression.test.ts` | `listItems` y `getStockByCategory` devuelven lo mismo antes y después (AC-14) | +2 |

**AC-4 (cuadre entre tools) no se prueba con `prismaMock`** — un mock no puede demostrar que tres `where` distintos producen el mismo
conjunto. Se verifica así:

- **Script:** `scripts/temp-custody-reconcile.ts`, modelado sobre `scripts/mcp-money-reconcile.ts`.
- **Comando:** `npx ts-node -r tsconfig-paths/register scripts/temp-custody-reconcile.ts <orgId>`. El `orgId` entra **por argumento**, nunca
  hardcodeado — este repo es público.
- **Entorno:** una base con una org que tenga `SERIALIZED_INVENTORY` activo y ventas serializadas reales; la base local sembrada sirve si
  cumple eso.
- **Qué compara:** `serialized_custody_by_promoter.totals.vendidos` vs `serialized_sales_by_promoter.totalSold` (sin rango) vs
  `serialized_stock_by_category.totalSold`. Sale 0 si los tres cuadran, 1 con el diff impreso si no.
- **Evidencia:** la salida del script se pega en la descripción del PR. El script se borra antes de commitear (política de
  `scripts/temp-*.ts` en `.claude/rules/testing-and-git.md`).

**Fixture compartido** (un solo `SerializedItem[]` reusado por los tests de cuadre, merge y aislamiento): los 4 estados atribuibles,
`ADMIN_HELD` y `SUPERVISOR_HELD` (deben quedar fuera), un ítem `venueId=null`, uno de otra org, uno sin promotor, uno sin supervisor, y un
promotor repartido entre dos supervisores.

`prismaMock` lista los modelos a mano en `tests/__helpers__/setup.ts`: si `serializedItem.groupBy` no está registrado ahí, revienta hasta
darlo de alta.


## 7. Rollback

Aditivo puro y sin migración: revertir el commit quita el tool nuevo y los dos campos de `list_serialized_items`. Ningún dato se escribe,
ninguna columna cambia, ningún consumidor existente pierde un campo (regla cross-repo: nunca se quita un campo de una respuesta).

## 8. Esfuerzo

| Componente | Estimado |
| --- | --- |
| `getOrgCustodyByPromoter` (groupBy + rollup + nombres bulk) | ~1.5 h |
| Registro del tool + descriptions + gates | ~1 h |
| `list_serialized_items` (2 arreglos) | ~1 h |
| Tests unitarios (20) | ~2 h |
| Script temporal de cuadre AC-4 contra base real (se borra antes de commitear) | ~0.5 h |
| `npm run format && lint:fix && pre-deploy` | ~0.5 h |
| **Total** | **~6.5 h** |

## 9. Archivos

| Archivo | Cambio |
| --- | --- |
| `src/services/serialized-inventory/serializedInventory.service.ts` | **Nuevo** `getOrgCustodyByPromoter`; `listOrgItems` acepta `registeredFromVenueId` y devuelve promotor/supervisor |
| `src/mcp/tools/serialized.ts:343` | `list_serialized_items`: params + output |
| `src/mcp/tools/serialized.ts` (nuevo bloque) | Registro de `serialized_custody_by_promoter` |
| `tests/unit/services/serialized-inventory/getOrgCustodyByPromoter.test.ts` | **Nuevo** — mapeo, merge, filas nulas, cuadre, aislamiento |
| `tests/unit/services/serialized-inventory/listOrgItems.test.ts` | **Nuevo** — filtro y resolución bulk de nombres |
| `tests/unit/services/serialized-inventory/dashboardRegression.test.ts` | **Nuevo** — AC-14 |
| `tests/unit/mcp/tools/serializedCustodyByPromoter.test.ts` | **Nuevo** — gates y forma de salida |
| `tests/__helpers__/setup.ts` | Registrar `serializedItem.groupBy` en `prismaMock` si aún no está |

Sin cambios en `prisma/schema.prisma` → sin migración y sin `npm run schema:map`.

## 10. Fuera de alcance

- **Histórico "cuántas se le entregaron alguna vez"** (contando las recogidas). Vive en `SerializedItemCustodyEvent`, es una consulta
  distinta, y mezclarla con la foto haría que `asignados` dejara de cuadrar. Se agrega después si el operador lo pide.
- Cualquier cambio al dashboard white-label, incluido llevar este corte a la UI o al export de Excel.
- Writes: reasignar, recoger o corregir custodia desde el MCP.
- Tool de export tabular listo para pegar (decisión del founder: sólo arreglar el acceso a datos).
- Atribución de canal tienda vs evento por punto de venta. Ya es alcanzable vía `serialized_sales_by_promoter`, que devuelve promotor ×
  categoría y la categoría distingue el tipo de SIM.

## 11. Relacionados

- [`2026-07-08-playtelecom-mcp-coverage-design.md`](2026-07-08-playtelecom-mcp-coverage-design.md) — ronda 1 del mismo patrón; define
  §4.0 la semántica del pool org-level y el precedente de tier.
- Commit `74db19e9` — `serialized_sales_by_promoter`, ronda 2.
- `.claude/rules/feature-gating.md` — Module vs Feature: `SERIALIZED_INVENTORY` se gatea con `isModuleEnabled`, nunca con el resolver de
  Features.
- `.claude/rules/critical-warnings.md` — invariantes del MCP customer-facing.
