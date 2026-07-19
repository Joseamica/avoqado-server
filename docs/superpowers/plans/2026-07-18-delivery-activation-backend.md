# Delivery Activation — Backend Implementation Plan (avoqado-server)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend para la "solicitud de activación de delivery" del dashboard: modelo `DeliveryActivationRequest`, endpoints dueño (solicitar/ver) + ops (gestionar), resumen diario por canal, y MCP lockstep — de modo que el dashboard tenga los datos para resolver sus 4 estados.

**Architecture:** Extiende el vertical delivery-channels ya commiteado (`2f8be09c..8374c949`). Modelo aditivo + servicio con `logAction` fire-and-forget; endpoints dueño en el `delivery-channels.routes.ts` existente (namespace `/api/v1/delivery-channels`), endpoint ops en un subrouter superadmin nuevo. El "resumen por canal" se extrae del MCP tool `delivery_channels` a un servicio compartido y se expone por REST (DRY).

**Tech Stack:** Express + TS, Prisma/PostgreSQL, Jest + prismaMock, MCP SDK, Zod.

## Global Constraints

- **Sin commits sin permiso del founder** (regla repo `testing-and-git.md`). Los pasos "Commit" asumen permiso dado para la ejecución; si no, acumular.
- **Schema 100% aditivo**; `npm run schema:map` + `MODEL_TO_DOMAIN` + prismaMock en el MISMO cambio que el schema.
- **Dinero en PESOS `Prisma.Decimal` 1:1**, jamás cents fuera de fronteras externas.
- **Tenant isolation**: todo query filtra por `venueId` (o `orgId`).
- **Zod en español, shape-only**; reglas de negocio en el servicio.
- **`authContext` (NO `req.user`)**: `const { venueId, userId } = (req as any).authContext`.
- **ActivityLog en cada mutación** (`logAction`, fire-and-forget `void`, fuera de tx).
- **MCP lockstep**: capability nueva → tool en `src/mcp/tools/` en el mismo cambio.
- Después de editar TS: `npm run format && npm run lint:fix`. Verificación integral al final (Task 7).
- Tests con sección de regresión (regla repo). Fechas de test con `TZ=UTC`.

---

### Task 1: Schema — `DeliveryActivationRequest`

**Files:**
- Modify: `prisma/schema.prisma` (enum nuevo junto a `DeliveryChannelStatus`; modelo junto a `DeliveryChannelLink`; relación en `Venue`)
- Modify: `scripts/generate-schema-map.ts` (`MODEL_TO_DOMAIN`)
- Modify: `tests/__helpers__/setup.ts` (prismaMock)

**Interfaces:**
- Produces: modelo `DeliveryActivationRequest`; enum `DeliveryActivationStatus { PENDING, CONTACTED, CONNECTED, DISMISSED }`.

- [ ] **Step 1: Agregar enum** (junto a `enum DeliveryChannelStatus`):

```prisma
enum DeliveryActivationStatus {
  PENDING    // el dueño solicitó; en cola de ops
  CONTACTED  // ops en contacto / configurando con Deliverect
  CONNECTED  // ya tiene canal ACTIVE (ops lo marcó al conectar)
  DISMISSED  // descartada (ya no aplica)
}
```

- [ ] **Step 2: Agregar modelo** (junto a `model DeliveryChannelLink`):

```prisma
/// Solicitud de un venue para activar delivery. El dueño la crea (self-serve,
/// expresa intención); ops la avanza al conectar el canal real con Deliverect.
/// Distinta de DeliveryChannelLink (la conexión técnica real).
model DeliveryActivationRequest {
  id            String  @id @default(cuid())
  venueId       String
  venue         Venue   @relation(fields: [venueId], references: [id], onDelete: Cascade)
  requestedById String?
  requestedBy   Staff?  @relation("DeliveryActivationRequestedBy", fields: [requestedById], references: [id], onDelete: SetNull)

  status DeliveryActivationStatus @default(PENDING)
  /// Canales que el dueño declara tener/querer (informativo para ops)
  requestedChannels String[]
  note        String?   @db.Text

  contactedAt DateTime?
  connectedAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([venueId])
  @@index([status])
}
```

