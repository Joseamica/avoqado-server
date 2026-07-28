# Plan B — Superficie `/tpv` en el server (avoqado-server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar bajo `/api/v1/tpv/*` todo lo que el módulo Mesas necesita — incluido el reducer de intents offline — sin tocar una sola
línea del contrato `/mobile`, y tapando el hueco de permisos y tenant que hoy tienen las rutas de mesa.

**Architecture:** Controllers delgados sobre servicios que **ya son puros**. `order.mobile.service.ts` no toca `req` ni `authContext`: sus
funciones son `(venueId, orderId, …, staffId?)`. Eso quiere decir que **no hay extracción que hacer** — un controller `/tpv` las importa y
las llama. El reducer de intents (`sync.mobile.controller.syncIntents`) tampoco está acoplado: solo lee `venueId` de params,
`authContext.userId`, y `deviceId`/`intents` del body, así que se monta tal cual bajo otra ruta.

**Tech Stack:** Express + TypeScript · Prisma · Jest · Zod (mensajes en español)

**Spec:** `docs/superpowers/specs/2026-07-24-tpv-mesas-offline-first-design.md` §4.3, §4.4, §7.2 **Repo:**
`/Users/amieva/Documents/Programming/Avoqado/avoqado-server` (rama `develop`)

## Global Constraints

- **Cero cambios al contrato `/mobile`.** `avoqado-ios` y `avoqado-android` se desarrollan en paralelo por otras sesiones contra ese
  namespace. Ninguna tarea de este plan modifica `src/routes/mobile.routes.ts` ni `src/controllers/mobile/*`. Si una tarea parece
  necesitarlo, **parar y preguntar**.
- **Nunca quitar ni renombrar un campo de una respuesta.** Campos nuevos: opcionales con default.
- **`authContext`, no `req.user`.** Campos: `{ userId, orgId, venueId, role }`.
- **Aislamiento de tenant en TODA query.** Filtrar por `venueId`/`orgId`, sin excepción.
- **Money = `Prisma.Decimal`, en PESOS 1:1.** Nunca centavos, nunca float.
- **Zod solo en español**, y solo forma/formato — la lógica de negocio va en el servicio.
- **Module vs Feature — no cruzar los resolvers.** `TABLE_SERVICE` es un código de **`Feature`** → `venueHasFeatureAccess` /
  `checkFeatureAccess`. **NUNCA** `isModuleEnabled`. Cruzarlos falla en silencio porque casi todos los venues de prod están grandfathered.
- **`ActivityLog` en toda mutación auditable**, con `staffId` de `authContext`. Fire-and-forget (`void logAction(...)`), fuera de cualquier
  `prisma.$transaction`.
- **Sin cambios de `prisma/schema.prisma`.** Por tanto **no aplica** `npm run schema:map`.
- **Nunca commitear sin permiso explícito del founder.**
- Gate por tarea: `npm run test:unit`. Gate final: `npm run pre-deploy`.

## File Structure

| Archivo                                                         | Responsabilidad                                         | Tarea         |
| --------------------------------------------------------------- | ------------------------------------------------------- | ------------- |
| `src/middlewares/validateVenueAccess.middleware.ts` **(nuevo)** | Que el `:venueId` de la URL pertenezca al `authContext` | 1             |
| `src/routes/tpv.routes.ts`                                      | Rutas nuevas + candados en las existentes               | 1, 2, 3, 4, 5 |
| `src/controllers/tpv/sync.tpv.controller.ts` **(nuevo)**        | Reexport del reducer de intents                         | 3             |
| `src/controllers/tpv/order-table.tpv.controller.ts` **(nuevo)** | Ciclo de orden de mesa sobre servicios existentes       | 4             |
| `src/controllers/tpv/menu.tpv.controller.ts` **(nuevo)**        | Menú, productos y categorías para el TPV                | 5             |
| `src/lib/permissions.ts`                                        | Catálogo + defaults de los permisos de mesa             | 1             |

---

## Task 1: §4.4 — permisos y tenant en las rutas de mesa

Las 10 rutas de escritura de mesas y floor-elements bajo `/tpv` llevan **solo** `authenticateTokenMiddleware`. Sin `checkPermission` y sin
validar que el `:venueId` de la URL sea del que llama: con un token del venue A, `DELETE /tpv/venues/<venueB>/tables/<id>` opera sobre el
venue B. Y dentro del propio venue, un `WAITER` puede borrar mesas.

