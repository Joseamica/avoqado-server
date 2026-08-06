# Autorización y segregación de funciones en compras — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que ninguna compra por encima de un monto configurable por sucursal pueda autorizarse sola, y que quien autoriza no sea forzosamente quien recibe — sin cambiar el comportamiento de los ~70 locales que ya operan.

**Architecture:** Se conecta un flujo de autorización que **ya existe y está probado** (`purchaseOrderWorkflow.service.ts`) pero que hoy no tiene llamadores, se cierran los tres caminos que lo rodean, y se parte el permiso `inventory:update` en `approve` + `receive` con un alias de compatibilidad. La política vive en dos columnas nuevas de `VenueSettings`, apagadas por default.

**Tech Stack:** Express + TypeScript, Prisma/PostgreSQL, Jest, React 18 + TanStack Query (dashboard).

**Spec:** `docs/superpowers/specs/2026-08-06-autorizacion-y-segregacion-compras-design.md`

## Global Constraints

- **El dinero va en PESOS, 1:1.** Nunca centavos. `Decimal`, nunca float.
- **Toda mutación relevante escribe `ActivityLog`** en el MISMO cambio.
- **El MCP (`src/mcp/tools/`) va en lockstep** en el MISMO cambio.
- **CERO cambios en `/mobile`** — iOS y Android se tocan en paralelo desde otras sesiones.
- **NO tocar** el enum `PurchaseOrderStatus` (10 valores en producción), `deductSimpleStock`, `validateOrderInventoryAvailability`, el enum `InventoryMethod`, el reducer offline ni el corte de caja.
- **Usar `createdBy`, NUNCA `createdById`** — en producción `createdById` está en 0 de 5 órdenes.
- **Con el interruptor apagado el comportamiento debe ser byte-idéntico a hoy.** Es la restricción número uno del founder.
- **`npm run audit:permissions` debe salir 0** antes de dar por terminada cualquier tarea de permisos.
- Toda consulta filtra por `venueId`.
- Mensajes de Zod **en español** (se muestran al usuario tal cual).
- **No commitear sin permiso explícito del founder.** Los pasos de commit de este plan quedan preparados pero se ejecutan sólo cuando él lo autorice.

---

## Mapa de archivos

### Backend (`avoqado-server`)

| Archivo | Responsabilidad | Acción |
| --- | --- | --- |
| `prisma/schema.prisma` | 2 columnas en `VenueSettings` | Modificar |
| `prisma/migrations/<ts>_purchase_approval_policy/migration.sql` | Migración aditiva | Crear |
| `src/services/dashboard/purchaseApprovalPolicy.ts` | **Nuevo.** Función pura: dado un total y los ajustes del venue, ¿requiere autorización? Única fuente de esa decisión. | Crear |
| `src/services/dashboard/purchaseOrderWorkflow.service.ts` | `product` en los 7 includes + guard de edición por estado + `requestChange` | Modificar |
| `src/services/dashboard/purchaseOrder.service.ts` | `createPurchaseOrder` consulta la política; `updatePurchaseOrder` rechaza estados bloqueados | Modificar |
| `src/lib/permissions.ts` | `inventory:approve`, `inventory:receive`, alias y dependencias | Modificar |
| `src/routes/dashboard/inventory.routes.ts` | 3 rutas nuevas; re-apuntar `approve`; permisos nuevos | Modificar |
| `src/controllers/dashboard/inventory/purchaseOrder.controller.ts` | Controladores de submit / reject / request-change / auto-aprobadas | Modificar |
| `src/schemas/dashboard/inventory.schema.ts` | Zod de rechazo (motivo obligatorio); quitar `status` libre del PUT | Modificar |
| `src/mcp/tools/procurement.ts` | Exponer política y las tres huellas | Modificar |
| `src/services/dashboard/venueSettings.service.ts` *(o donde vivan hoy)* | Leer/escribir las 2 columnas | Modificar |

### Dashboard (`avoqado-web-dashboard`)

| Archivo | Responsabilidad | Acción |
| --- | --- | --- |
| `src/services/purchaseOrder.service.ts` | Métodos submit/reject/requestChange + tipos | Modificar |
| `src/pages/Inventory/PurchaseOrders/components/POActions.tsx` | Botones por estado; "Rechazar" deja de cancelar | Modificar |
| `src/pages/Inventory/PurchaseOrders/PurchaseOrderDetailPage.tsx` | Las tres huellas visibles | Modificar |
| `src/pages/Inventory/PurchaseOrders/components/RejectOrderDialog.tsx` | **Nuevo.** Motivo obligatorio | Crear |
| `src/pages/Settings/...` | Interruptor + monto | Modificar |

### Tests

| Archivo | Cubre |
| --- | --- |
| `tests/unit/services/dashboard/purchaseApprovalPolicy.test.ts` | **Nuevo.** El umbral, incluidos los bordes |
| `tests/unit/services/dashboard/purchaseOrderStateGuard.test.ts` | **Nuevo.** Qué estados se pueden editar |
| `tests/unit/lib/permissions.purchaseSegregation.test.ts` | **Nuevo.** Que nadie pierde accesos |
| `tests/unit/routes/inventory.routes.permissions.test.ts` | Existente — se extiende |

---

## Orden y paralelismo

```
Tarea 1 (política)  ─┐
Tarea 2 (includes)  ─┼─→ Tarea 4 (rutas) ─→ Tarea 6 (crear respeta política) ─→ Tarea 7 (dashboard)
Tarea 3 (permisos)  ─┘                                                        ↘
                                                                               Tarea 8 (huellas) ─→ Tarea 9 (MCP)
Tarea 5 (guard) depende sólo de 1
Tarea 10 (roles y venue demo) depende de 3
Tarea 11 (/full-testing) depende de TODO
```

**Se pueden hacer en paralelo:** 1, 2 y 3 (tocan archivos distintos, sin dependencias).
**Cuello de botella:** la 4 espera a 2 y 3.

---

### Task 1: Política de autorización por sucursal