- [ ] **Step 3: Relación en `Venue` y `Staff`**: en `model Venue {}` agregar `deliveryActivationRequests DeliveryActivationRequest[]`; en `model Staff {}` agregar `deliveryActivationRequests DeliveryActivationRequest[] @relation("DeliveryActivationRequestedBy")`.

- [ ] **Step 4: Migración:**

Run: `npx prisma migrate dev --name delivery-activation-request`
Expected: migración creada + aplicada, `prisma generate` OK. Antes de aplicar, revisar el SQL: solo `CREATE TYPE DeliveryActivationStatus`, `CREATE TABLE DeliveryActivationRequest`, 2 índices, 2 FKs — nada ajeno.

- [ ] **Step 5: Schema map** — en `scripts/generate-schema-map.ts`, `MODEL_TO_DOMAIN`, agregar:

```typescript
DeliveryActivationRequest: 'Orders, KDS & Cash',
```

Run: `npm run schema:map` → sin "unclassified model".

- [ ] **Step 6: prismaMock** — en `tests/__helpers__/setup.ts` junto a `deliveryChannelLink`: `deliveryActivationRequest: createMockModel(),`

- [ ] **Step 7:** `npx prisma validate && npm run build` → sin errores.

- [ ] **Step 8: Commit** — `git add prisma/ scripts/generate-schema-map.ts docs/SCHEMA_MAP.md tests/__helpers__/setup.ts && git commit -m "feat(delivery): schema DeliveryActivationRequest (solicitud de activación)"`

---

### Task 2: Servicio de solicitud de activación

**Files:**
- Create: `src/services/delivery-channels/core/deliveryActivation.service.ts`
- Test: `tests/unit/services/delivery-channels/deliveryActivation.service.test.ts`

**Interfaces:**
- Consumes: `logAction` de `src/services/dashboard/activity-log.service.ts` (firma: `logAction({ action, entity, entityId, staffId, venueId, data })`).
- Produces:
  - `getActivationRequest(venueId: string): Promise<DeliveryActivationRequest | null>` — la solicitud "viva" (status PENDING o CONTACTED) del venue, o null.
  - `createActivationRequest(venueId: string, requestedById: string, input: { requestedChannels: string[]; note?: string }): Promise<DeliveryActivationRequest>` — idempotente: si ya hay una viva, la devuelve sin crear otra.
  - `updateActivationStatus(id: string, status: DeliveryActivationStatus, performedBy: string): Promise<DeliveryActivationRequest>` — transición de ops; sella `contactedAt`/`connectedAt`.

- [ ] **Step 1: Tests (prismaMock, RED primero).** Casos NUEVOS:
  - `getActivationRequest` devuelve la solicitud con status en `[PENDING, CONTACTED]` (findFirst con ese filtro + `venueId`), null si no hay.
  - `createActivationRequest` cuando NO hay viva → crea PENDING con `requestedChannels`/`note`/`requestedById` + escribe ActivityLog `DELIVERY_ACTIVATION_REQUESTED` (staffId=requestedById, venueId, entity `DeliveryActivationRequest`, data con channels).
  - `createActivationRequest` cuando YA hay viva → devuelve la existente, NO crea, NO re-loguea (idempotente).
  - `updateActivationStatus(CONTACTED)` → set status + `contactedAt` + ActivityLog `DELIVERY_ACTIVATION_CONTACTED`; `(CONNECTED)` → `connectedAt` + `DELIVERY_ACTIVATION_CONNECTED`; `(DISMISSED)` → `DELIVERY_ACTIVATION_DISMISSED`.

```typescript
// esqueleto de asserts (escribir el archivo completo con este estilo):
import { DeliveryActivationStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import * as svc from '../../../../src/services/delivery-channels/core/deliveryActivation.service'

jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.deliveryActivationRequest.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.deliveryActivationRequest.create as jest.Mock).mockResolvedValue({ id: 'req1', venueId: 'v1', status: 'PENDING' })
})
```

- [ ] **Step 2:** Correr → FAIL (module not found).
- [ ] **Step 3: Implementar:**