**Files:**

- Create: `src/middlewares/validateVenueAccess.middleware.ts`
- Create: `tests/unit/middlewares/validateVenueAccess.middleware.test.ts`
- Modify: `src/routes/tpv.routes.ts:3531,3534,3537,3540,3586,3592,3598`
- Modify: `src/lib/permissions.ts`

**Interfaces:**

- Produces: `validateVenueAccess` (middleware Express); permisos `tables:create`, `tables:update`, `tables:delete` en
  `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` y `DEFAULT_PERMISSIONS`.
- Consumes: nada.

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { validateVenueAccess } from '../../../src/middlewares/validateVenueAccess.middleware'

describe('validateVenueAccess', () => {
  const res = () => {
    const r: any = {}
    r.status = jest.fn().mockReturnValue(r)
    r.json = jest.fn().mockReturnValue(r)
    return r
  }

  it('deja pasar cuando el venueId de la URL es el del token', () => {
    const req: any = { params: { venueId: 'venue-a' }, authContext: { venueId: 'venue-a' } }
    const next = jest.fn()

    validateVenueAccess(req, res(), next)

    expect(next).toHaveBeenCalled()
  })

  it('rechaza con 403 cuando el venueId de la URL es de OTRO venue', () => {
    // 🔴 El bug: con un token del venue A se podia operar sobre el venue B.
    const req: any = { params: { venueId: 'venue-b' }, authContext: { venueId: 'venue-a' } }
    const next = jest.fn()
    const r = res()

    validateVenueAccess(req, r, next)

    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(403)
  })

  it('rechaza con 401 cuando no hay authContext', () => {
    const req: any = { params: { venueId: 'venue-a' } }
    const next = jest.fn()
    const r = res()

    validateVenueAccess(req, r, next)

    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(401)
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/middlewares/validateVenueAccess.middleware.test.ts` Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar el middleware**

```typescript
import { NextFunction, Request, Response } from 'express'

/**
 * Verifica que el `:venueId` de la URL sea el del token.
 *
 * Existe porque `authenticateTokenMiddleware` nunca lee `req.params.venueId` y los
 * controllers lo pasan directo al servicio, que scopea con
 * `where: { id, venueId }` — es decir, contra el venueId QUE VINO EN LA URL.
 * Con un token del venue A se podía operar sobre el venue B. Ver spec §4.4.
 */
export function validateVenueAccess(req: Request, res: Response, next: NextFunction): void {
  const authContext = (req as any).authContext

  if (!authContext?.venueId) {
    res.status(401).json({ success: false, message: 'Autenticación requerida' })
    return
  }

  if (req.params.venueId !== authContext.venueId) {
    res.status(403).json({ success: false, message: 'No tienes acceso a este venue' })
    return
  }

  next()
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx jest tests/unit/middlewares/validateVenueAccess.middleware.test.ts` Expected: PASS (3 tests)

- [ ] **Step 5: Registrar los permisos en el catálogo**

En `src/lib/permissions.ts`:

1. Añadir `tables:create`, `tables:update`, `tables:delete` a `INDIVIDUAL_PERMISSIONS_BY_RESOURCE` bajo el recurso `tables` (si el recurso
   no existe, crearlo).
2. Añadirlos a `DEFAULT_PERMISSIONS` para **MANAGER, ADMIN, OWNER** — **no** para WAITER ni CASHIER (ese es justamente el defecto que se
   está tapando).
3. Si `tables:read` no existe, añadirlo también y dárselo a todos los roles operativos (WAITER incluido — leer el plano es su trabajo).
4. Añadir a `PERMISSION_DEPENDENCIES`: `'tables:create': ['tables:create', 'tables:read']`, y lo mismo para update y delete.

- [ ] **Step 6: Aplicar los candados a las rutas**

En `src/routes/tpv.routes.ts`, en las 7 rutas de escritura:

```typescript
router.post(
  '/venues/:venueId/tables',
  authenticateTokenMiddleware,
  validateVenueAccess,
  checkPermission('tables:create'),
  tableController.createTable,
)

router.put(
  '/venues/:venueId/tables/:tableId/position',
  authenticateTokenMiddleware,
  validateVenueAccess,
  checkPermission('tables:update'),
  tableController.updateTablePosition,
)

router.put(
  '/venues/:venueId/tables/:tableId',
  authenticateTokenMiddleware,
  validateVenueAccess,
  checkPermission('tables:update'),
  tableController.updateTable,
)

router.delete(
  '/venues/:venueId/tables/:tableId',
  authenticateTokenMiddleware,
  validateVenueAccess,
  checkPermission('tables:delete'),
  tableController.deleteTable,
)
```

Y lo mismo para las 3 de `floor-elements` (`:3586,3592,3598`) con `tables:create` / `tables:update` / `tables:delete` respectivamente.

**No tocar** `GET /venues/:venueId/tables` (`:3492`) ni `POST .../tables/assign` (`:3528`) ni `.../clear` (`:3566`) más allá de añadirles
`validateVenueAccess` — son operativas y las usa el mesero.

- [ ] **Step 7: Correr la auditoría de permisos**

Run: `npm run audit:permissions` Expected: exit 0. Si sale `CATALOG_GAP` o `PHANTOM` en `tables:*`, es que faltó el paso 5.

Run: `npm run test:unit` Expected: PASS

- [ ] **Step 8: Commit** _(solo con permiso del founder)_

```bash
git add src/middlewares/validateVenueAccess.middleware.ts \
        tests/unit/middlewares/validateVenueAccess.middleware.test.ts \
        src/routes/tpv.routes.ts src/lib/permissions.ts
git commit -m "fix(security): permisos y aislamiento de tenant en las rutas de mesa de /tpv

Las 10 rutas de escritura llevaban solo authenticateTokenMiddleware. Sin
checkPermission un WAITER podia borrar mesas, y como el middleware nunca lee
req.params.venueId, un token del venue A podia operar sobre el venue B."
```

---

## Task 2: `checkFeatureAccess('TABLE_SERVICE')` en las rutas de mesa de `/tpv`

Hoy solo `/mobile` gatea `TABLE_SERVICE`. Las mismas capacidades bajo `/tpv` están abiertas — un venue FREE puede usar servicio de mesa
desde la terminal.

**Files:**

- Modify: `src/routes/tpv.routes.ts`
- Test: `tests/unit/routes/tpv-table-gating.test.ts` (crear)

**Interfaces:**

- Consumes: `validateVenueAccess` (Task 1).
- Produces: nada nuevo — aplica middleware existente.

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { checkFeatureAccess } from '../../../src/middlewares/checkFeatureAccess.middleware'
import * as basePlan from '../../../src/services/access/basePlan.service'

jest.mock('../../../src/services/access/basePlan.service')

describe('gating de TABLE_SERVICE en /tpv', () => {
  const res = () => {
    const r: any = {}
    r.status = jest.fn().mockReturnValue(r)
    r.json = jest.fn().mockReturnValue(r)
    return r
  }

  it('un venue sin TABLE_SERVICE recibe 403', async () => {
    ;(basePlan.venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    const req: any = { params: { venueId: 'venue-free' }, authContext: { venueId: 'venue-free' } }
    const next = jest.fn()
    const r = res()

    await checkFeatureAccess('TABLE_SERVICE')(req, r, next)

    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(403)
  })

  it('un venue PRO con TABLE_SERVICE pasa', async () => {
    ;(basePlan.venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    const req: any = { params: { venueId: 'venue-pro' }, authContext: { venueId: 'venue-pro' } }
    const next = jest.fn()

    await checkFeatureAccess('TABLE_SERVICE')(req, res(), next)

    expect(next).toHaveBeenCalled()
  })
})
```

> **Antes de escribirlo:** abrir `src/middlewares/checkFeatureAccess.middleware.ts` y confirmar la firma exacta (si el middleware resuelve
> el venue de otra forma, ajustar el mock a lo que realmente llama). **No** mockear `isModuleEnabled` — `TABLE_SERVICE` es `Feature`, no
> `Module`.

- [ ] **Step 2: Correr y verificar que falla o pasa**

Run: `npx jest tests/unit/routes/tpv-table-gating.test.ts` Si pasa de una, el middleware ya es correcto y lo que falta es **aplicarlo**
(paso 3).

- [ ] **Step 3: Aplicar el gate**

Añadir `checkFeatureAccess('TABLE_SERVICE')` después de `validateVenueAccess` en las rutas de **servicio de mesa**: `tables/assign`,
`tables/:tableId/clear`, y todas las de orden de mesa que agrega la Task 4.

**No gatear** `GET /venues/:venueId/tables` — leer el plano es core; el gate va donde se opera.

- [ ] **Step 4: Correr los tests**

Run: `npm run test:unit` Expected: PASS

- [ ] **Step 5: Commit** _(solo con permiso del founder)_

```bash
git add src/routes/tpv.routes.ts tests/unit/routes/tpv-table-gating.test.ts
git commit -m "feat(tpv): gatear servicio de mesa con TABLE_SERVICE (PRO+)

Solo /mobile lo gateaba; las mismas capacidades bajo /tpv estaban abiertas."
```

---

## Task 3: Montar el reducer de intents bajo `/tpv`

`POST /api/v1/mobile/venues/:venueId/sync/intents` ya existe, es idempotente, tiene 13 tipos de intent que son el flujo de mesa completo, y
su controller **no está acoplado a mobile**: solo lee `venueId` de params, `authContext.userId`, y `deviceId`/`intents` del body.

**Files:**

- Create: `src/controllers/tpv/sync.tpv.controller.ts`
- Modify: `src/routes/tpv.routes.ts`
- Test: `tests/unit/controllers/tpv/sync.tpv.controller.test.ts` (crear)

**Interfaces:**

- Consumes: `validateVenueAccess` (Task 1); `syncMobileController.syncIntents` (existente).
- Produces: `POST /api/v1/tpv/venues/:venueId/sync/intents` con **el mismo contrato** que la de `/mobile`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
import * as syncTpvController from '../../../../src/controllers/tpv/sync.tpv.controller'
import * as syncMobileController from '../../../../src/controllers/mobile/sync.mobile.controller'

describe('sync.tpv.controller', () => {
  it('delega en el MISMO reducer que /mobile', () => {
    // El reducer es la unica fuente de verdad del replay offline. Si /tpv tuviera
    // su propia copia, los dos namespaces divergirian en silencio.
    expect(syncTpvController.syncIntents).toBe(syncMobileController.syncIntents)
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/controllers/tpv/sync.tpv.controller.test.ts` Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar el controller**

```typescript
/**
 * Replay del outbox offline para el TPV.
 *
 * Es LITERALMENTE el mismo reducer que usa `/mobile`, reexportado. El controller no
 * está acoplado al namespace: solo lee `venueId` de params, `authContext.userId`, y
 * `deviceId`/`intents` del body. Duplicar la lógica haría que los dos namespaces
 * divergieran en silencio — y el reducer es quien evalúa el gating de TABLE_SERVICE
 * y la propiedad de mesa POR INTENT (sincronizar no es puerta trasera).
 *
 * El TPV está aislado a `/api/v1/tpv/*` por decisión del founder: nunca llama a
 * `/mobile`. Por eso la ruta se monta aquí en vez de que el cliente cruce.
 */
export { syncIntents } from '../mobile/sync.mobile.controller'
```

- [ ] **Step 4: Montar la ruta**

En `src/routes/tpv.routes.ts`, junto a las rutas de mesa:

```typescript
import * as syncTpvController from '../controllers/tpv/sync.tpv.controller'

/**
 * POST /api/v1/tpv/venues/{venueId}/sync/intents
 * Replay del outbox offline del TPV: batch FIFO por dispositivo, un ack por intent
 * (idempotente vía [venueId, idempotencyKey]). El gating de TABLE_SERVICE y la
 * propiedad de mesa se evalúan POR INTENT en el reducer.
 * Body: { deviceId, intents: [...] }
 */
router.post(
  '/venues/:venueId/sync/intents',
  authenticateTokenMiddleware,
  validateVenueAccess,
  checkPermission('orders:create'),
  syncTpvController.syncIntents,
)
```

`checkPermission('orders:create')` es el mismo que usa `/mobile` — mismo nombre exacto, a propósito.

- [ ] **Step 5: Correr los tests**

Run: `npm run test:unit` Expected: PASS

- [ ] **Step 6: Verificar que `/mobile` no cambió**

Run: `git diff --stat src/routes/mobile.routes.ts src/controllers/mobile/ src/services/mobile/` Expected: **vacío.**

- [ ] **Step 7: Commit** _(solo con permiso del founder)_

```bash
git add src/controllers/tpv/sync.tpv.controller.ts \
        tests/unit/controllers/tpv/sync.tpv.controller.test.ts \
        src/routes/tpv.routes.ts
git commit -m "feat(tpv): montar el reducer de intents offline bajo /tpv

El TPV esta aislado a /api/v1/tpv/* y nunca llama a /mobile. El controller del
reducer no esta acoplado al namespace, asi que se reexporta tal cual: misma
logica, mismos acks, cero divergencia entre los dos namespaces."
```

---

## Task 4: Ciclo de orden de mesa bajo `/tpv`

Los servicios ya existen y **son puros** (`splitOrderItems(venueId, orderId, itemIds, staffId?)`,
`mergeOrders(venueId, targetOrderId, sourceOrderId, staffId?)`, `applyOrderDiscount(venueId, orderId, discountId, staffId?)`,
`splitOrderBySeat(venueId, orderId, staffId?)` en `src/services/mobile/order.mobile.service.ts`). **No hay extracción que hacer**: un
controller `/tpv` los importa y los llama.

**Files:**

- Create: `src/controllers/tpv/order-table.tpv.controller.ts`
- Create: `tests/unit/controllers/tpv/order-table.tpv.controller.test.ts`
- Modify: `src/routes/tpv.routes.ts`

**Interfaces:**

- Consumes: `validateVenueAccess` (Task 1), `checkFeatureAccess('TABLE_SERVICE')` (Task 2), y las funciones puras de `order.mobile.service`.
- Produces: `POST /tpv/venues/:venueId/orders/:orderId/{split,split-by-seat,merge,discounts,comp,service-charges}` y
  `POST /tpv/venues/:venueId/tables/:tableId/open`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
import * as controller from '../../../../src/controllers/tpv/order-table.tpv.controller'
import * as orderService from '../../../../src/services/mobile/order.mobile.service'

jest.mock('../../../../src/services/mobile/order.mobile.service')

const mockRes = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}

describe('order-table.tpv.controller', () => {
  beforeEach(() => jest.clearAllMocks())

  it('splitOrder pasa el staffId del authContext, no del body', async () => {
    // El actor SIEMPRE sale del token. Si saliera del body, cualquiera podria
    // atribuirle una division de cuenta a otro mesero.
    ;(orderService.splitOrderItems as jest.Mock).mockResolvedValue({ id: 'nueva-orden' })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: { itemIds: ['item-1'], staffId: 'ATACANTE' },
      authContext: { venueId: 'venue-a', userId: 'staff-real' },
    }

    await controller.splitOrder(req, mockRes())

    expect(orderService.splitOrderItems).toHaveBeenCalledWith('venue-a', 'orden-1', ['item-1'], 'staff-real')
  })

  it('splitOrder responde 400 en español si faltan itemIds', async () => {
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-1' },
      body: {},
      authContext: { venueId: 'venue-a', userId: 'staff-real' },
    }
    const res = mockRes()

    await controller.splitOrder(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: expect.stringContaining('items') }))
    expect(orderService.splitOrderItems).not.toHaveBeenCalled()
  })

  it('mergeOrders delega en el servicio compartido', async () => {
    ;(orderService.mergeOrders as jest.Mock).mockResolvedValue({ id: 'orden-destino' })
    const req: any = {
      params: { venueId: 'venue-a', orderId: 'orden-destino' },
      body: { sourceOrderId: 'orden-origen' },
      authContext: { venueId: 'venue-a', userId: 'staff-real' },
    }

    await controller.mergeOrders(req, mockRes())

    expect(orderService.mergeOrders).toHaveBeenCalledWith('venue-a', 'orden-destino', 'orden-origen', 'staff-real')
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/controllers/tpv/order-table.tpv.controller.test.ts` Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar el controller**

```typescript
import { Request, Response } from 'express'
import * as orderService from '../../services/mobile/order.mobile.service'
import { logAction } from '../../services/activity/activityLog.service'
import logger from '../../config/logger'

/**
 * Ciclo de orden de mesa para el TPV.
 *
 * Delega en los servicios de `order.mobile.service`, que son PUROS — reciben
 * `(venueId, orderId, …, staffId?)` y no tocan `req` ni `authContext`. Por eso NO
 * hace falta extraerlos: reusarlos desde aquí deja el contrato `/mobile` intacto,
 * que es el requisito duro (iOS y Android se desarrollan en paralelo contra él).
 *
 * El `staffId` sale SIEMPRE de `authContext`, nunca del body.
 */

/** POST /tpv/venues/:venueId/orders/:orderId/split */
export async function splitOrder(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { itemIds } = req.body
    const staffId = (req as any).authContext.userId

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      res.status(400).json({ success: false, message: 'Se requiere al menos un item para dividir la cuenta' })
      return
    }

    const result = await orderService.splitOrderItems(venueId, orderId, itemIds, staffId)

    void logAction({
      action: 'ORDER_SPLIT',
      entity: 'Order',
      entityId: orderId,
      staffId,
      venueId,
      data: { itemIds, newOrderId: (result as any)?.id },
    })

    res.status(201).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[ORDER TABLE TPV] split: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message })
  }
}

/** POST /tpv/venues/:venueId/orders/:orderId/merge */
export async function mergeOrders(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { sourceOrderId } = req.body
    const staffId = (req as any).authContext.userId

    if (!sourceOrderId) {
      res.status(400).json({ success: false, message: 'Se requiere la cuenta de origen' })
      return
    }

    const result = await orderService.mergeOrders(venueId, orderId, sourceOrderId, staffId)

    void logAction({
      action: 'ORDER_MERGED',
      entity: 'Order',
      entityId: orderId,
      staffId,
      venueId,
      data: { sourceOrderId },
    })

    res.status(200).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[ORDER TABLE TPV] merge: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message })
  }
}

/** POST /tpv/venues/:venueId/orders/:orderId/split-by-seat */
export async function splitOrderBySeat(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const staffId = (req as any).authContext.userId

    const result = await orderService.splitOrderBySeat(venueId, orderId, staffId)

    void logAction({
      action: 'ORDER_SPLIT_BY_SEAT',
      entity: 'Order',
      entityId: orderId,
      staffId,
      venueId,
      data: {},
    })

    res.status(201).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[ORDER TABLE TPV] split-by-seat: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message })
  }
}