**Files:**
- Modify: `prisma/schema.prisma` (model `VenueSettings`)
- Create: `prisma/migrations/<timestamp>_purchase_approval_policy/migration.sql`
- Create: `src/services/dashboard/purchaseApprovalPolicy.ts`
- Test: `tests/unit/services/dashboard/purchaseApprovalPolicy.test.ts`

**Interfaces:**
- Produces: `requiereAutorizacion(total: Decimal | number, ajustes: PoliticaAutorizacion | null): boolean` y el tipo `PoliticaAutorizacion = { requirePurchaseApproval: boolean; purchaseApprovalThreshold: Decimal | null }`. Las tareas 5 y 6 la consumen.

- [ ] **Step 1: Escribir la prueba que falla**

```typescript
// tests/unit/services/dashboard/purchaseApprovalPolicy.test.ts
import { Decimal } from '@prisma/client/runtime/library'
import { requiereAutorizacion } from '@/services/dashboard/purchaseApprovalPolicy'

describe('requiereAutorizacion', () => {
  it('sin ajustes del venue no exige nada — es el comportamiento de los ~70 locales de hoy', () => {
    expect(requiereAutorizacion(999999, null)).toBe(false)
  })

  it('con el interruptor apagado no exige nada, aunque haya umbral', () => {
    expect(
      requiereAutorizacion(999999, { requirePurchaseApproval: false, purchaseApprovalThreshold: new Decimal(100) }),
    ).toBe(false)
  })

  it('prendido SIN umbral configurado exige autorización para TODA orden', () => {
    // El default seguro: prender el control y que no controle nada sería peor.
    expect(requiereAutorizacion(1, { requirePurchaseApproval: true, purchaseApprovalThreshold: null })).toBe(true)
  })

  it('prendido, por DEBAJO del umbral no exige', () => {
    expect(
      requiereAutorizacion(4999.99, { requirePurchaseApproval: true, purchaseApprovalThreshold: new Decimal(5000) }),
    ).toBe(false)
  })

  it('EXACTAMENTE en el umbral no exige — el umbral es el último monto que pasa solo', () => {
    expect(
      requiereAutorizacion(5000, { requirePurchaseApproval: true, purchaseApprovalThreshold: new Decimal(5000) }),
    ).toBe(false)
  })

  it('un centavo ARRIBA del umbral sí exige', () => {
    expect(
      requiereAutorizacion(5000.01, { requirePurchaseApproval: true, purchaseApprovalThreshold: new Decimal(5000) }),
    ).toBe(true)
  })

  it('compara con precisión decimal, no con float', () => {
    // 0.1 + 0.2 en float da 0.30000000000000004 y pasaría un umbral de 0.3.
    expect(
      requiereAutorizacion(new Decimal('0.1').plus('0.2'), {
        requirePurchaseApproval: true,
        purchaseApprovalThreshold: new Decimal('0.3'),
      }),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/services/dashboard/purchaseApprovalPolicy.test.ts`
Expected: FAIL — `Cannot find module '@/services/dashboard/purchaseApprovalPolicy'`

- [ ] **Step 3: Escribir la implementación mínima**

```typescript
// src/services/dashboard/purchaseApprovalPolicy.ts
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Política de autorización de compras, por sucursal.
 *
 * Es la forma que usa Odoo (ajuste "Purchase Order Approval" + campo "Minimum
 * Amount"): por debajo del monto la orden se confirma directo; por encima pasa a
 * autorización. Antes esto vivía cableado a fuego en la tabla de transiciones con el
 * comentario "Direct approval (for small orders)" — la intuición era correcta pero no
 * era configurable, y por eso NINGUNA compra pasaba nunca por autorización.
 *
 * Esta función es la ÚNICA fuente de esa decisión. Si aparece un segundo lugar que
 * decida lo mismo, tarde o temprano van a discrepar.
 */
export type PoliticaAutorizacion = {
  requirePurchaseApproval: boolean
  purchaseApprovalThreshold: Decimal | null
}

export function requiereAutorizacion(total: Decimal | number, ajustes: PoliticaAutorizacion | null): boolean {
  // Sin ajustes o con el interruptor apagado: exactamente como opera hoy.
  if (!ajustes?.requirePurchaseApproval) return false

  // Interruptor prendido y umbral sin configurar = TODA orden requiere autorización.
  // Es el default seguro: prender el control y que no controle nada sería la peor de
  // las dos lecturas posibles.
  if (ajustes.purchaseApprovalThreshold === null) return true

  // Estrictamente mayor: el umbral es el último monto que NO requiere autorización,
  // igual que el "Minimum Amount" de Odoo. Comparación en Decimal, nunca en float.
  return new Decimal(total).greaterThan(ajustes.purchaseApprovalThreshold)
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx jest tests/unit/services/dashboard/purchaseApprovalPolicy.test.ts`
Expected: PASS — 7 pruebas

- [ ] **Step 5: Agregar las columnas al esquema**

En `prisma/schema.prisma`, dentro de `model VenueSettings`, junto a `enforceTableOwnership` (que ya vive ahí con este mismo patrón de política por sucursal):

```prisma
  // Autorización de compras (forma de Odoo: interruptor + monto mínimo).
  // APAGADO por default: los ~70 locales vivos siguen operando exactamente igual.
  // Con el interruptor prendido y el umbral en NULL, TODA orden requiere autorización
  // — el default seguro. La comparación es `total > umbral`, estrictamente mayor.
  // La decisión vive en purchaseApprovalPolicy.ts; no la dupliques.
  requirePurchaseApproval   Boolean  @default(false)
  purchaseApprovalThreshold Decimal? @db.Decimal(12, 2) // PESOS, 1:1
```

- [ ] **Step 6: Generar la migración sin aplicarla**

Run: `npx prisma migrate dev --create-only --name purchase_approval_policy`

- [ ] **Step 7: Agregar el lock_timeout que usa la casa**

Abrir el `migration.sql` generado y anteponer:

```sql
-- Dos columnas nuevas con default: cambio de catálogo, instantáneo, NO reescribe la
-- tabla (PG11+). Nacen apagadas, así que ningún venue cambia de comportamiento.
-- lock_timeout: si el lock no se adquiere en 5s aborta limpio y se reintenta el
-- deploy - nunca se queda encolado bloqueando la operación.
SET lock_timeout = '5s';
```