```typescript
import prisma from '../../../utils/prismaClient'
import { DeliveryActivationRequest, DeliveryActivationStatus, Prisma } from '@prisma/client'
import { logAction } from '../../dashboard/activity-log.service'

const LIVE_STATUSES: DeliveryActivationStatus[] = ['PENDING', 'CONTACTED']

export async function getActivationRequest(venueId: string): Promise<DeliveryActivationRequest | null> {
  return prisma.deliveryActivationRequest.findFirst({
    where: { venueId, status: { in: LIVE_STATUSES } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function createActivationRequest(
  venueId: string,
  requestedById: string,
  input: { requestedChannels: string[]; note?: string },
): Promise<DeliveryActivationRequest> {
  const existing = await getActivationRequest(venueId)
  if (existing) return existing // idempotente: no duplicar una solicitud viva

  const created = await prisma.deliveryActivationRequest.create({
    data: {
      venueId,
      requestedById,
      requestedChannels: input.requestedChannels,
      note: input.note ?? null,
    },
  })
  void logAction({
    action: 'DELIVERY_ACTIVATION_REQUESTED',
    entity: 'DeliveryActivationRequest',
    entityId: created.id,
    staffId: requestedById,
    venueId,
    data: { requestedChannels: input.requestedChannels, note: input.note ?? null },
  })
  return created
}

const STATUS_ACTION: Record<DeliveryActivationStatus, string> = {
  PENDING: 'DELIVERY_ACTIVATION_REQUESTED',
  CONTACTED: 'DELIVERY_ACTIVATION_CONTACTED',
  CONNECTED: 'DELIVERY_ACTIVATION_CONNECTED',
  DISMISSED: 'DELIVERY_ACTIVATION_DISMISSED',
}

export async function updateActivationStatus(
  id: string,
  status: DeliveryActivationStatus,
  performedBy: string,
): Promise<DeliveryActivationRequest> {
  const data: Prisma.DeliveryActivationRequestUpdateInput = { status }
  if (status === 'CONTACTED') data.contactedAt = new Date()
  if (status === 'CONNECTED') data.connectedAt = new Date()

  const updated = await prisma.deliveryActivationRequest.update({ where: { id }, data })
  void logAction({
    action: STATUS_ACTION[status],
    entity: 'DeliveryActivationRequest',
    entityId: id,
    staffId: performedBy,
    venueId: updated.venueId,
    data: { status },
  })
  return updated
}
```

- [ ] **Step 4:** Correr → PASS. `npm run build`.
- [ ] **Step 5: Commit** — `git commit -m "feat(delivery): servicio de solicitud de activación (idempotente + ActivityLog)"`

---

### Task 3: Endpoints del dueño (solicitar / ver) + permiso

**Files:**
- Modify: `src/schemas/delivery-channels.schema.ts` (agregar `createActivationRequestSchema`)
- Modify: `src/controllers/delivery-channels/deliveryChannels.controller.ts` (2 handlers)
- Modify: `src/routes/delivery-channels.routes.ts` (2 rutas)
- Modify: `src/lib/permissions.ts` (`delivery-channels:request` en catálogo + defaults)
- Test: `tests/unit/services/delivery-channels/deliveryActivation.service.test.ts` ya cubre el servicio; agregar `tests/unit/controllers/delivery-channels/deliveryActivation.controller.test.ts` para los handlers.

**Interfaces:**
- Consumes: `getActivationRequest`, `createActivationRequest` (Task 2).
- Produces: rutas `POST /api/v1/delivery-channels/venues/:venueId/activation-request` y `GET .../activation-request`; permiso `delivery-channels:request`.

- [ ] **Step 1: Zod** en `src/schemas/delivery-channels.schema.ts` (español, shape-only):

```typescript
export const createActivationRequestSchema = z.object({
  body: z.object({
    requestedChannels: z
      .array(z.enum(['UBER_EATS', 'RAPPI', 'DIDI_FOOD'], { message: 'Canal inválido' }))
      .min(1, 'Selecciona al menos un canal'),
    note: z.string().max(1000, 'La nota es demasiado larga').optional(),
  }),
})
```

- [ ] **Step 2: Permiso** en `src/lib/permissions.ts`: en `INDIVIDUAL_PERMISSIONS_BY_RESOURCE['delivery-channels']` agregar `'delivery-channels:request'` al array existente. En `DEFAULT_PERMISSIONS`: agregar `'delivery-channels:request'` a **OWNER** y **ADMIN** (NO a MANAGER — solicitar delivery es decisión de negocio). Correr `npm run audit:permissions` → exit 0.