/** POST /tpv/venues/:venueId/orders/:orderId/discounts */
export async function applyOrderDiscount(req: Request, res: Response): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { discountId } = req.body
    const staffId = (req as any).authContext.userId

    if (!discountId) {
      res.status(400).json({ success: false, message: 'Se requiere el descuento a aplicar' })
      return
    }

    const result = await orderService.applyOrderDiscount(venueId, orderId, discountId, staffId)

    void logAction({
      action: 'DISCOUNT_APPLIED',
      entity: 'Order',
      entityId: orderId,
      staffId,
      venueId,
      data: { discountId },
    })

    res.status(200).json({ success: true, data: result })
  } catch (error: any) {
    logger.error(`[ORDER TABLE TPV] discount: ${error.message}`)
    res.status(error.statusCode || 500).json({ success: false, message: error.message })
  }
}
```

Para `comp`, `service-charges`, `items` (con `version`) y `tables/:tableId/open`: **abrir primero `src/routes/mobile.routes.ts:1880-2010` y
`src/controllers/mobile/order.mobile.controller.ts`**, localizar la función de servicio que cada uno llama, y escribir el handler `/tpv` con
el mismo patrón de arriba (validar en español → llamar al servicio con `staffId` del `authContext` → `logAction` → responder). **No** copiar
el controller de mobile: importar su servicio.

- [ ] **Step 4: Montar las rutas**

En `src/routes/tpv.routes.ts`, todas con la misma cadena:

```typescript
import * as orderTableController from '../controllers/tpv/order-table.tpv.controller'