- [ ] **Step 8: Aplicar y regenerar el mapa del esquema**

Run: `npx prisma migrate dev && npm run schema:map`
Expected: migración aplicada, `docs/SCHEMA_MAP.md` regenerado.

- [ ] **Step 9: Commit (pedir permiso antes)**

```bash
git add prisma/schema.prisma prisma/migrations docs/SCHEMA_MAP.md src/services/dashboard/purchaseApprovalPolicy.ts tests/unit/services/dashboard/purchaseApprovalPolicy.test.ts
git commit -m "feat(compras): politica de autorizacion por sucursal (interruptor + umbral)"
```

---

### Task 2: `product` en los includes del servicio de workflow

**Files:**
- Modify: `src/services/dashboard/purchaseOrderWorkflow.service.ts` (líneas 109, 158, 210, 254, 301, 339, 414)

**Interfaces:**
- Consumes: nada.
- Produces: nada nuevo. Corrige el payload que la Tarea 4 va a exponer.

> **Por qué esta tarea existe:** ayer se completaron los 14 `include` de
> `purchaseOrder.service.ts` para que los renglones de mercancía de reventa no salieran
> anónimos. `purchaseOrderWorkflow.service.ts` tiene **sus propios 7 includes** y no se
> tocó porque ese archivo no tenía llamadores. La Tarea 4 le da llamadores. Si no se
> arregla antes, aprobar una orden de tienda devolvería renglones sin nombre.

- [ ] **Step 1: Escribir la prueba que falla**

```typescript
// tests/unit/services/dashboard/purchaseOrderWorkflow.includes.test.ts
import * as fs from 'fs'
import * as path from 'path'

const ARCHIVO = path.join(__dirname, '../../../../src/services/dashboard/purchaseOrderWorkflow.service.ts')

describe('purchaseOrderWorkflow: los includes cargan las DOS relaciones', () => {
  const fuente = fs.readFileSync(ARCHIVO, 'utf8')

  it('cada include de rawMaterial trae también product', () => {
    // Un renglón apunta a un insumo O a un producto de reventa. Cargar sólo uno
    // devuelve renglones anónimos (nombre y sku en null) para las órdenes de tienda.
    const lineas = fuente.split('\n')
    const sinProducto: number[] = []
    lineas.forEach((linea, i) => {
      if (!/^\s*rawMaterial: true,/.test(linea)) return
      const ventana = lineas.slice(i + 1, i + 4).join('\n')
      if (!/^\s*product\s*:/m.test(ventana)) sinProducto.push(i + 1)
    })
    expect(sinProducto).toEqual([])
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/services/dashboard/purchaseOrderWorkflow.includes.test.ts`
Expected: FAIL — lista con 7 números de línea.

- [ ] **Step 3: Agregar `product: true` en los 7 sitios**

En cada uno de los includes, justo debajo de `rawMaterial: true,`:

```typescript
          rawMaterial: true,
          product: true, // renglón de mercancía de reventa: sin esto sale anónimo
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx jest tests/unit/services/dashboard/purchaseOrderWorkflow.includes.test.ts && npm run typecheck`
Expected: PASS y 0 errores de tipos.

- [ ] **Step 5: Commit (pedir permiso antes)**

```bash
git add src/services/dashboard/purchaseOrderWorkflow.service.ts tests/unit/services/dashboard/purchaseOrderWorkflow.includes.test.ts
git commit -m "fix(compras): el workflow tambien carga product en sus includes"
```

---

### Task 3: Permisos `inventory:approve` e `inventory:receive`

**Files:**
- Modify: `src/lib/permissions.ts`
- Test: `tests/unit/lib/permissions.purchaseSegregation.test.ts`

**Interfaces:**
- Produces: los strings `'inventory:approve'` e `'inventory:receive'`, que la Tarea 4 usa en `checkPermission(...)` y la Tarea 7 en `<PermissionGate>`.

> 🔴 **El alias no es opcional.** Ambas rutas usan `inventory:update` HOY
> (`inventory.routes.ts:711` y `:721`). Sin el alias, el día del deploy los ~70 locales
> pierden el botón de recibir.

- [ ] **Step 1: Escribir la prueba que falla**

```typescript
// tests/unit/lib/permissions.purchaseSegregation.test.ts
import { StaffRole } from '@prisma/client'
import { hasPermission, DEFAULT_PERMISSIONS, INDIVIDUAL_PERMISSIONS_BY_RESOURCE } from '@/lib/permissions'

describe('segregación de compras: aprobar ≠ recibir', () => {
  describe('🔴 nadie pierde accesos el día del deploy', () => {
    it('quien hoy tiene inventory:update conserva el poder de aprobar', () => {
      expect(hasPermission(StaffRole.MANAGER, ['inventory:update'], 'inventory:approve')).toBe(true)
    })

    it('quien hoy tiene inventory:update conserva el poder de recibir', () => {
      expect(hasPermission(StaffRole.MANAGER, ['inventory:update'], 'inventory:receive')).toBe(true)
    })

    it('OWNER y ADMIN los heredan por su comodín inventory:*', () => {
      for (const rol of [StaffRole.OWNER, StaffRole.ADMIN]) {
        expect(hasPermission(rol, [], 'inventory:approve')).toBe(true)
        expect(hasPermission(rol, [], 'inventory:receive')).toBe(true)
      }
    })

    it('MANAGER los trae en sus defaults, explícitos', () => {
      expect(DEFAULT_PERMISSIONS[StaffRole.MANAGER]).toContain('inventory:approve')
      expect(DEFAULT_PERMISSIONS[StaffRole.MANAGER]).toContain('inventory:receive')
    })
  })

  describe('la segregación de verdad', () => {
    it('un rol SÓLO con receive NO puede aprobar', () => {
      expect(hasPermission(StaffRole.CASHIER, ['inventory:read', 'inventory:receive'], 'inventory:approve')).toBe(false)
    })

    it('un rol SÓLO con approve NO puede recibir', () => {
      expect(hasPermission(StaffRole.CASHIER, ['inventory:read', 'inventory:approve'], 'inventory:receive')).toBe(false)
    })

    it('el alias NO va al revés: approve no otorga update', () => {
      // Si fuera bidireccional, darle "aprobar" a alguien le daría también editar.
      expect(hasPermission(StaffRole.CASHIER, ['inventory:approve'], 'inventory:update')).toBe(false)
    })
  })

  describe('asignables desde el editor de roles', () => {
    it('aparecen en el catálogo, o no se pueden dar individualmente', () => {
      const deInventario = INDIVIDUAL_PERMISSIONS_BY_RESOURCE['inventory'] ?? []
      const claves = deInventario.map((p: any) => (typeof p === 'string' ? p : p.key ?? p.permission))
      expect(claves).toContain('inventory:approve')
      expect(claves).toContain('inventory:receive')
    })
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/lib/permissions.purchaseSegregation.test.ts`
Expected: FAIL en las aserciones de alias y catálogo.