- [ ] **Step 3: Tests de controller (RED).** Casos: POST con body válido → 200/201 con la solicitud (llama `createActivationRequest` con `authContext.userId` como requestedById); POST idempotente → devuelve la existente; GET → devuelve la solicitud viva o `null`. authContext tomado de `(req as any).authContext`.

- [ ] **Step 4: Controller** — agregar a `deliveryChannels.controller.ts`:

```typescript
import * as activationService from '../../services/delivery-channels/core/deliveryActivation.service'

export const requestActivation = async (req: Request, res: Response) => {
  const { venueId, userId } = (req as any).authContext
  const request = await activationService.createActivationRequest(venueId, userId, req.body)
  res.json({ success: true, data: request })
}

export const getActivation = async (req: Request, res: Response) => {
  const { venueId } = (req as any).authContext
  const request = await activationService.getActivationRequest(venueId)
  res.json({ success: true, data: request })
}
```

- [ ] **Step 5: Rutas** en `src/routes/delivery-channels.routes.ts` (mismo patrón de middleware: authenticateToken → validateRequest → checkFeatureAccess → checkPermission):

```typescript
import { createActivationRequestSchema } from '../schemas/delivery-channels.schema'
// ...
router.post(
  '/venues/:venueId/activation-request',
  authenticateTokenMiddleware,
  validateRequest(createActivationRequestSchema),
  checkFeatureAccess('DELIVERY_CHANNELS'),
  checkPermission('delivery-channels:request'),
  ctrl.requestActivation,
)
router.get(
  '/venues/:venueId/activation-request',
  authenticateTokenMiddleware,
  checkFeatureAccess('DELIVERY_CHANNELS'),
  checkPermission('delivery-channels:read'),
  ctrl.getActivation,
)
```

- [ ] **Step 6:** Correr tests + `npm run audit:permissions` (exit 0) + `npm run build`.
- [ ] **Step 7: Commit** — `git commit -m "feat(delivery): endpoints dueño solicitar/ver activación + permiso delivery-channels:request"`

---

### Task 4: Endpoint de ops (superadmin: lista + avanzar status)

**Files:**
- Create: `src/routes/superadmin/deliveryActivation.routes.ts`
- Create: `src/controllers/superadmin/deliveryActivation.superadmin.controller.ts`
- Modify: `src/routes/superadmin.routes.ts` (montar el subrouter)
- Modify: `src/services/delivery-channels/core/deliveryActivation.service.ts` (agregar `listActivationRequests`)
- Test: `tests/unit/services/delivery-channels/deliveryActivation.service.test.ts` (agregar caso de `listActivationRequests`)

**Interfaces:**
- Consumes: `updateActivationStatus` (Task 2).
- Produces: `listActivationRequests(filter?: { status?: DeliveryActivationStatus }): Promise<DeliveryActivationRequest[]>`; rutas `GET /api/v1/superadmin/delivery-activation` + `PATCH /api/v1/superadmin/delivery-activation/:id`.

- [ ] **Step 1: Test del servicio (RED)** para `listActivationRequests`: sin filtro → todas ordenadas por `createdAt desc` con `venue: { select: { name, slug } }`; con `status` → filtradas.
- [ ] **Step 2: Implementar `listActivationRequests`** en el servicio:

```typescript
export async function listActivationRequests(filter?: { status?: DeliveryActivationStatus }): Promise<DeliveryActivationRequest[]> {
  return prisma.deliveryActivationRequest.findMany({
    where: filter?.status ? { status: filter.status } : {},
    orderBy: { createdAt: 'desc' },
    include: { venue: { select: { name: true, slug: true } } },
  })
}
```

- [ ] **Step 3: Controller** `deliveryActivation.superadmin.controller.ts`:

```typescript
import { Request, Response } from 'express'
import { DeliveryActivationStatus } from '@prisma/client'
import * as svc from '../../services/delivery-channels/core/deliveryActivation.service'

export const listRequests = async (req: Request, res: Response) => {
  const status = req.query.status as DeliveryActivationStatus | undefined
  const rows = await svc.listActivationRequests(status ? { status } : undefined)
  res.json({ success: true, data: rows })
}

export const updateRequest = async (req: Request, res: Response) => {
  const { userId } = (req as any).authContext
  const updated = await svc.updateActivationStatus(req.params.id, req.body.status, userId)
  res.json({ success: true, data: updated })
}
```

- [ ] **Step 4: Subrouter** `src/routes/superadmin/deliveryActivation.routes.ts` (gate SUPERADMIN, patrón del repo):

```typescript
import express from 'express'
import { authenticateTokenMiddleware } from '../../middlewares/authenticateToken.middleware'
import { authorizeRole } from '../../middlewares/authorizeRole.middleware'
import { StaffRole } from '@prisma/client'
import { validateRequest } from '../../middlewares/validation'
import { z } from 'zod'
import * as ctrl from '../../controllers/superadmin/deliveryActivation.superadmin.controller'

const router = express.Router()
const updateStatusSchema = z.object({
  body: z.object({ status: z.enum(['PENDING', 'CONTACTED', 'CONNECTED', 'DISMISSED'], { message: 'Estado inválido' }) }),
})

router.get('/', authenticateTokenMiddleware, authorizeRole(StaffRole.SUPERADMIN), ctrl.listRequests)
router.patch('/:id', authenticateTokenMiddleware, authorizeRole(StaffRole.SUPERADMIN), validateRequest(updateStatusSchema), ctrl.updateRequest)

export default router
```

- [ ] **Step 5: Montar** en `src/routes/superadmin.routes.ts`: `import deliveryActivationRoutes from './superadmin/deliveryActivation.routes'` + (junto a los otros `router.use`) `router.use('/delivery-activation', deliveryActivationRoutes)`.
- [ ] **Step 6:** Correr tests + `npm run build`.
- [ ] **Step 7: Commit** — `git commit -m "feat(delivery): ops superadmin — cola de solicitudes + avanzar status"`

---

### Task 5: Resumen diario por canal (servicio compartido + REST) — DRY con el MCP

**Files:**
- Create: `src/services/delivery-channels/core/deliverySummary.service.ts`
- Modify: `src/mcp/tools/deliveryChannels.ts` (usar el servicio compartido en vez del cálculo inline)
- Modify: `src/controllers/delivery-channels/deliveryChannels.controller.ts` (handler `getSummary`)
- Modify: `src/routes/delivery-channels.routes.ts` (ruta `GET .../delivery/summary`)
- Test: `tests/unit/services/delivery-channels/deliverySummary.service.test.ts`

**Interfaces:**
- Produces: `getDeliveryDailySummary(venueId: string): Promise<{ channels: Array<{ channel: string; orders: number; totalPesos: number }>; generatedAt: string }>` — pedidos e ingreso de HOY (venue-local) por `OrderSource` de delivery.

- [ ] **Step 1: Test (RED).** Casos: agrupa `Order` con `originSystem: 'DELIVERY_PLATFORM'` de hoy (venue-local vía `venueStartOfDay(tz)`) por `source`; `totalPesos = Number(_sum.total)` (pesos, no cents); venue sin pedidos → `channels: []`. Reusar el patrón de fecha venue-local ya usado en `src/mcp/tools/deliveryChannels.ts` (que Task 12 del backend cableó con `venueStartOfDay`).
- [ ] **Step 2: Implementar** extrayendo la lógica que hoy vive inline en el MCP tool:

```typescript
import prisma from '../../../utils/prismaClient'
import { venueStartOfDay } from '../../../utils/... /* misma util que usa mcp/tools/deliveryChannels.ts */'

export async function getDeliveryDailySummary(venueId: string) {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue?.timezone ?? 'America/Mexico_City'
  const startOfToday = venueStartOfDay(tz)
  const grouped = await prisma.order.groupBy({
    by: ['source'],
    where: { venueId, originSystem: 'DELIVERY_PLATFORM', createdAt: { gte: startOfToday } },
    _count: { id: true },
    _sum: { total: true },
  })
  return {
    channels: grouped.map(g => ({ channel: g.source, orders: g._count.id, totalPesos: Number(g._sum.total ?? 0) })),
    generatedAt: new Date().toISOString(),
  }
}
```
(Confirmar el import exacto de `venueStartOfDay` leyendo `src/mcp/tools/deliveryChannels.ts` — usar el mismo.)