const tableServiceChain = [authenticateTokenMiddleware, validateVenueAccess, checkFeatureAccess('TABLE_SERVICE')]

router.post(
  '/venues/:venueId/orders/:orderId/split',
  ...tableServiceChain,
  checkPermission('orders:update'),
  orderTableController.splitOrder,
)
router.post(
  '/venues/:venueId/orders/:orderId/split-by-seat',
  ...tableServiceChain,
  checkPermission('orders:update'),
  orderTableController.splitOrderBySeat,
)
router.post(
  '/venues/:venueId/orders/:orderId/merge',
  ...tableServiceChain,
  checkPermission('orders:update'),
  orderTableController.mergeOrders,
)
router.post(
  '/venues/:venueId/orders/:orderId/discounts',
  ...tableServiceChain,
  checkPermission('orders:discount'),
  orderTableController.applyOrderDiscount,
)
```

Confirmar en `src/lib/permissions.ts` que `orders:discount` y `orders:comp` existen con **ese nombre exacto** (son los que ya usa
`/mobile`). Si no existen, añadirlos siguiendo el checklist de `.claude/rules/permissions-policy.md`.

- [ ] **Step 5: Correr los tests y la auditoría**

Run: `npm run test:unit` Run: `npm run audit:permissions` Expected: PASS y exit 0.

- [ ] **Step 6: Verificar que `/mobile` no cambió**

Run: `git diff --stat src/routes/mobile.routes.ts src/controllers/mobile/ src/services/mobile/` Expected: **vacío.**

- [ ] **Step 7: Commit** _(solo con permiso del founder)_

```bash
git add src/controllers/tpv/order-table.tpv.controller.ts \
        tests/unit/controllers/tpv/order-table.tpv.controller.test.ts \
        src/routes/tpv.routes.ts src/lib/permissions.ts