- [ ] **Step 3: Agregar las dependencias y el alias**

En `PERMISSION_DEPENDENCIES` de `src/lib/permissions.ts`, junto al bloque de
`inventory-transfers:*` que ya usa este molde:

```typescript
  // Segregación de funciones en compras: quien autoriza no tiene que ser quien recibe.
  // Cada uno arrastra inventory:read + products:read — sin eso el rol no carga ni la
  // lista de órdenes y la pantalla sale vacía.
  'inventory:approve': ['inventory:read', 'inventory:approve', 'products:read'],
  'inventory:receive': ['inventory:read', 'inventory:receive', 'products:read'],
```

Y en la entrada YA existente de `inventory:update`, agregar los dos nuevos — **este es
el alias de compatibilidad, y va en UN SOLO sentido**:

```typescript
  // 🔴 ALIAS DE COMPATIBILIDAD, unidireccional. Hasta hoy aprobar y recibir vivían
  // bajo `inventory:update`; quien lo tenga conserva ambos poderes. Al revés NO:
  // darle "aprobar" a alguien no debe darle también editar el catálogo.
  // Sin esto, el día del deploy los ~70 locales pierden el botón de recibir.
  'inventory:update': ['inventory:read', 'inventory:update', 'products:read', 'inventory:approve', 'inventory:receive'],
```

- [ ] **Step 4: Agregarlos a los defaults de MANAGER y al catálogo**

En `DEFAULT_PERMISSIONS[StaffRole.MANAGER]`, junto a los demás `inventory:*`:

```typescript
    'inventory:approve', // autoriza órdenes de compra por encima del umbral del venue
    'inventory:receive', // recibe mercancía contra una orden autorizada
```

Y en `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`, en el recurso `inventory`, siguiendo el
formato exacto que ya usan sus vecinos en ese arreglo.

- [ ] **Step 5: Correr las pruebas y la auditoría**

Run: `npx jest tests/unit/lib/permissions.purchaseSegregation.test.ts && npm run audit:permissions`
Expected: PASS y la auditoría en 0. Si sale `PHANTOM`, el permiso quedó sin rol que lo satisfaga: revisar el paso 4.

- [ ] **Step 6: Commit (pedir permiso antes)**

```bash
git add src/lib/permissions.ts tests/unit/lib/permissions.purchaseSegregation.test.ts
git commit -m "feat(permisos): separa inventory:approve de inventory:receive con alias de compatibilidad"
```

---

### Task 4: Conectar las rutas de autorización

**Files:**
- Modify: `src/routes/dashboard/inventory.routes.ts:711`
- Modify: `src/controllers/dashboard/inventory/purchaseOrder.controller.ts:121`
- Modify: `src/schemas/dashboard/inventory.schema.ts`
- Test: `tests/unit/routes/inventory.routes.permissions.test.ts` (existente)

**Interfaces:**
- Consumes: `inventory:approve` / `inventory:receive` (Tarea 3); los includes corregidos (Tarea 2).
- Produces: `POST …/purchase-orders/:purchaseOrderId/submit-for-approval`, `…/reject`. La Tarea 7 los consume desde el dashboard.

- [ ] **Step 1: Escribir la prueba que falla**

```typescript
// añadir a tests/unit/routes/inventory.routes.permissions.test.ts
describe('segregación de compras en las rutas', () => {
  it('aprobar exige inventory:approve, no inventory:update', () => {
    const ruta = encontrarRuta('post', '/purchase-orders/:purchaseOrderId/approve')
    expect(ruta.requiredPermission).toBe('inventory:approve')
  })

  it('recibir exige inventory:receive', () => {
    const ruta = encontrarRuta('post', '/purchase-orders/:purchaseOrderId/receive')
    expect(ruta.requiredPermission).toBe('inventory:receive')
  })

  it('rechazar exige inventory:approve — es la otra cara de autorizar', () => {
    const ruta = encontrarRuta('post', '/purchase-orders/:purchaseOrderId/reject')
    expect(ruta.requiredPermission).toBe('inventory:approve')
  })

  it('enviar a autorización lo hace quien captura, con inventory:update', () => {
    const ruta = encontrarRuta('post', '/purchase-orders/:purchaseOrderId/submit-for-approval')
    expect(ruta.requiredPermission).toBe('inventory:update')
  })
})
```

> Usar el helper de introspección que ese archivo ya tiene; si se llama distinto,
> conservar el nombre existente en vez de inventar `encontrarRuta`.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/routes/inventory.routes.permissions.test.ts`
Expected: FAIL — las rutas de submit y reject no existen.

- [ ] **Step 3: Zod del rechazo, con motivo obligatorio**

En `src/schemas/dashboard/inventory.schema.ts`:

```typescript
export const RejectPurchaseOrderSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    purchaseOrderId: z.string().cuid(),
  }),
  body: z.object({
    // Obligatorio a propósito: un rechazo sin razón le hace perder el día a quien
    // capturó la orden, que no sabe qué corregir.
    reason: z.string().trim().min(1, 'El motivo del rechazo es obligatorio').max(500),
  }),
})
```

- [ ] **Step 4: Controladores**

En `src/controllers/dashboard/inventory/purchaseOrder.controller.ts`, importar el
workflow y **re-apuntar `approvePurchaseOrder`** (hoy llama al servicio `@deprecated`):

```typescript
import * as purchaseOrderWorkflow from '../../../services/dashboard/purchaseOrderWorkflow.service'

