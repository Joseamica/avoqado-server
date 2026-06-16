# Venue Audit-Log (PRO, owner-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give venue owners a per-venue Activity Log screen at `/venues/:slug/activity-log` with full filters, gated to PRO and owner-only, plus capture of the POS events that aren't audited today.

**Architecture:** Reuse the existing `ActivityLog` model + `logAction()` writer (no schema change). New `Feature` code `VENUE_AUDIT_LOG` gates the tier (PRO+ via `venueHasFeatureAccess`, FREE blocked). New permission `activity:read` (default OWNER) gates the role. A venue-scoped read endpoint + service feed a cloned dashboard page. Explicit `logAction()` calls fill the capture gaps. A customer-MCP read tool mirrors the capability.

**Tech Stack:** Express + TypeScript + Prisma (server), React 18 + Vite + TanStack Query (dashboard), MCP (`@modelcontextprotocol/sdk`), Jest.

**Spec:** `docs/plans/2026-06-15-venue-audit-log-pro-design.md`

**Phases (each independently shippable):**
1. Backend gating foundation (permission + feature)
2. Backend read API (service + endpoint)
3. Backend event capture (logAction at POS points)
4. Customer MCP read tool
5. Dashboard screen
6. Sales-presentation lockstep

**Repos:** `avoqado-server` (branch `develop`), `avoqado-web-dashboard`, `Avoqado-HQ` (docs). All server paths below are relative to `avoqado-server/`; dashboard paths to `avoqado-web-dashboard/`.