git commit -m "feat(tpv): ciclo de orden de mesa bajo /tpv (split, merge, descuentos, comp)

Los servicios de order.mobile.service son puros: reciben (venueId, orderId,
staffId) y no tocan req ni authContext. Se reusan desde un controller /tpv, asi
que el contrato /mobile queda intacto byte por byte."
```

---

## Task 5: Menú, productos y categorías bajo `/tpv` (§4.3)

La TPV está limpia de `/mobile`, pero tiene 2 llamadas a `dashboard/` que el módulo Mesas va a heredar si no se cierran: `ApiService.kt:505`
(`dashboard/venues/{venueId}/products`) y `:555` (`dashboard/venues/{venueId}/categories`). El equivalente `/tpv` **no existe**.

**Files:**

- Create: `src/controllers/tpv/menu.tpv.controller.ts`
- Create: `tests/unit/controllers/tpv/menu.tpv.controller.test.ts`
- Modify: `src/routes/tpv.routes.ts`

**Interfaces:**

- Consumes: `validateVenueAccess` (Task 1).
- Produces: `GET /tpv/venues/:venueId/products`, `GET /tpv/venues/:venueId/categories`, `GET /tpv/venues/:venueId/menus`. **Mismo shape de
  respuesta** que las de `dashboard/`, para que el cliente solo cambie el prefijo.

- [ ] **Step 1: Escribir el test que falla**

```typescript
import * as controller from '../../../../src/controllers/tpv/menu.tpv.controller'