export async function approvePurchaseOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, purchaseOrderId } = req.params
    const staffId = req.authContext?.userId
    // El servicio del workflow es el que valida la transición y estampa approvedBy /
    // approvedAt. El de purchaseOrder.service.ts está marcado @deprecated y no lo hace.
    const purchaseOrder = await purchaseOrderWorkflow.approvePurchaseOrder(venueId, purchaseOrderId, staffId)
    res.json({ success: true, message: 'Orden de compra autorizada', data: purchaseOrder })
  } catch (error) {
    next(error)
  }
}

export async function submitPurchaseOrderForApproval(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, purchaseOrderId } = req.params
    const staffId = req.authContext?.userId
    const purchaseOrder = await purchaseOrderWorkflow.submitForApproval(venueId, purchaseOrderId, staffId)
    res.json({ success: true, message: 'Orden enviada a autorización', data: purchaseOrder })
  } catch (error) {
    next(error)
  }
}

export async function rejectPurchaseOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, purchaseOrderId } = req.params
    const { reason } = req.body
    const staffId = req.authContext?.userId
    const purchaseOrder = await purchaseOrderWorkflow.rejectPurchaseOrder(venueId, purchaseOrderId, reason, staffId)
    res.json({ success: true, message: 'Orden de compra rechazada', data: purchaseOrder })
  } catch (error) {
    next(error)
  }
}
```

- [ ] **Step 5: Rutas**

En `src/routes/dashboard/inventory.routes.ts`, reemplazar la línea 711 y agregar las dos nuevas:

```typescript
// Autorizar / rechazar: `inventory:approve`. Antes ambas usaban `inventory:update`,
// que era el mismo permiso con el que se recibe — imposible separar funciones.
router.post('/purchase-orders/:purchaseOrderId/approve', checkPermission('inventory:approve'), purchaseOrderController.approvePurchaseOrder)

router.post(
  '/purchase-orders/:purchaseOrderId/reject',
  checkPermission('inventory:approve'),
  validateRequest(RejectPurchaseOrderSchema),
  purchaseOrderController.rejectPurchaseOrder,
)

// Enviar a autorización lo hace quien captura la orden, no quien la autoriza.
router.post(
  '/purchase-orders/:purchaseOrderId/submit-for-approval',
  checkPermission('inventory:update'),
  purchaseOrderController.submitPurchaseOrderForApproval,
)
```

Y en la ruta de recibir (línea ~721) cambiar `checkPermission('inventory:update')` por
`checkPermission('inventory:receive')`.

- [ ] **Step 6: Correr las pruebas**

Run: `npx jest tests/unit/routes/inventory.routes.permissions.test.ts && npm run audit:permissions && npm run typecheck`
Expected: todo verde, auditoría en 0.

- [ ] **Step 7: Commit (pedir permiso antes)**

```bash
git add src/routes/dashboard/inventory.routes.ts src/controllers/dashboard/inventory/purchaseOrder.controller.ts src/schemas/dashboard/inventory.schema.ts tests/unit/routes/inventory.routes.permissions.test.ts
git commit -m "feat(compras): conecta submit/approve/reject al workflow real"
```

---

### Task 5: Candado por estado y "Solicitar cambio"

**Files:**
- Modify: `src/services/dashboard/purchaseOrder.service.ts` (`updatePurchaseOrder`)
- Modify: `src/services/dashboard/purchaseOrderWorkflow.service.ts` (nueva `requestChange`)
- Test: `tests/unit/services/dashboard/purchaseOrderStateGuard.test.ts`

**Interfaces:**
- Consumes: `requiereAutorizacion` (Tarea 1).
- Produces: `requestChange(venueId, purchaseOrderId, staffId?)`. La Tarea 7 la consume.

> **Ya implementado ayer, NO rehacer:** `updatePurchaseOrder` ya rechaza reemplazar
> renglones cuando algún renglón tiene `quantityReceived > 0`. Esta tarea **agrega** el
> candado por ESTADO encima de ese.

- [ ] **Step 1: Escribir la prueba que falla**

```typescript
// tests/unit/services/dashboard/purchaseOrderStateGuard.test.ts
import { PurchaseOrderStatus } from '@prisma/client'
import { estadoPermiteEdicion } from '@/services/dashboard/purchaseOrderWorkflow.service'