> ⚠️ **Working tree caution (server):** `develop` has uncommitted WIP touching `src/services/access/basePlan.service.ts`, `src/mcp/tools/sales.ts`, reports/sales-summary files (TransactionExport work). This plan does NOT need to edit `basePlan.service.ts` (we intentionally leave `VENUE_AUDIT_LOG` OUT of `PREMIUM_ONLY_CODES` so it's PRO by default). Stage only the files each task names; never `git add -A`.

---

## Phase 1 — Backend gating foundation

### Task 1: Add `activity:read` permission (default OWNER)

**Files:**
- Modify: `src/lib/permissions.ts` (OWNER defaults + catalog)
- Test: `npm run audit:permissions`

- [ ] **Step 1: Add to `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`**

In `src/lib/permissions.ts`, find `const INDIVIDUAL_PERMISSIONS_BY_RESOURCE: Record<string, string[]> = {` (around line 1236). Add a new entry alphabetically (after `analytics`, before `billing`/`settlements`):

```typescript
  activity: ['activity:read'],
```

- [ ] **Step 2: Add to `DEFAULT_PERMISSIONS[StaffRole.OWNER]`**

In the `[StaffRole.OWNER]: [ ... ]` array (around line 820), add near the top foundational reads (right after `'home:*',`):

```typescript
    'activity:read', // Bitácora de auditoría por-venue (Pro-tier, owner-only)
```

Do **NOT** add it to `[StaffRole.SUPERADMIN]` — its `'*:*'` wildcard already covers it. Do **NOT** add it to ADMIN/MANAGER (owner-only by design; assignable later via the role editor since it's cataloged).

- [ ] **Step 3: Run the permission audit**

Run: `npm run audit:permissions`
Expected: exit 0, no `PHANTOM` / `CATALOG_GAP` for `activity:read`. (It is satisfiable by OWNER + SUPERADMIN wildcard, and cataloged in `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/permissions.ts
git commit -m "feat(permissions): add activity:read (default OWNER) for venue audit log"
```

---

### Task 2: Mirror `activity:read` in the dashboard permission catalog

**Files:**
- Modify: `avoqado-web-dashboard/src/lib/permissions/defaultPermissions.ts`
- Modify: `avoqado-web-dashboard/src/lib/permissions/roleHierarchy.ts` (only if it enumerates per-resource permissions; skip if it just ranks roles)

- [ ] **Step 1: Locate the OWNER default list**

In `avoqado-web-dashboard/src/lib/permissions/defaultPermissions.ts`, find the OWNER entry (mirrors the backend). Add `'activity:read'` to it, matching the EXACT string. If the file has a per-resource catalog like the backend's `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`, add `activity: ['activity:read']` there too.

- [ ] **Step 2: Verify build**

Run (from `avoqado-web-dashboard/`): `npm run build`
Expected: PASS (no TS errors).

- [ ] **Step 3: Commit (dashboard repo)**

```bash
# from avoqado-web-dashboard/
git add src/lib/permissions/defaultPermissions.ts
git commit -m "feat(permissions): mirror activity:read for venue audit log"
```

---

### Task 3: Seed the `VENUE_AUDIT_LOG` Feature row

**Files:**
- Create: `scripts/seed-venue-audit-log.ts`

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-venue-audit-log.ts`:

```typescript
// DELETE AFTER: one-time idempotent seed (safe to keep — uses upsert)
// Purpose: register the VENUE_AUDIT_LOG Feature so it's assignable + shows in the catalog.
// Run: npx ts-node -r tsconfig-paths/register scripts/seed-venue-audit-log.ts
import prisma from '../src/utils/prismaClient'

async function main() {
  const feature = await prisma.feature.upsert({
    where: { code: 'VENUE_AUDIT_LOG' },
    update: { active: true },
    create: {
      code: 'VENUE_AUDIT_LOG',
      name: 'Bitácora de auditoría',
      description: 'Historial de actividad por sucursal: quién hizo qué y cuándo (incluido en el plan Pro)',
      category: 'OPERATIONS',
      monthlyPrice: 0,
      active: true,
    },
  })
  console.log('✅ Seeded Feature', feature.code, feature.id)
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
```

> Note: `category` must be a valid `FeatureCategory` enum value — confirm `OPERATIONS` exists in `prisma/schema.prisma` (`enum FeatureCategory`); if not, pick the closest (e.g. `REPORTING`). `monthlyPrice: 0` because it's bundled into PRO, not billed separately.

- [ ] **Step 2: Run the seed against dev DB**

Run: `npx ts-node -r tsconfig-paths/register scripts/seed-venue-audit-log.ts`
Expected: `✅ Seeded Feature VENUE_AUDIT_LOG <cuid>`

- [ ] **Step 3: Verify the gate resolves to PRO**

Confirm in `src/services/access/basePlan.service.ts` that `VENUE_AUDIT_LOG` is **NOT** in `PREMIUM_ONLY_CODES` and **NOT** in `FREE_TIER_CODES`. (No edit needed — absence from both lists means `venueHasFeatureAccess` grants it to PRO+PREMIUM and denies FREE.)

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-venue-audit-log.ts
git commit -m "feat(features): seed VENUE_AUDIT_LOG Feature (PRO tier)"
```

---

## Phase 2 — Backend read API

### Task 4: Venue-scoped query service

**Files:**
- Modify: `src/services/dashboard/activity-log.service.ts` (append new functions)
- Test: `tests/unit/services/dashboard/venueActivityLog.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/dashboard/venueActivityLog.service.test.ts`:

```typescript
import { queryVenueActivityLogs } from '../../../../src/services/dashboard/activity-log.service'
import prisma from '../../../../src/utils/prismaClient'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    activityLog: { count: jest.fn(), findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
  },
}))

const mockPrisma = prisma as unknown as {
  activityLog: { count: jest.Mock; findMany: jest.Mock }
  venue: { findUnique: jest.Mock }
}

describe('queryVenueActivityLogs', () => {
  beforeEach(() => jest.clearAllMocks())

  it('scopes the query to exactly one venueId and paginates', async () => {
    mockPrisma.venue.findUnique.mockResolvedValue({ id: 'v1', name: 'Sucursal Centro' })
    mockPrisma.activityLog.count.mockResolvedValue(1)
    mockPrisma.activityLog.findMany.mockResolvedValue([
      { id: 'a1', action: 'ORDER_CREATED', entity: 'Order', entityId: 'o1', data: {}, ipAddress: null, createdAt: new Date(), staff: null, venueId: 'v1' },
    ])

    const result = await queryVenueActivityLogs({ venueId: 'v1', page: 1, pageSize: 25 })

    const whereArg = mockPrisma.activityLog.findMany.mock.calls[0][0].where
    expect(whereArg.venueId).toBe('v1')
    expect(result.logs[0].venueName).toBe('Sucursal Centro')
    expect(result.pagination.total).toBe(1)
  })

  it('applies action + date filters when provided', async () => {
    mockPrisma.venue.findUnique.mockResolvedValue({ id: 'v1', name: 'X' })
    mockPrisma.activityLog.count.mockResolvedValue(0)
    mockPrisma.activityLog.findMany.mockResolvedValue([])

    await queryVenueActivityLogs({ venueId: 'v1', action: 'PAYMENT_COMPLETED', startDate: '2026-06-01', endDate: '2026-06-15' })

    const whereArg = mockPrisma.activityLog.findMany.mock.calls[0][0].where
    expect(whereArg.action).toBe('PAYMENT_COMPLETED')
    expect(whereArg.createdAt.gte).toBeInstanceOf(Date)
    expect(whereArg.createdAt.lte).toBeInstanceOf(Date)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- venueActivityLog.service`
Expected: FAIL — `queryVenueActivityLogs is not a function`.

- [ ] **Step 3: Implement the service functions**

Append to `src/services/dashboard/activity-log.service.ts` (after `getDistinctActions`, before the SUPERADMIN section):

```typescript
// ==========================================
// VENUE-SCOPED — Owner audit log (single venue)
// ==========================================

export interface QueryVenueActivityLogsParams {
  venueId: string
  staffId?: string
  action?: string
  entity?: string
  search?: string
  startDate?: string
  endDate?: string
  page?: number
  pageSize?: number
}

/**
 * Query activity logs for ONE venue with filters + pagination.
 * Venue-scoped variant of {@link queryActivityLogs} (no org→venues fan-out).
 */
export async function queryVenueActivityLogs(params: QueryVenueActivityLogsParams): Promise<PaginatedActivityLogs> {
  const { venueId, page = 1, pageSize = 25 } = params

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, name: true } })
  if (!venue) {
    return { logs: [], pagination: { page, pageSize, total: 0, totalPages: 0 } }
  }

  const where: Record<string, unknown> = { venueId }
  if (params.staffId) where.staffId = params.staffId
  if (params.action) where.action = params.action
  if (params.entity) where.entity = params.entity
  if (params.search) {
    where.OR = [
      { action: { contains: params.search, mode: 'insensitive' } },
      { entity: { contains: params.search, mode: 'insensitive' } },
      { entityId: { contains: params.search, mode: 'insensitive' } },
    ]
  }
  if (params.startDate || params.endDate) {
    const createdAt: Record<string, Date> = {}
    if (params.startDate) createdAt.gte = new Date(params.startDate)
    if (params.endDate) createdAt.lte = new Date(params.endDate)
    where.createdAt = createdAt
  }

  const [total, logs] = await Promise.all([
    prisma.activityLog.count({ where: where as any }),
    prisma.activityLog.findMany({
      where: where as any,
      include: { staff: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  const enrichedLogs: ActivityLogEntry[] = logs.map(log => ({
    id: log.id,
    action: log.action,
    entity: log.entity,
    entityId: log.entityId,
    data: log.data,
    ipAddress: log.ipAddress,
    createdAt: log.createdAt,
    staff: log.staff,
    venueName: venue.name,
  }))

  return { logs: enrichedLogs, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } }
}

/** Distinct action strings for ONE venue (filter dropdown). */
export async function getVenueDistinctActions(venueId: string): Promise<string[]> {
  const results = await prisma.activityLog.findMany({
    where: { venueId },
    select: { action: true },
    distinct: ['action'],
    orderBy: { action: 'asc' },
  })
  return results.map(r => r.action)
}

/** Distinct entity strings for ONE venue (filter dropdown). */
export async function getVenueDistinctEntities(venueId: string): Promise<string[]> {
  const results = await prisma.activityLog.findMany({
    where: { venueId, entity: { not: null } },
    select: { entity: true },
    distinct: ['entity'],
    orderBy: { entity: 'asc' },
  })
  return results.map(r => r.entity!).filter(Boolean)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- venueActivityLog.service`
Expected: PASS (both tests).

- [ ] **Step 5: Type-check (jest is transpile-only)**

Run: `npx tsc --noEmit`
Expected: no new errors in the edited files.

- [ ] **Step 6: Commit**

```bash
git add src/services/dashboard/activity-log.service.ts tests/unit/services/dashboard/venueActivityLog.service.test.ts
git commit -m "feat(activity-log): venue-scoped query service + distinct helpers"
```

---

### Task 5: Validation schema + controller

**Files:**
- Create: `src/controllers/dashboard/activityLog.dashboard.controller.ts`
- Create: `src/schemas/dashboard/activityLog.schema.ts` (or co-locate; match existing schema convention — check where other dashboard schemas live)

- [ ] **Step 1: Write the query validation schema**

Create `src/schemas/dashboard/activityLog.schema.ts` (Zod, Spanish messages per rule):

```typescript
import { z } from 'zod'

export const activityLogQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    staffId: z.string().optional(),
    action: z.string().optional(),
    entity: z.string().optional(),
    search: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  }),
})
```

> Confirm the `validateRequest` middleware expects the `{ query: {...} }` envelope — check another schema that validates `req.query` (e.g. a reports schema). Match its shape exactly.

- [ ] **Step 2: Write the controller (thin)**

Create `src/controllers/dashboard/activityLog.dashboard.controller.ts`:

```typescript
import { Request, Response, NextFunction } from 'express'
import {
  queryVenueActivityLogs,
  getVenueDistinctActions,
  getVenueDistinctEntities,
} from '../../services/dashboard/activity-log.service'

export async function getActivityLog(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const result = await queryVenueActivityLogs({
      venueId,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      staffId: req.query.staffId as string | undefined,
      action: req.query.action as string | undefined,
      entity: req.query.entity as string | undefined,
      search: req.query.search as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export async function getActivityLogActions(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    res.json({ success: true, data: await getVenueDistinctActions(venueId) })
  } catch (err) {
    next(err)
  }
}

export async function getActivityLogEntities(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    res.json({ success: true, data: await getVenueDistinctEntities(venueId) })
  } catch (err) {
    next(err)
  }
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/controllers/dashboard/activityLog.dashboard.controller.ts src/schemas/dashboard/activityLog.schema.ts
git commit -m "feat(activity-log): query schema + thin controller"
```

---

### Task 6: Routes + mount + guards

**Files:**
- Create: `src/routes/dashboard/activityLog.routes.ts`
- Modify: `src/routes/dashboard.routes.ts` (import + mount)
- Test: `tests/api-tests/dashboard/venueActivityLog.api.test.ts`

- [ ] **Step 1: Write the routes file**

Create `src/routes/dashboard/activityLog.routes.ts`:

```typescript
import express from 'express'
import { checkPermission } from '../../middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '../../middlewares/checkFeatureAccess.middleware'
import { validateRequest } from '../../middlewares/validation'
import { activityLogQuerySchema } from '../../schemas/dashboard/activityLog.schema'
import * as activityLogController from '../../controllers/dashboard/activityLog.dashboard.controller'

// Mounted at /api/v1/dashboard/venues/:venueId/activity-log (authenticateTokenMiddleware applied at mount).
// Guard order per route: feature (PRO?) → permission (owner?).
const router = express.Router({ mergeParams: true })

router.get(
  '/',
  checkFeatureAccess('VENUE_AUDIT_LOG'),
  checkPermission('activity:read'),
  validateRequest(activityLogQuerySchema),
  activityLogController.getActivityLog,
)

router.get(
  '/actions',
  checkFeatureAccess('VENUE_AUDIT_LOG'),
  checkPermission('activity:read'),
  activityLogController.getActivityLogActions,
)

router.get(
  '/entities',
  checkFeatureAccess('VENUE_AUDIT_LOG'),
  checkPermission('activity:read'),
  activityLogController.getActivityLogEntities,
)

export default router
```

> `mergeParams: true` is required so `:venueId` from the mount path reaches `checkPermission`/`checkFeatureAccess` (they resolve venueId from `req.params.venueId`). Confirm `validateRequest` import path matches the project (`../../middlewares/validation`).

- [ ] **Step 2: Mount the router**

In `src/routes/dashboard.routes.ts`, add the import near the other `./dashboard/*` route imports:

```typescript
import activityLogRoutes from './dashboard/activityLog.routes'
```

Then in the router-mount section (near the other `router.use('/venues/:venueId/...', authenticateTokenMiddleware, ...)` lines, e.g. by `manualPaymentRoutes`):

```typescript
router.use('/venues/:venueId/activity-log', authenticateTokenMiddleware, activityLogRoutes)
```

- [ ] **Step 3: Write the API test**

Create `tests/api-tests/dashboard/venueActivityLog.api.test.ts`. Mirror an existing dashboard api-test's auth/setup harness (copy the `beforeAll` login + venue setup from a sibling test in `tests/api-tests/dashboard/`). Assertions:

```typescript
// 1. FREE venue (no PLAN_PRO/PREMIUM) → 403 from checkFeatureAccess
// 2. PRO venue + OWNER token → 200, body.success === true, body.data.logs is an array
// 3. PRO venue + non-owner (e.g. CASHIER) token → 403 from checkPermission
// 4. GET /actions and /entities → 200 with string[]
```

Write each as a concrete `it()` using the harness's authenticated `request(app).get('/api/v1/dashboard/venues/<id>/activity-log')` calls with the right tokens. Use a PRO test venue fixture (grant `PLAN_PRO` VenueFeature) and a FREE one.

- [ ] **Step 4: Run the API test**

Run: `npm run test:api -- venueActivityLog`
Expected: PASS (4 cases). If the FREE 403 fails, verify the test venue truly lacks a paid base plan and is not grandfathered/demo (those bypass gating).

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` (expected: clean)

```bash
git add src/routes/dashboard/activityLog.routes.ts src/routes/dashboard.routes.ts tests/api-tests/dashboard/venueActivityLog.api.test.ts
git commit -m "feat(activity-log): venue-scoped read endpoint (PRO + owner gated)"
```

---

## Phase 3 — Backend event capture

> Each task adds `logAction()` at a success path. `logAction` is fire-and-forget (`void`, never throws). Pass `staffId` from the function's params (services have no `authContext`); `null` is fine for system actions (sentinels normalized internally). **Refund is already logged** (`src/services/mobile/refund.mobile.service.ts:119` — `REFUND_CREATED`), so it's excluded.

### Task 7: Capture `ORDER_CREATED`

**Files:**
- Modify: `src/services/tpv/order.tpv.service.ts`
- Modify: `src/services/mobile/order.mobile.service.ts`
- Test: `tests/unit/services/tpv/orderCapture.test.ts`

- [ ] **Step 1: Identify the canonical public creation function**

Run: `grep -n "export async function create" src/services/tpv/order.tpv.service.ts src/services/mobile/order.mobile.service.ts`
Goal: find the public order-creation entry point(s) called by controllers. `order.tpv.service.ts` has two `prisma.order.create` sites (~line 393 and ~line 1154 inside a `$transaction` that returns `createdOrder`). **Log once per public function**, not per inner create — verify the 393 path isn't an inner helper of the 1154 flow (if it is, log only the outer). Record which functions you'll instrument.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/services/tpv/orderCapture.test.ts`. Mock `logAction` and the order-creation deps, call the public TPV order-create function, assert `logAction` was called once with `action: 'ORDER_CREATED'`, `entity: 'Order'`, the created `entityId`, and `venueId`:

```typescript
import * as activityLog from '../../../../src/services/dashboard/activity-log.service'
// ... mock prisma + other deps the function needs, then:
const spy = jest.spyOn(activityLog, 'logAction').mockResolvedValue()
// call the public createOrder... function with a minimal valid input
expect(spy).toHaveBeenCalledWith(expect.objectContaining({ action: 'ORDER_CREATED', entity: 'Order', venueId: expect.any(String) }))
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- orderCapture`
Expected: FAIL (logAction not called).

- [ ] **Step 4: Add the import + logAction calls**

At the top of `src/services/tpv/order.tpv.service.ts` (if not already imported):

```typescript
import { logAction } from '../dashboard/activity-log.service'
```

In the canonical TPV creation function, immediately after the order is created/resolved (e.g. after `fetchOrderForTpvResponse(createdOrder.id)` resolves, ~line 1157, or after the `prisma.order.create` at ~line 440 if that's the public path):

```typescript
void logAction({
  staffId: input.staffId ?? input.waiterId ?? null,
  venueId,
  action: 'ORDER_CREATED',
  entity: 'Order',
  entityId: createdOrder.id,
  data: { orderNumber: createdOrder.orderNumber, type: input.orderType, source: input.source, itemCount: input.items?.length },
})
```

(Adjust the entity-id variable name to whatever the function holds — `order.id` vs `createdOrder.id`.)

Then in `src/services/mobile/order.mobile.service.ts`, add the import and, after the `prisma.order.create` success (~line 568):

```typescript
void logAction({
  staffId: validatedStaffId ?? null,
  venueId,
  action: 'ORDER_CREATED',
  entity: 'Order',
  entityId: order.id,
  data: { orderNumber, total: Number(order.total), source: input.source, itemCount: input.items.length },
})
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- orderCapture`
Expected: PASS.

- [ ] **Step 6: Type-check + commit**

```bash
git add src/services/tpv/order.tpv.service.ts src/services/mobile/order.mobile.service.ts tests/unit/services/tpv/orderCapture.test.ts
git commit -m "feat(activity-log): capture ORDER_CREATED (tpv + mobile)"
```

---

### Task 8: Capture `PAYMENT_COMPLETED`

**Files:**
- Modify: `src/services/tpv/payment.tpv.service.ts`
- Test: `tests/unit/services/tpv/paymentCapture.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/tpv/paymentCapture.test.ts`. Spy on `logAction`, drive `recordOrderPayment` through its success path (mock prisma so the payment + order-total update succeed), assert one call with `action: 'PAYMENT_COMPLETED'`, `entity: 'Payment'`, the payment id, and `venueId`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- paymentCapture`
Expected: FAIL.

- [ ] **Step 3: Add the logAction call**

`logAction` is already imported in `src/services/tpv/payment.tpv.service.ts` (~line 20). After the success log `logger.info('Payment recorded successfully', ...)` (~line 2017), add:

```typescript
void logAction({
  staffId: validatedStaffId ?? paymentData.staffId ?? null,
  venueId,
  action: 'PAYMENT_COMPLETED',
  entity: 'Payment',
  entityId: payment.id,
  data: { amount: Number(totalAmount), tip: Number(tipAmount), method: payment.method, orderId: activeOrder.id },
})
```

(Confirm `validatedStaffId`, `paymentData`, `totalAmount`, `tipAmount`, `payment`, `activeOrder` are in scope at that line; adjust names to the actual locals.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- paymentCapture`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

```bash
git add src/services/tpv/payment.tpv.service.ts tests/unit/services/tpv/paymentCapture.test.ts
git commit -m "feat(activity-log): capture PAYMENT_COMPLETED on recordOrderPayment success"
```

---

### Task 9: Capture `SHIFT_OPENED` / `SHIFT_CLOSED`

**Files:**
- Modify: `src/services/tpv/shift.tpv.service.ts`
- Test: `tests/unit/services/tpv/shiftCapture.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/tpv/shiftCapture.test.ts`. Spy on `logAction`. (1) call the open-shift function → assert `SHIFT_OPENED`, `entity: 'Shift'`, `entityId`, `venueId`. (2) call the close-shift function → assert `SHIFT_CLOSED`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- shiftCapture`
Expected: FAIL.

- [ ] **Step 3: Add import + both logAction calls**

Add `import { logAction } from '../dashboard/activity-log.service'` at the top. After the open-shift success log (~line 1070):

```typescript
void logAction({
  staffId,
  venueId,
  action: 'SHIFT_OPENED',
  entity: 'Shift',
  entityId: shift.id,
  data: { startingCash, stationId, isIntegratedPOS },
})
```

Find the close-shift update (search `status: 'CLOSED'` / `endTime:` in the same file, in `closeShiftForVenue`). After that update succeeds:

```typescript
void logAction({
  staffId: shift.staffId,
  venueId,
  action: 'SHIFT_CLOSED',
  entity: 'Shift',
  entityId: shift.id,
  data: { endingCash: shift.endingCash, totalSales: Number(shift.totalSales ?? 0), totalTips: Number(shift.totalTips ?? 0) },
})
```

(Adjust field names to the actual closed-shift object.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- shiftCapture`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

```bash
git add src/services/tpv/shift.tpv.service.ts tests/unit/services/tpv/shiftCapture.test.ts
git commit -m "feat(activity-log): capture SHIFT_OPENED + SHIFT_CLOSED"
```

---

### Task 10: Capture `STAFF_CREATED` / `STAFF_UPDATED` / `STAFF_DELETED`

**Files:**
- Modify: `src/services/superadmin/staff.superadmin.service.ts`
- Test: `tests/unit/services/superadmin/staffCapture.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/superadmin/staffCapture.test.ts`. Spy on `logAction`; drive create/update/delete (mock prisma) and assert each logs the matching action + `entity: 'Staff'` + the staff id.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- staffCapture`
Expected: FAIL.

- [ ] **Step 3: Add import + three logAction calls**

Add `import { logAction } from '../dashboard/activity-log.service'` at the top. After create success (~line 287):

```typescript
void logAction({
  staffId: null,
  venueId: venueId ?? null,
  action: 'STAFF_CREATED',
  entity: 'Staff',
  entityId: staff.id,
  data: { email, firstName, lastName, organizationId, orgRole, venueRole },
})
```

After update success (~line 310):

```typescript
void logAction({
  staffId: null,
  venueId: null,
  action: 'STAFF_UPDATED',
  entity: 'Staff',
  entityId: updated.id,
  data: { email: updated.email, changes: data },
})
```

After delete success (~line 598):

```typescript
void logAction({
  staffId: null,
  venueId: null,
  action: 'STAFF_DELETED',
  entity: 'Staff',
  entityId: staffId,
  data: { email: staff.email },
})
```

> `staffId: null` (actor) here because the superadmin service has no authContext. Optional follow-up: thread the acting superadmin's id from the controller so the actor is recorded — out of scope for this task.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- staffCapture`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

```bash
git add src/services/superadmin/staff.superadmin.service.ts tests/unit/services/superadmin/staffCapture.test.ts
git commit -m "feat(activity-log): capture STAFF_CREATED/UPDATED/DELETED"
```

---

## Phase 4 — Customer MCP read tool

### Task 11: `get_activity_log` MCP tool

**Files:**
- Create: `src/mcp/tools/activity-log.ts`
- Modify: `src/mcp/server.ts` (import + register)
- Test: `tests/unit/mcp-customer/activity-log.test.ts`

- [ ] **Step 1: Write the tool**

Create `src/mcp/tools/activity-log.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'

export function registerActivityLogTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)
  server.tool(
    'get_activity_log',
    "Audit trail for your venue(s): who did what and when (orders, payments, shifts, staff, config changes). Most recent first. Pass venueId to focus one venue; filter by action or date range.",
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      action: z.string().optional().describe('Filter by exact action code, e.g. PAYMENT_COMPLETED'),
      startDate: z.string().optional().describe('ISO date lower bound (inclusive)'),
      endDate: z.string().optional().describe('ISO date upper bound (inclusive)'),
      limit: z.number().int().min(1).max(100).default(25).describe('Max rows'),
    },
    async ({ venueId, action, startDate, endDate, limit }) => {
      const where: Record<string, unknown> = { ...guard.venueFilter(venueId) }
      if (action) where.action = action
      if (startDate || endDate) {
        const createdAt: Record<string, Date> = {}
        if (startDate) createdAt.gte = new Date(startDate)
        if (endDate) createdAt.lte = new Date(endDate)
        where.createdAt = createdAt
      }
      const logs = await prisma.activityLog.findMany({
        where: where as any,
        select: {
          id: true,
          action: true,
          entity: true,
          entityId: true,
          data: true,
          createdAt: true,
          venueId: true,
          staff: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return text({ count: logs.length, logs })
    },
  )
}
```

- [ ] **Step 2: Register it in `server.ts`**

In `src/mcp/server.ts`, add the import with the other tool imports:

```typescript
import { registerActivityLogTools } from './tools/activity-log'
```

Inside `buildServerForIdentity()`, after the other `register*Tools(server, scope)` calls:

```typescript
  registerActivityLogTools(server, scope)
```

- [ ] **Step 3: Write the test**

Create `tests/unit/mcp-customer/activity-log.test.ts`. Mock prisma + a scope with one allowed venue. Register the tool against a fake server that captures the handler, invoke the handler with `{ venueId: 'v1', limit: 10 }`, assert the prisma `where.venueId` is `{ in: ['v1'] }` and the response is `text(...)` shaped. Add a case where `venueId: 'other'` (out of scope) makes `guard.venueFilter` throw.

- [ ] **Step 4: Run the test**

Run: `npm test -- mcp-customer/activity-log`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

```bash
git add src/mcp/tools/activity-log.ts src/mcp/server.ts tests/unit/mcp-customer/activity-log.test.ts
git commit -m "feat(mcp): add get_activity_log read tool (venue-scoped)"
```

---

### Task 12: Phase 1-4 integration gate

- [ ] **Step 1: Full server pre-deploy**

Run: `npm run pre-deploy`
Expected: build + lint + tests PASS. Fix any TS/lint fallout (`npm run format && npm run lint:fix`).

- [ ] **Step 2: Manual smoke (optional but recommended)**

With `npm run dev`, hit `GET /api/v1/dashboard/venues/<proVenueId>/activity-log` with an OWNER token → 200 + rows. Hit it for a FREE venue → 403.

---

## Phase 5 — Dashboard screen

### Task 13: Venue activity-log API service

**Files:**
- Create: `avoqado-web-dashboard/src/services/venueActivity.service.ts`

- [ ] **Step 1: Write the service**

Create `avoqado-web-dashboard/src/services/venueActivity.service.ts`:

```typescript
import api from '@/api'

export interface VenueActivityLogEntry {
  id: string
  action: string
  entity: string | null
  entityId: string | null
  data: Record<string, unknown> | null
  ipAddress: string | null
  createdAt: string
  staff: { id: string; firstName: string; lastName: string } | null
  venueName: string
}

export interface VenueActivityLogFilters {
  page?: number
  pageSize?: number
  staffId?: string
  action?: string
  entity?: string
  search?: string
  startDate?: string
  endDate?: string
}

export interface VenueActivityLogResponse {
  logs: VenueActivityLogEntry[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}

export async function getVenueActivityLog(venueId: string, filters?: VenueActivityLogFilters): Promise<VenueActivityLogResponse> {
  const params = new URLSearchParams()
  if (filters?.page) params.set('page', String(filters.page))
  if (filters?.pageSize) params.set('pageSize', String(filters.pageSize))
  if (filters?.staffId) params.set('staffId', filters.staffId)
  if (filters?.action) params.set('action', filters.action)
  if (filters?.entity) params.set('entity', filters.entity)
  if (filters?.search) params.set('search', filters.search)
  if (filters?.startDate) params.set('startDate', filters.startDate)
  if (filters?.endDate) params.set('endDate', filters.endDate)
  const res = await api.get(`/api/v1/dashboard/venues/${venueId}/activity-log?${params.toString()}`)
  return res.data.data
}

export async function getVenueActivityLogActions(venueId: string): Promise<string[]> {
  const res = await api.get(`/api/v1/dashboard/venues/${venueId}/activity-log/actions`)
  return res.data.data
}
```

- [ ] **Step 2: Build + commit**

Run (from `avoqado-web-dashboard/`): `npm run build` (expected: PASS)

```bash
git add src/services/venueActivity.service.ts
git commit -m "feat(activity-log): venue activity-log API service"
```

---

### Task 14: Venue activity-log page (clone org page + date/staff filters + FeatureGate)

**Files:**
- Create: `avoqado-web-dashboard/src/pages/Venue/VenueActivityLog.tsx`
- Modify: i18n `src/locales/en/*` + `src/locales/es/*` (reuse/extend the `activityLog.*` keys the org page already uses)

- [ ] **Step 1: Clone the org page as the base**

Copy `src/pages/Organization/OrganizationActivityLog.tsx` → `src/pages/Venue/VenueActivityLog.tsx`. Then transform:
- Swap data source: import from `@/services/venueActivity.service` (`getVenueActivityLog`, `getVenueActivityLogActions`, types). Use `useCurrentVenue()` to get `venueId` (replace `useParams orgId`).
- **Remove** the venue filter `<Select>` (single-venue page).
- **Add** a staff filter `<Select>` (populate from the page's logs' distinct staff, or a `useStaff(venueId)` hook if one exists) and a **date-range** filter (two `<Input type="date">` or the project's date-range component) wired to `startDate`/`endDate` in the filters object.
- Use `useVenueDateTime()` for the date column (not raw `format(new Date(...))`).
- Keep the icon/badge config, expandable JSON details, pagination as-is.

- [ ] **Step 2: Wrap the screen body in the PRO upsell gate**

Find the existing upsell component (run `grep -rn "FeatureGate\|getTierForFeature" src/` — CFDI/Reports pages use it). Wrap the page content so non-PRO owners see the PRO upsell instead of an empty table. Pass the feature code `VENUE_AUDIT_LOG`. Example shape (match the real component's API):

```tsx
import { FeatureGate } from '@/components/<actual-path>'
// ...
return (
  <FeatureGate feature="VENUE_AUDIT_LOG">
    {/* existing table + filters JSX */}
  </FeatureGate>
)
```

- [ ] **Step 3: i18n keys**

Ensure every new label (date filter, staff filter, page title/subtitle) has `t()` keys in BOTH `en` and `es`. Reuse the `activityLog.*` namespace the org page already references; add only the new keys (`activityLog.filters.allStaff`, `activityLog.filters.dateRange`, etc.).

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS, no missing-translation-key errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Venue/VenueActivityLog.tsx src/locales/
git commit -m "feat(activity-log): per-venue activity log page (filters + PRO gate)"
```

---

### Task 15: Route + sidebar + plan-catalog + feature-registry

**Files:**
- Modify: `avoqado-web-dashboard/src/routes/venueRoutes.tsx`
- Modify: `avoqado-web-dashboard/src/components/Sidebar/app-sidebar.tsx`
- Modify: `avoqado-web-dashboard/src/config/plan-catalog.ts`
- Modify: `avoqado-web-dashboard/src/config/feature-registry.ts`

- [ ] **Step 1: Add the route (permission-gated; teaser handles the tier)**

In `src/routes/venueRoutes.tsx` `createVenueRoutes()`, add a route under a permission guard (the FeatureGate in-page handles the PRO upsell, so do NOT also wrap in `FeatureProtectedRoute` — that would redirect instead of showing the teaser):

```tsx
{
  element: <PermissionProtectedRoute permission="activity:read" />,
  children: [{ path: 'activity-log', element: <VenueActivityLog /> }],
},
```

Add the lazy/normal import for `VenueActivityLog` alongside the other venue page imports.

- [ ] **Step 2: Add the sidebar item (locked teaser for non-PRO)**

In `src/components/Sidebar/app-sidebar.tsx`, mirror the CFDI pattern:

```tsx
const hasAuditLog = hasFeatureAccess('VENUE_AUDIT_LOG')
// inside the main items build, where owner-level items are pushed:
if (can('activity:read')) {
  mainItems.push({
    title: t('sidebar:auditLog.title'),
    url: 'activity-log',
    icon: ScrollText, // import from lucide-react
    permission: 'activity:read',
    premiumLocked: !hasAuditLog,
    gatedFeature: 'VENUE_AUDIT_LOG',
    keywords: ['bitacora', 'auditoria', 'actividad', 'log'],
  })
}
```

Add `sidebar:auditLog.title` to en + es locales.

- [ ] **Step 3: Map the feature to PRO in the catalog**

In `src/config/plan-catalog.ts`, add `'VENUE_AUDIT_LOG'` to the PRO tier's `includes` array, and add a `featureKey` (e.g. `'auditLog'`) to PRO's `featureKeys`:

```typescript
// PRO tier:
featureKeys: ['allFree', 'reportsHistory', 'aiMcp', 'loyaltyReferrals', 'reservationsOrdering', 'auditLog', 'seatsUnlimited'],
includes: ['ADVANCED_REPORTS', 'AI_ASSISTANT_BUBBLE', 'LOYALTY_PROGRAM', 'REFERRAL_PROGRAM', 'PROMOTIONS', 'RESERVATIONS', 'ONLINE_ORDERING', 'VENUE_AUDIT_LOG'],
```

Add the `plan.features.auditLog` i18n string (billing namespace) in en + es.

- [ ] **Step 4: Register in the feature registry (white-label)**

In `src/config/feature-registry.ts`, add an entry for the activity-log page following the existing entry shape (route key + label + required feature). Match a sibling entry's fields exactly.

- [ ] **Step 5: Build, lint, e2e**

Run: `npm run build && npm run lint && npm run test:e2e`
Expected: PASS. Test in light + dark, as OWNER (PRO venue → table) and OWNER (FREE venue → upsell) and a non-owner (item hidden).

- [ ] **Step 6: Commit**

```bash
git add src/routes/venueRoutes.tsx src/components/Sidebar/app-sidebar.tsx src/config/plan-catalog.ts src/config/feature-registry.ts src/locales/
git commit -m "feat(activity-log): route + sidebar teaser + PRO catalog + registry"
```

---

## Phase 6 — Sales-presentation lockstep

### Task 16: Update the partner deck + one-pager

**Files:**
- Modify: `~/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-presentacion.html`
- Modify: `~/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation/avoqado-one-pager.html`
- Regenerate: both PDFs per that folder's `README.md`

- [ ] **Step 1: Add the capability to PRO**

In both HTML files, add "Bitácora de auditoría por sucursal" (audit log: who did what, when) to the PRO tier's feature list / capabilities section, matching the existing copy style.

- [ ] **Step 2: Regenerate PDFs**

Follow `platform-presentation/README.md` (Chrome-headless HTML→PDF pipeline) to regenerate BOTH PDFs.

- [ ] **Step 3: Commit (HQ repo)**

```bash
# from Avoqado-HQ/
git add operations/marketing/platform-presentation/
git commit -m "docs(sales): PRO now includes per-venue audit log"
```

---

## Self-Review (spec coverage)

| Spec section | Task(s) |
|---|---|
| §4.1 Feature code (PRO) | Task 3 (seed) + Task 6 (gate on route); confirmed NOT premium-only in Task 3 step 3 |
| §4.2 Permission `activity:read` (OWNER) | Task 1 (server) + Task 2 (dashboard mirror) |
| §4.3 Endpoint + guards | Task 6 |
| §4.4 Service `queryVenueActivityLogs` + distinct helpers | Task 4 |
| §4.5 Event capture (orders, payment, refund, shifts, staff) | Tasks 7–10 (refund already done — noted) |
| §4.6 MCP tool | Task 11 |
| §5 Dashboard page/route/catalog/registry/i18n | Tasks 13–15 |
| §6 Sales presentation | Task 16 |
| §7 Tests | Tasks 4,6,7,8,9,10,11 (unit + api) ; Task 15 (e2e) |

**Open verification items the implementer must confirm at execution time (not placeholders — concrete checks):**
- Task 3: `FeatureCategory` enum has `OPERATIONS` (else pick `REPORTING`).
- Task 5: `validateRequest` envelope shape (`{ query: {...} }`) — copy a sibling query-schema.
- Task 6: `validateRequest` import path; `mergeParams: true` propagates `:venueId`.
- Task 7: which `order.tpv.service.ts` create site is the public path (avoid double-logging nested creates).
- Task 14: real `FeatureGate` component path/API + whether a `useStaff(venueId)` hook exists for the staff filter.

## Notes / risks
- **Capture is always-on** (not feature-gated) so upgraded venues have history. Display is gated.
- **No schema change** → no `SCHEMA_MAP.md` edit, no migration.
- **Do not** add `VENUE_AUDIT_LOG` to `PREMIUM_ONLY_CODES` (that would make it Premium, not Pro).
- Permission/feature codes are mirrored by exact string across repos — a typo fails silently.