const mockRes = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}

describe('menu.tpv.controller', () => {
  it('getProducts scopea por el venueId del authContext', async () => {
    const req: any = {
      params: { venueId: 'venue-a' },
      query: {},
      authContext: { venueId: 'venue-a', userId: 'staff-1' },
    }
    const res = mockRes()

    await controller.getProducts(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: expect.anything() }))
  })
})
```

> **Antes de escribirlo:** abrir el controller de `dashboard` que sirve `dashboard/venues/:venueId/products` y `:categories`, y anotar el
> **shape exacto** de la respuesta. El test debe afirmar ese shape, no uno inventado — el cliente solo va a cambiar el prefijo de la URL,
> así que el cuerpo tiene que ser idéntico.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest tests/unit/controllers/tpv/menu.tpv.controller.test.ts` Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Escribir `menu.tpv.controller.ts` delegando en el **mismo servicio** que usa el controller de dashboard (importarlo, no duplicar la query),
devolviendo el mismo shape. El `venueId` sale de `req.params` y `validateVenueAccess` ya garantizó que es el del token.

- [ ] **Step 4: Montar las rutas**

```typescript
router.get(
  '/venues/:venueId/products',
  authenticateTokenMiddleware,
  validateVenueAccess,
  checkPermission('menu:read'),
  menuTpvController.getProducts,
)
router.get(
  '/venues/:venueId/categories',
  authenticateTokenMiddleware,
  validateVenueAccess,
  checkPermission('menu:read'),
  menuTpvController.getCategories,
)
router.get(
  '/venues/:venueId/menus',
  authenticateTokenMiddleware,
  validateVenueAccess,
  checkPermission('menu:read'),
  menuTpvController.getMenus,
)
```