describe('qué estados dejan editar una orden', () => {
  it('BORRADOR y RECHAZADA sí — son las que el capturista tiene que poder corregir', () => {
    expect(estadoPermiteEdicion(PurchaseOrderStatus.DRAFT)).toBe(true)
    expect(estadoPermiteEdicion(PurchaseOrderStatus.REJECTED)).toBe(true)
  })

  it('PENDIENTE DE AUTORIZACIÓN no — cambiarla mientras la revisan invalida la revisión', () => {
    expect(estadoPermiteEdicion(PurchaseOrderStatus.PENDING_APPROVAL)).toBe(false)
  })

  it('AUTORIZADA no — si no, se autoriza por $5,000 y se edita a $50,000', () => {
    expect(estadoPermiteEdicion(PurchaseOrderStatus.APPROVED)).toBe(false)
  })

  it('los estados posteriores tampoco', () => {
    for (const estado of [
      PurchaseOrderStatus.SENT,
      PurchaseOrderStatus.CONFIRMED,
      PurchaseOrderStatus.SHIPPED,
      PurchaseOrderStatus.PARTIAL,
      PurchaseOrderStatus.RECEIVED,
      PurchaseOrderStatus.CANCELLED,
    ]) {
      expect(estadoPermiteEdicion(estado)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/services/dashboard/purchaseOrderStateGuard.test.ts`
Expected: FAIL — `estadoPermiteEdicion` no existe.

- [ ] **Step 3: Implementar el predicado y `requestChange`**

En `src/services/dashboard/purchaseOrderWorkflow.service.ts`:

```typescript
/**
 * Sólo se edita una orden que todavía no ha sido revisada por nadie.
 *
 * Es la trampa clásica del control interno: si una orden AUTORIZADA se puede editar,
 * alguien la autoriza por $5,000 y luego la cambia a $50,000. Dynamics lo resuelve con
 * "Request change", que regresa la orden a borrador y la obliga a repasar la
 * autorización; ese camino nos da gratis la semántica de SAP (sólo los aumentos
 * vuelven a pedir permiso), porque al reenviarla se re-evalúa el umbral con el monto
 * nuevo.
 */
export function estadoPermiteEdicion(estado: PurchaseOrderStatus): boolean {
  return estado === PurchaseOrderStatus.DRAFT || estado === PurchaseOrderStatus.REJECTED
}

/**
 * Regresa una orden AUTORIZADA a borrador para poder corregirla. Al reenviarla vuelve
 * a pasar por la política de autorización con su monto nuevo.
 */
export async function requestChange(venueId: string, purchaseOrderId: string, staffId?: string) {
  const order = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, venueId } })
  if (!order) throw new AppError('Orden de compra no encontrada', 404)

  if (order.status !== PurchaseOrderStatus.APPROVED && order.status !== PurchaseOrderStatus.PENDING_APPROVAL) {
    throw new AppError(`No se puede solicitar cambio sobre una orden en estado ${order.status}`, 400)
  }

  const result = await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: {
      status: PurchaseOrderStatus.DRAFT,
      approvedBy: null,
      approvedAt: null,
    },
  })

  logAction({
    staffId,
    venueId,
    action: 'PURCHASE_ORDER_CHANGE_REQUESTED',
    entity: 'PurchaseOrder',
    entityId: purchaseOrderId,
    data: { estadoAnterior: order.status, totalAlMomento: order.total.toString() },
  })

  return result
}
```

- [ ] **Step 4: Aplicar el candado en `updatePurchaseOrder`**

En `src/services/dashboard/purchaseOrder.service.ts`, dentro de `updatePurchaseOrder`,
junto al guard de recepciones que ya está ahí:

```typescript
  // Candado por ESTADO, encima del de recepciones que ya existe. Una orden que ya fue
  // enviada a autorización o autorizada no se edita: para corregirla hay que usar
  // "Solicitar cambio", que la regresa a borrador y la obliga a repasar el umbral.
  //
  // ⚠️ Se evalúa SÓLO cuando se mandan `items` o montos. Un cambio de notas o de fecha
  // esperada no toca el dinero y no debe bloquearse — y sobre todo, el job de recompra
  // automática (autoReorder.service.ts:408) crea órdenes en DRAFT y luego las actualiza;
  // un guard ciego lo rompería en silencio en los locales vivos.
  if (data.items && !estadoPermiteEdicion(existingOrder.status)) {
    throw new AppError(
      `Esta orden está en estado ${existingOrder.status} y sus renglones ya no se pueden editar. ` +
        `Usa "Solicitar cambio" para regresarla a borrador si necesitas corregirla.`,
      400,
    )
  }
```

- [ ] **Step 5: Prueba de que no rompe la recompra automática**

```typescript
it('no bloquea una actualización que NO toca renglones (la recompra automática depende de eso)', async () => {
  mockedPrisma.purchaseOrder.findFirst.mockResolvedValue({
    id: PO_ID, venueId: VENUE_ID, status: PurchaseOrderStatus.APPROVED, items: [], taxRate: new Decimal(0.16),
  })
  await expect(
    updatePurchaseOrder(VENUE_ID, PO_ID, { notes: 'llega el martes' } as any),
  ).resolves.toBeDefined()
})
```

- [ ] **Step 6: Correr todo**

Run: `npx jest tests/unit/services/dashboard/purchaseOrder --silent && npm run typecheck`
Expected: verde, incluidas las pruebas de compras de ayer.

- [ ] **Step 7: Commit (pedir permiso antes)**

```bash
git add src/services/dashboard/purchaseOrderWorkflow.service.ts src/services/dashboard/purchaseOrder.service.ts tests/unit/services/dashboard/purchaseOrderStateGuard.test.ts
git commit -m "feat(compras): candado de edicion por estado y solicitar-cambio"
```

---

### Task 6: Crear una orden respeta la política

**Files:**
- Modify: `src/services/dashboard/purchaseOrder.service.ts` (`createPurchaseOrder`)
- Modify: `src/schemas/dashboard/inventory.schema.ts` (quitar `status` libre del PUT)
- Test: `tests/unit/services/dashboard/purchaseOrder.approvalPolicy.test.ts`

**Interfaces:**
- Consumes: `requiereAutorizacion` (Tarea 1).
- Produces: el estado inicial correcto. La Tarea 7 lo pinta.

- [ ] **Step 1: Escribir la prueba que falla**

```typescript
describe('createPurchaseOrder respeta la política del venue', () => {
  it('con el interruptor apagado nace igual que hoy', async () => {
    mockedPrisma.venueSettings.findUnique.mockResolvedValue({ requirePurchaseApproval: false, purchaseApprovalThreshold: null })
    const orden = await crearOrdenDe(10000)
    expect(orden.status).toBe(PurchaseOrderStatus.DRAFT)
    expect(orden.approvedBy).toBeNull()
  })

  it('prendido y por ARRIBA del umbral nace pendiente de autorización', async () => {
    mockedPrisma.venueSettings.findUnique.mockResolvedValue({ requirePurchaseApproval: true, purchaseApprovalThreshold: new Decimal(5000) })
    const orden = await crearOrdenDe(10000)
    expect(orden.status).toBe(PurchaseOrderStatus.PENDING_APPROVAL)
  })

  it('prendido y por DEBAJO del umbral se auto-autoriza estampando approvedBy = createdBy', async () => {
    // No se deja en null a propósito: así el reporte de auto-autorizadas atrapa con UNA
    // sola consulta tanto al que se aprobó a sí mismo como al que pasó sin revisión.
    mockedPrisma.venueSettings.findUnique.mockResolvedValue({ requirePurchaseApproval: true, purchaseApprovalThreshold: new Decimal(5000) })
    const orden = await crearOrdenDe(1000)
    expect(orden.status).toBe(PurchaseOrderStatus.APPROVED)
    expect(orden.approvedBy).toBe(STAFF_ID)
    expect(orden.createdBy).toBe(STAFF_ID)
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/services/dashboard/purchaseOrder.approvalPolicy.test.ts`
Expected: FAIL — el estado inicial no depende de la política.

- [ ] **Step 3: Implementar en `createPurchaseOrder`**

Después de calcular `totalAmount` y antes del `create`:

```typescript
  // Política de autorización del venue. Es lo que decide si esta orden nace lista o
  // tiene que pasar por alguien más.
  const ajustes = await prisma.venueSettings.findUnique({
    where: { venueId },
    select: { requirePurchaseApproval: true, purchaseApprovalThreshold: true },
  })
  const necesitaAutorizacion = requiereAutorizacion(totalAmount, ajustes)

  const estadoInicial = necesitaAutorizacion ? PurchaseOrderStatus.PENDING_APPROVAL : PurchaseOrderStatus.DRAFT

  // Auto-autorizada: se estampa el mismo staff como autor Y autorizador. Ver la nota
  // del spec §4.1 — es lo que hace que el reporte del auditor sea una sola consulta.
  const selloAutoAutorizada =
    ajustes?.requirePurchaseApproval && !necesitaAutorizacion ? { approvedBy: staffId, approvedAt: new Date() } : {}
```

Y en el `data` del `create`, usar `status: estadoInicial, ...selloAutoAutorizada`.

- [ ] **Step 4: Cerrar el PUT genérico**

En `UpdatePurchaseOrderSchema`, **quitar** el campo `status`:

```typescript
    // `status` SE QUITÓ a propósito. Aceptarlo aquí permitía saltar de
    // PENDING_APPROVAL a APPROVED con sólo tener `inventory:update`, sin estampar
    // quién autorizó. Los cambios de estado van EXCLUSIVAMENTE por sus rutas
    // dedicadas: submit-for-approval, approve, reject, request-change, cancel.
```

- [ ] **Step 5: Correr todo**

Run: `npx jest tests/unit/services/dashboard/purchaseOrder --silent && npm run typecheck`
Expected: verde.

- [ ] **Step 6: Commit (pedir permiso antes)**

```bash
git add src/services/dashboard/purchaseOrder.service.ts src/schemas/dashboard/inventory.schema.ts tests/unit/services/dashboard/purchaseOrder.approvalPolicy.test.ts
git commit -m "feat(compras): el estado inicial de la orden sale de la politica del venue"
```

---

### Task 7: Dashboard — botones por estado, rechazo real y reenvío

**Files:**
- Modify: `avoqado-web-dashboard/src/services/purchaseOrder.service.ts`
- Modify: `avoqado-web-dashboard/src/pages/Inventory/PurchaseOrders/components/POActions.tsx:166`
- Create: `avoqado-web-dashboard/src/pages/Inventory/PurchaseOrders/components/RejectOrderDialog.tsx`
- Modify: `avoqado-web-dashboard/src/pages/Inventory/PurchaseOrders/components/PurchaseOrderWizard.tsx:470`

**Interfaces:**
- Consumes: las rutas de la Tarea 4 y los estados de la Tarea 6.

- [ ] **Step 1: Métodos del servicio**

```typescript
  submitForApproval: (venueId: string, poId: string) =>
    api.post(`/api/v1/dashboard/venues/${venueId}/inventory/purchase-orders/${poId}/submit-for-approval`),

  // Rechazar ≠ cancelar. Hasta hoy el botón "Rechazar" llamaba a cancel, por eso
  // rejectedBy y rejectionReason estaban SIEMPRE vacíos en la base.
  reject: (venueId: string, poId: string, reason: string) =>
    api.post(`/api/v1/dashboard/venues/${venueId}/inventory/purchase-orders/${poId}/reject`, { reason }),

  requestChange: (venueId: string, poId: string) =>
    api.post(`/api/v1/dashboard/venues/${venueId}/inventory/purchase-orders/${poId}/request-change`),
```

- [ ] **Step 2: El wizard deja de forzar CONFIRMED**

Quitar el bloque de `PurchaseOrderWizard.tsx:470` que hace el PUT con
`status: CONFIRMED`. Ahora el backend decide el estado inicial según la política.

```typescript
        // El estado inicial lo decide el BACKEND según la política del venue
        // (interruptor + umbral). Antes aquí se forzaba CONFIRMED con un PUT, y ese
        // era el motivo real de que la autorización nunca ocurriera:
        //   "This skips APPROVED → SENT steps for quick workflow"
```

- [ ] **Step 3: Diálogo de rechazo con motivo obligatorio**

`RejectOrderDialog.tsx`: un `Textarea` con `required`, botón deshabilitado mientras
esté vacío, y el texto de ayuda *"Quien capturó la orden va a leer esto para saber qué
corregir."*

- [ ] **Step 4: Botones según el estado**

En `POActions.tsx`, envolver cada acción en `<PermissionGate>` y mostrarla sólo desde
los estados válidos:

| Botón | Estados | Permiso |
| --- | --- | --- |
| Enviar a autorización | `DRAFT`, `REJECTED` | `inventory:update` |
| Autorizar | `PENDING_APPROVAL` | `inventory:approve` |
| Rechazar | `PENDING_APPROVAL` | `inventory:approve` |
| Solicitar cambio | `APPROVED`, `PENDING_APPROVAL` | `inventory:update` |
| Recibir | `APPROVED`, `SENT`, `CONFIRMED`, `SHIPPED`, `PARTIAL` | `inventory:receive` |

- [ ] **Step 5: Verificar en el navegador**

Correr el dev server y comprobar el ciclo: crear → enviar → autorizar → recibir, y que
un usuario sin `inventory:approve` **no vea** el botón de autorizar.

- [ ] **Step 6: Commit (pedir permiso antes)**

---

### Task 8: Las tres huellas y el reporte de auto-autorizadas

**Files:**
- Modify: `src/services/dashboard/purchaseOrder.service.ts` (nueva consulta)
- Modify: `src/controllers/.../purchaseOrder.controller.ts`
- Modify: `src/routes/dashboard/inventory.routes.ts`
- Modify: `avoqado-web-dashboard/.../PurchaseOrderDetailPage.tsx`

**Interfaces:**
- Produces: `GET …/purchase-orders/self-approved` → `{ orders: [...] }`. La Tarea 9 lo expone en el MCP.

- [ ] **Step 1: Prueba de la consulta**

```typescript
it('lista sólo las órdenes donde quien capturó es quien autorizó', async () => {
  // Es el control detectivo que NetSuite entrega como búsqueda mensual. Aquí es
  // una pantalla. Y es donde superamos a Odoo, que compara ROLES y no identidades.
  await listarAutoAutorizadas(VENUE_ID, { from: '2026-08-01', to: '2026-08-31' })
  const where = mockedPrisma.$queryRaw.mock.calls[0]
  expect(String(where)).toMatch(/createdBy/)
})

it('EXCLUYE las que generó la recompra automática (approvedBy null)', async () => {
  // No son auto-autorizaciones de una persona; mezclarlas ensucia el reporte.
  const filas = await listarAutoAutorizadas(VENUE_ID, {})
  expect(filas.every(f => f.approvedBy !== null)).toBe(true)
})
```

- [ ] **Step 2: Implementar**

```typescript
/**
 * Órdenes que nadie más revisó: quien las capturó es quien las autorizó.
 *
 * 🔴 Se compara `createdBy`, NO `createdById`. Verificado contra producción:
 * `createdById` está en 0 de 5 órdenes; `createdBy` en 4 de 5. Usar el equivocado
 * deja el reporte vacío y hace ver que no hay hallazgos cuando sí los hay.
 */
export async function listarAutoAutorizadas(venueId: string, filtros: { from?: string; to?: string }) {
  return prisma.purchaseOrder.findMany({
    where: {
      venueId,
      approvedBy: { not: null },
      // Prisma no compara dos columnas entre sí en un `where`; se filtra en memoria
      // sobre un conjunto ya acotado por venue y fecha (son decenas de filas, no miles).
      ...(filtros.from || filtros.to
        ? { orderDate: { ...(filtros.from ? { gte: new Date(filtros.from) } : {}), ...(filtros.to ? { lte: new Date(filtros.to) } : {}) } }
        : {}),
    },
    select: { id: true, orderNumber: true, total: true, orderDate: true, createdBy: true, approvedBy: true, approvedAt: true, receivedBy: true },
    orderBy: { orderDate: 'desc' },
  }).then(filas => filas.filter(f => f.createdBy && f.createdBy === f.approvedBy))
}
```

- [ ] **Step 3: Pintar las tres huellas en el detalle**

Un bloque con **Solicitó / Autorizó / Recibió**, cada uno con nombre y fecha, y una
insignia ámbar **"Auto-autorizada"** cuando solicitante y autorizador coinciden.

- [ ] **Step 4: Correr y commitear (pedir permiso antes)**

---

### Task 9: MCP en lockstep

**Files:**
- Modify: `src/mcp/tools/procurement.ts`

- [ ] **Step 1: Exponer las huellas en `purchase_order_detail`**

Agregar al objeto que devuelve: `solicito`, `autorizo`, `autorizadoEn`, `recibio`,
`autoAutorizada` (booleano). Actualizar la descripción del tool.

- [ ] **Step 2: Tool nuevo `purchase_orders_self_approved`**

Con `guard.requirePermission('inventory:read', venueId)`, `guard.venueFilter(venueId)`
y el gate PREMIUM que ya usan sus vecinos en ese archivo.

- [ ] **Step 3: Extender `tests/unit/mcp-customer/procurement.test.ts` y commitear**

---

### Task 10: Roles y venue de demostración

**Files:**
- Create: `scripts/temp-seed-demo-pits.ts` *(temporal — se borra antes de commitear)*

- [ ] **Step 1: Crear los dos roles personalizados** en el venue de demo vía
  `VenueRolePermission`: **Comprador** (`inventory:read`, `inventory:create`,
  `inventory:update`, `products:read`) y **Almacenista** (`inventory:read`,
  `inventory:receive`, `products:read`).
- [ ] **Step 2: Prender el interruptor** y poner el umbral en un monto que haga la
  demo legible (p. ej. $5,000).
- [ ] **Step 3: Verificar a mano** que el Comprador NO ve "Autorizar" y el Almacenista
  NO ve "Autorizar" pero sí "Recibir".
- [ ] **Step 4: Borrar el script temporal.**

---

### Task 11: `/full-testing`

- [ ] **Step 1:** Ciclo completo contra la base real: comprador crea una orden arriba
  del umbral → nace pendiente → gerente autoriza → almacenista recibe. Verificar las
  tres huellas estampadas.
- [ ] **Step 2:** Que una orden **debajo** del umbral se auto-autorice y aparezca en el
  reporte.
- [ ] **Step 3:** Que una orden autorizada **no** se pueda editar, y que tras
  "Solicitar cambio" con monto menor al umbral se auto-autorice.
- [ ] **Step 4:** **Regresión:** con el interruptor apagado, el flujo completo se
  comporta byte-idéntico a hoy.
- [ ] **Step 5:** `npm run audit:permissions` en 0 y `npm run pre-deploy` verde.
- [ ] **Step 6:** Restaurar la base al conteo del baseline y borrar temporales.

---

## Auto-revisión del plan

**Cobertura del spec:** §4.1 → T1, T6 · §4.2 → T4 · §4.3 → T5 · §4.4 → T3 · §4.5 → T8 ·
§4.6 → T4, T7 · §4.7 → T10 · §6 riesgos → T3 (alias), T5 (autoReorder), T8 (`createdBy`) ·
§7 pruebas → T11.

**Hueco encontrado y cerrado:** el spec no mencionaba los 7 `include` de
`purchaseOrderWorkflow.service.ts`. Se agregó como **Tarea 2**, y es bloqueante de la 4.

**Consistencia de nombres:** `requiereAutorizacion`, `estadoPermiteEdicion`,
`requestChange` y `listarAutoAutorizadas` se usan con el mismo nombre en todas las
tareas que las consumen.