- [ ] **Step 3: Refactor MCP tool** `src/mcp/tools/deliveryChannels.ts`: reemplazar el cálculo inline de `todayByChannel` por `const { channels } = await getDeliveryDailySummary(venueId)` y mapear a la forma que ya devuelve (no cambiar el shape de salida del tool — solo la fuente). Correr `tests/unit/mcp-customer/delivery-channels.test.ts` → sigue verde (regresión).
- [ ] **Step 4: REST** — handler + ruta:

```typescript
// controller
export const getSummary = async (req: Request, res: Response) => {
  const { venueId } = (req as any).authContext
  const summary = await getDeliveryDailySummary(venueId)
  res.json({ success: true, data: summary })
}
// ruta (delivery-channels.routes.ts)
router.get('/venues/:venueId/delivery/summary', authenticateTokenMiddleware, checkFeatureAccess('DELIVERY_CHANNELS'), checkPermission('delivery-channels:read'), ctrl.getSummary)
```

- [ ] **Step 5:** Tests (summary + regresión MCP) + `npm run build`.
- [ ] **Step 6: Commit** — `git commit -m "feat(delivery): resumen diario por canal (servicio compartido MCP+REST)"`

---

### Task 6: MCP tool `delivery_activation_requests` (lockstep)

**Files:**
- Create: `src/mcp/tools/deliveryActivation.ts`
- Modify: `src/mcp/server.ts` (registrar)
- Test: `tests/unit/mcp-customer/delivery-activation.test.ts`

**Interfaces:**
- Consumes: `listActivationRequests` (Task 4).
- Produces: tool `delivery_activation_requests` (lee la cola; scope por `getUserAccess`).

- [ ] **Step 1: Implementar** (patrón exacto de `src/mcp/tools/deliveryChannels.ts` — guard, venueFilter, text; solo lectura, sin confirm-gate). El tool lista solicitudes de los venues en scope del usuario (filtrar por `venueId in scope`). Como es una vista de ops, gatear con `guard.requirePermission('delivery-channels:read', venueId)` por venue O exponer solo lo que el scope permite.
- [ ] **Step 2: Registrar** en `src/mcp/server.ts` junto a `registerDeliveryChannelTools`.
- [ ] **Step 3: Test** (o build + verificación de registro si no hay patrón de test) + `npm run build`.
- [ ] **Step 4: Commit** — `git commit -m "feat(mcp): tool delivery_activation_requests (lockstep)"`

---

### Task 7: Verificación final backend

- [ ] **Step 1:** `npm run format && npm run lint:fix` (solo archivos delivery).
- [ ] **Step 2:** `npm run audit:permissions` → exit 0 (permiso `delivery-channels:request` sin PHANTOM/CATALOG_GAP nuevos).
- [ ] **Step 3:** `TZ=UTC npx jest tests/unit/services/delivery-channels tests/unit/controllers/delivery-channels tests/unit/mcp-customer --silent` → verde.
- [ ] **Step 4:** `npm run pre-deploy` → MUST pass (si excede timeout, correr componentes en secuencia; nunca confiar en notificación de background sin `pgrep`).
- [ ] **Step 5:** Actualizar memoria del proyecto (estado del backend de activación).
- [ ] **Step 6: Commit** final si quedó format suelto.

---

## Self-review del plan (hecho)
- **Cobertura spec §4:** modelo→T1; endpoints dueño→T3; ops→T4; MCP→T6; ActivityLog→T2 (cada mutación); summary (§6 del spec)→T5.
- **Sin placeholders:** el único "confirmar import de `venueStartOfDay`" es una lectura puntual de un archivo existente, no un hueco de diseño.
- **Consistencia de tipos:** `DeliveryActivationRequest`/`DeliveryActivationStatus` (T1) consumidos por T2/T4/T6; `getActivationRequest`/`createActivationRequest` (T2) por T3; `getDeliveryDailySummary` (T5) por MCP+REST; permiso `delivery-channels:request` idéntico T3.