- [ ] **Step 5: Correr los tests**

Run: `npm run test:unit` y `npm run audit:permissions` Expected: PASS y exit 0.

- [ ] **Step 6: Commit** _(solo con permiso del founder)_

```bash
git add src/controllers/tpv/menu.tpv.controller.ts \
        tests/unit/controllers/tpv/menu.tpv.controller.test.ts \
        src/routes/tpv.routes.ts
git commit -m "feat(tpv): menu, productos y categorias bajo /tpv

La TPV pegaba a dashboard/venues/{id}/products y /categories. Mismo shape de
respuesta, solo cambia el prefijo, para que el cliente migre sin tocar parsers."
```

---

## Task 6: Lockstep — MCP, presentación y verificación final

**Files:**

- Modify: `src/mcp/tools/orders.ts` (si el reducer ganó tipos de intent)
- Modify: `~/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/*.html` + PDFs

**Interfaces:**

- Consumes: todo lo anterior.
- Produces: nada de código.

- [ ] **Step 1: Verificar el MCP**

`src/mcp/tools/orders.ts:284` ya describe el replay de intents. Confirmar que la lista de tipos que menciona coincida con `SyncIntentType`
en `src/services/mobile/sync.mobile.service.ts` (otra sesión está agregando tipos — ver §12.1 del spec). Si divergió, actualizar la
descripción del tool en el mismo cambio.

Verificar además que los tools de mesa existentes (`tables_status`, `open_orders`, `assign_table_check`, `split_table_check`,
`move_table_check`, `comp_table_check`, `set_table_status`, `set_table_check_details`) siguen cubriendo lo que este plan expuso. Si alguna
capacidad nueva no es alcanzable desde el MCP, añadir el tool aquí.

- [ ] **Step 2: Verificar `ActivityLog`**

Confirmar que las mutaciones que agregó la Task 4 escriben su fila, y que los intents replayados por el reducer tampoco se pierden del
rastro (es el único camino de escritura cuando se estuvo offline). Anomalías que sí se registran: comp, descuento, cancelar, liberar mesa.
No: `ORDER_CREATED` de rutina.

- [ ] **Step 3: Gate completo**

```bash
npm run format && npm run lint:fix
npm run test:unit
npm run audit:permissions
npm run pre-deploy
```

Expected: todo verde, `audit:permissions` exit 0.

- [ ] **Step 4: Verificar el aislamiento de `/mobile` una última vez**

```bash
git diff --stat develop -- src/routes/mobile.routes.ts src/controllers/mobile/ src/services/mobile/
```

Expected: **vacío.** Si no lo está, revertir esos archivos — es el requisito duro del plan.

- [ ] **Step 5: Presentación de ventas**

"Mesas en la terminal, funciona sin internet" es capacidad visible al cliente. Actualizar el deck (`avoqado-presentacion-v2.html`), el
one-pager (`avoqado-one-pager-v2.html`) y el one-pager de cliente (`avoqado-one-pager-cliente.html`), **y regenerar los 3 PDFs** con el
comando Chrome-headless del `README.md` de esa carpeta. Editar el HTML sin regenerar el PDF es un cambio incompleto.

> Este paso puede diferirse hasta que el Plan C esté listo (la capacidad no es visible al cliente hasta que exista la UI), pero **no puede
> olvidarse**. Si se difiere, anotarlo en el Plan C.

## Qué NO cubre este plan

- **Plan A** — blindaje del stack de dinero en `avoqado-tpv`.
- **Plan C** — el módulo `features/tables/`, incluido el cambio del cliente para dejar de llamar a `dashboard/products` y
  `dashboard/categories` (la Task 5 solo crea el destino).
- **Editor de plano en el dashboard** — spec §12.5, scope aparte. Cuando se haga, la Task 1 de este plan ya dejó tapado el hueco que habría
  duplicado.
