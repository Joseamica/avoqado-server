# PlayTelecom MCP Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give PlayTelecom (serialized-inventory / white-label) full read coverage through the Avoqado customer MCP so operators answer
inventory, sale-verification, roster, commission-balance and location questions in a single call — and hide every PT tool from non-PT
connections.

**Architecture:** Add thin, org-aware backing functions in `avoqado-server` services, expose them as 7 new read MCP tools, split the
serialized tools into their own registration module, and register all PT tool groups **conditionally** based on the connection's enabled
modules. Every existing call-time module/permission gate stays (defense in depth).

**Tech Stack:** TypeScript, Node, Express, Prisma/PostgreSQL, `@modelcontextprotocol/sdk`, Jest 29 (`npm run test:unit`).

## Global Constraints

- **Repo:** single repo `avoqado-server`. Paths below are relative to its root.
- **Reads only.** No sale-verification writes (approve/reject/reopen/edit). No new mutations.
- **No new tier.** All new capabilities inherit the existing `SERIALIZED_INVENTORY` module (PREMIUM today) / `WHITE_LABEL_DASHBOARD` gate.
  Do not add tier logic.
- **Never hardcode a PlayTelecom slug/org/name.** Everything stays module/permission-driven.
- **Money** = Mexican pesos, major units (e.g. `150.50`), never cents. **Dates** venue-local (`America/Mexico_City`).
- **Isolation invariant:** every tool keeps `guard.venueFilter` / org-permission gate + module gate. Conditional registration is additive,
  never a replacement.
- **Serialized SIM pool is ORG-LEVEL:** `SerializedItem.venueId` is nullable (`null` = org item). New SIM reads MUST include `venueId=null`
  items (scope by `OR:[{venueId in allowed},{organizationId}]`), never a bare `venueId` equality.
- **Promoter = `StaffVenue.role ∈ {CASHIER, WAITER}`** (matches `organizationDashboard.service.ts:572`). **Supervisor = venue `MANAGER`
  (fallback `ADMIN`)** (matches `getSalesBySupervisor`).
- **Git is READ-ONLY in this workflow.** Do NOT run `git commit`/`checkout`/`switch`/`worktree`. Each task ends by running its tests green
  and leaving changes in the working tree; a human (Jose) commits later. The "Checkpoint" step is where a commit would go.
- **Test command:** `npm run test:unit -- <path>` (Jest). Mirror the mock style of `tests/unit/mcp-customer/serialized-gating.test.ts` for
  tool tests.

---

## File structure

**Backend services (add functions, no rewrites):**

- `src/services/modules/module.service.ts` → `anyVenueHasModule`, `venuesWithModule`
- `src/services/serialized-inventory/serializedInventory.service.ts` → `getOrgStockByCategory`, `listOrgItems`
- `src/services/dashboard/sale-verification.org.dashboard.service.ts` → `resolveSupervisorByVenue` (extracted), `getSalesByPromoterWeekly`,
  `getOrgStructure`
- `src/services/dashboard/cash-out/cash-out.org.service.ts` → `getSaldosForOrg`
- `src/services/promoters/promoterLocation.service.ts` → `getLatestPromoterLocationsForVenue`

**MCP tools:**

- `src/mcp/tools/serialized.ts` → NEW file `registerSerializedTools`: the 4 moved serialized tools + `serialized_stock_by_category` +
  `list_serialized_items`
- `src/mcp/tools/inventory.ts` → remove the 4 serialized tools (keep generic inventory tools)
- `src/mcp/tools/saleVerifications.ts` → `promoterWeekly` groupBy + `list_sale_verifications` + `org_structure`
- `src/mcp/tools/cash-out.ts` → `cash_out_org_saldos`
- `src/mcp/tools/promoterLocation.ts` → `promoters_live_locations`
- `src/mcp/server.ts` → `registerAllTools(server, scope, flags)` + conditional registration

**Tests:** `tests/unit/mcp-customer/` (tools + registration) and `tests/unit/services/` (pure service fns; create dir if absent — mirror an
existing service test's location).

---

### Task 1: Bulk module helpers (`anyVenueHasModule`, `venuesWithModule`)

**Files:**

- Modify: `src/services/modules/module.service.ts` (add two methods to `ModuleService`)
- Test: `tests/unit/services/module-bulk.test.ts` (create)

**Interfaces:**

- Produces:
  - `moduleService.venuesWithModule(venueIds: string[], code: ModuleCode): Promise<Set<string>>`
  - `moduleService.anyVenueHasModule(venueIds: string[], code: ModuleCode): Promise<boolean>`
- Semantics MUST equal `isModuleEnabled` per venue: an existing `VenueModule` row is the source of truth (its `enabled`, even `false`,
  overrides org); only when NO `VenueModule` row exists does the org-level `OrganizationModule` decide.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/module-bulk.test.ts
const mockVenueModuleFindMany = jest.fn()
const mockVenueFindMany = jest.fn()
const mockOrgModuleFindMany = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueModule: { findMany: (...a: unknown[]) => mockVenueModuleFindMany(...(a as [])) },
    venue: { findMany: (...a: unknown[]) => mockVenueFindMany(...(a as [])) },
    organizationModule: { findMany: (...a: unknown[]) => mockOrgModuleFindMany(...(a as [])) },
  },
}))

import { moduleService } from '../../../src/services/modules/module.service'

beforeEach(() => jest.clearAllMocks())

describe('venuesWithModule — replicates isModuleEnabled precedence', () => {
  it('venue-level override OFF beats org-level ON (venue excluded)', async () => {
    // v1: explicit VenueModule enabled=false → OFF despite org ON. v2: no row → inherits org ON.
    mockVenueModuleFindMany.mockResolvedValue([{ venueId: 'v1', enabled: false }])
    mockVenueFindMany.mockResolvedValue([
      { id: 'v1', organizationId: 'o1' },
      { id: 'v2', organizationId: 'o1' },
    ])
    mockOrgModuleFindMany.mockResolvedValue([{ organizationId: 'o1' }]) // org o1 has it ON

    const set = await moduleService.venuesWithModule(['v1', 'v2'], 'SERIALIZED_INVENTORY')
    expect(set.has('v1')).toBe(false)
    expect(set.has('v2')).toBe(true)
    expect(await moduleService.anyVenueHasModule(['v1'], 'SERIALIZED_INVENTORY')).toBe(false)
    expect(await moduleService.anyVenueHasModule(['v1', 'v2'], 'SERIALIZED_INVENTORY')).toBe(true)
  })

  it('venue-level ON row wins even if org has no OrganizationModule', async () => {
    mockVenueModuleFindMany.mockResolvedValue([{ venueId: 'v1', enabled: true }])
    mockVenueFindMany.mockResolvedValue([{ id: 'v1', organizationId: 'o1' }])
    mockOrgModuleFindMany.mockResolvedValue([]) // org OFF
    const set = await moduleService.venuesWithModule(['v1'], 'SERIALIZED_INVENTORY')
    expect(set.has('v1')).toBe(true)
  })

  it('empty input → empty set / false, no queries', async () => {
    expect((await moduleService.venuesWithModule([], 'SERIALIZED_INVENTORY')).size).toBe(0)
    expect(await moduleService.anyVenueHasModule([], 'SERIALIZED_INVENTORY')).toBe(false)
    expect(mockVenueModuleFindMany).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/services/module-bulk.test.ts` Expected: FAIL — `moduleService.venuesWithModule is not a function`.

- [ ] **Step 3: Implement the methods**

Add inside `class ModuleService` in `src/services/modules/module.service.ts` (uses `this.db`, the same Prisma client `isModuleEnabled`
uses):

```ts
/**
 * Bulk version of isModuleEnabled for a set of venues. Replicates its precedence EXACTLY:
 * an existing VenueModule row is authoritative (its `enabled`, even false, overrides the org);
 * only venues with NO VenueModule row fall back to the org-level OrganizationModule.
 */
async venuesWithModule(venueIds: string[], moduleCode: ModuleCode): Promise<Set<string>> {
  const enabled = new Set<string>()
  if (venueIds.length === 0) return enabled

  const venueModules = await this.db.venueModule.findMany({
    where: { venueId: { in: venueIds }, module: { code: moduleCode, active: true } },
    select: { venueId: true, enabled: true },
  })
  const explicit = new Map<string, boolean>() // venueId → its explicit enabled (override)
  for (const vm of venueModules) explicit.set(vm.venueId, vm.enabled)
  for (const [venueId, isOn] of explicit) if (isOn) enabled.add(venueId)

  // Venues WITHOUT an explicit row inherit from their org.
  const inheritIds = venueIds.filter(id => !explicit.has(id))
  if (inheritIds.length === 0) return enabled

  const venues = await this.db.venue.findMany({
    where: { id: { in: inheritIds } },
    select: { id: true, organizationId: true },
  })
  const orgIds = [...new Set(venues.map(v => v.organizationId).filter((o): o is string => !!o))]
  if (orgIds.length === 0) return enabled
  const orgModules = await this.db.organizationModule.findMany({
    where: { organizationId: { in: orgIds }, enabled: true, module: { code: moduleCode, active: true } },
    select: { organizationId: true },
  })
  const orgOn = new Set(orgModules.map(o => o.organizationId))
  for (const v of venues) if (v.organizationId && orgOn.has(v.organizationId)) enabled.add(v.id)
  return enabled
}

/** True if ANY of venueIds has the module effectively enabled (same precedence as venuesWithModule). */
async anyVenueHasModule(venueIds: string[], moduleCode: ModuleCode): Promise<boolean> {
  return (await this.venuesWithModule(venueIds, moduleCode)).size > 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/services/module-bulk.test.ts` Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint** — tests green; leave in working tree (no commit — git read-only).

---

### Task 2: Org-aware serialized reads (`getOrgStockByCategory`, `listOrgItems`)

**Files:**

- Modify: `src/services/serialized-inventory/serializedInventory.service.ts` (add two methods to `SerializedInventoryService`)
- Test: `tests/unit/services/serialized-org-reads.test.ts` (create)

**Interfaces:**

- Produces:
  - `serializedInventoryService.getOrgStockByCategory(orgId, allowedVenueIds): Promise<Array<{ category: ItemCategory; available: number; sold: number }>>`
  - `serializedInventoryService.listOrgItems(opts): Promise<{ items: (SerializedItem & { category: ItemCategory })[]; total: number }>`
    where
    `opts = { orgId: string; allowedVenueIds: string[]; categoryId?: string; status?: SerializedItemStatus; custodyState?: SerializedItemCustodyState; assignedPromoterId?: string; skip?: number; take?: number }`
- Both scope items with `OR: [{ venueId: { in: allowedVenueIds } }, { organizationId: orgId }]` so the org-level pool (`venueId=null`) is
  INCLUDED.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/serialized-org-reads.test.ts
const mockItemFindMany = jest.fn()
const mockItemCount = jest.fn()
const mockItemGroupBy = jest.fn()
const mockCategoryFindMany = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    serializedItem: {
      findMany: (...a: unknown[]) => mockItemFindMany(...(a as [])),
      count: (...a: unknown[]) => mockItemCount(...(a as [])),
      groupBy: (...a: unknown[]) => mockItemGroupBy(...(a as [])),
    },
    itemCategory: { findMany: (...a: unknown[]) => mockCategoryFindMany(...(a as [])) },
  },
}))

import { serializedInventoryService } from '../../../src/services/serialized-inventory/serializedInventory.service'

beforeEach(() => jest.clearAllMocks())

describe('listOrgItems — includes org-level pool (venueId=null)', () => {
  it('scopes by OR[venueId in allowed, organizationId] so venueId=null items are returned', async () => {
    mockItemFindMany.mockResolvedValue([
      { id: 'i1', serialNumber: 'ICC1', venueId: null, status: 'AVAILABLE', category: { name: 'SIM de Evento' } },
    ])
    mockItemCount.mockResolvedValue(1)
    const res = await serializedInventoryService.listOrgItems({ orgId: 'o1', allowedVenueIds: ['v1'], status: 'AVAILABLE', take: 50 })
    expect(res.total).toBe(1)
    expect(res.items[0].venueId).toBeNull()
    const whereArg = (mockItemFindMany.mock.calls[0][0] as any).where
    expect(whereArg.OR).toEqual([{ venueId: { in: ['v1'] } }, { organizationId: 'o1' }])
    expect(whereArg.status).toBe('AVAILABLE')
  })
})

describe('getOrgStockByCategory — org pool per category', () => {
  it('returns available/sold per org category', async () => {
    mockCategoryFindMany.mockResolvedValue([{ id: 'c1', name: 'SIM de Evento' }])
    mockItemGroupBy.mockResolvedValue([
      { categoryId: 'c1', status: 'AVAILABLE', _count: 4 },
      { categoryId: 'c1', status: 'SOLD', _count: 1 },
    ])
    const res = await serializedInventoryService.getOrgStockByCategory('o1', ['v1'])
    expect(res).toEqual([{ category: { id: 'c1', name: 'SIM de Evento' }, available: 4, sold: 1 }])
    const gbWhere = (mockItemGroupBy.mock.calls[0][0] as any).where
    expect(gbWhere.OR).toEqual([{ venueId: { in: ['v1'] } }, { organizationId: 'o1' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/services/serialized-org-reads.test.ts` Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement the methods**

Add to `class SerializedInventoryService` (mirror the existing `getStockByCategory`/`listItems` but org-scoped). Reuse the class's `this.db`
and imported `Prisma`, `ItemCategory`, `SerializedItem`, `SerializedItemStatus`, `SerializedItemCustodyState` types (import the two enums
from `@prisma/client` at the top if not already present):

```ts
private orgPoolWhere(orgId: string, allowedVenueIds: string[]): Prisma.SerializedItemWhereInput {
  // Org-level SIMs have venueId=null; venue-scoped SIMs carry a venueId. Include BOTH.
  return { OR: [{ venueId: { in: allowedVenueIds } }, { organizationId: orgId }] }
}

async listOrgItems(opts: {
  orgId: string
  allowedVenueIds: string[]
  categoryId?: string
  status?: SerializedItemStatus
  custodyState?: SerializedItemCustodyState
  assignedPromoterId?: string
  skip?: number
  take?: number
}): Promise<{ items: (SerializedItem & { category: ItemCategory })[]; total: number }> {
  const where: Prisma.SerializedItemWhereInput = {
    ...this.orgPoolWhere(opts.orgId, opts.allowedVenueIds),
    ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.custodyState ? { custodyState: opts.custodyState } : {}),
    ...(opts.assignedPromoterId ? { assignedPromoterId: opts.assignedPromoterId } : {}),
  }
  const [items, total] = await Promise.all([
    this.db.serializedItem.findMany({
      where,
      include: { category: true },
      orderBy: { createdAt: 'desc' },
      skip: opts.skip,
      take: opts.take ?? 50,
    }),
    this.db.serializedItem.count({ where }),
  ])
  return { items, total }
}

async getOrgStockByCategory(
  orgId: string,
  allowedVenueIds: string[],
): Promise<Array<{ category: ItemCategory; available: number; sold: number }>> {
  const categories = await this.db.itemCategory.findMany({
    where: { active: true, OR: [{ organizationId: orgId }, { venue: { organizationId: orgId } }] },
    orderBy: { sortOrder: 'asc' },
  })
  // Dedup by name, venue-scoped category overrides org-level.
  const seen = new Map<string, (typeof categories)[number]>()
  for (const cat of categories) {
    const key = cat.name.toLowerCase()
    const existing = seen.get(key)
    if (!existing || cat.venueId) seen.set(key, cat)
  }
  const merged = Array.from(seen.values())
  const categoryIds = merged.map(c => c.id)
  if (categoryIds.length === 0) return []
  const counts = await this.db.serializedItem.groupBy({
    by: ['categoryId', 'status'],
    where: { ...this.orgPoolWhere(orgId, allowedVenueIds), categoryId: { in: categoryIds }, status: { in: ['AVAILABLE', 'SOLD'] } },
    _count: true,
  })
  const stats = new Map<string, { available: number; sold: number }>()
  for (const row of counts) {
    const s = stats.get(row.categoryId) || { available: 0, sold: 0 }
    if (row.status === 'AVAILABLE') s.available = row._count as unknown as number
    if (row.status === 'SOLD') s.sold = row._count as unknown as number
    stats.set(row.categoryId, s)
  }
  return merged.map(category => ({ category, ...(stats.get(category.id) || { available: 0, sold: 0 }) }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/services/serialized-org-reads.test.ts` Expected: PASS (2 tests).

- [ ] **Step 5: Checkpoint** — tests green; leave in working tree.

---

### Task 3: Split serialized tools into `serialized.ts` + add the two SIM read tools

**Files:**

- Create: `src/mcp/tools/serialized.ts` (`registerSerializedTools`)
- Modify: `src/mcp/tools/inventory.ts` (delete the 4 serialized tools + now-unused imports)
- Modify: `src/mcp/server.ts` (import `registerSerializedTools`; call it where `registerInventoryTools` was — temporary unconditional call,
  made conditional in Task 9)
- Test: `tests/unit/mcp-customer/serialized-tools.test.ts` (create) + keep `serialized-gating.test.ts` working by re-pointing its import

**Interfaces:**

- Consumes: `moduleService.isModuleEnabled` (unchanged gates); `serializedInventoryService.getOrgStockByCategory`, `listOrgItems` (Task 2).
- Produces: `registerSerializedTools(server, scope)` registering `serialized_inventory`, `sim_custody`, `mark_serialized_item`,
  `change_sim_category` (moved verbatim), plus `serialized_stock_by_category`, `list_serialized_items`.

- [ ] **Step 1: Create `serialized.ts` and move the 4 tools verbatim**

Create `src/mcp/tools/serialized.ts`. Move — unchanged — the four `server.tool(...)` blocks `serialized_inventory`, `mark_serialized_item`,
`sim_custody`, `change_sim_category` out of `inventory.ts` into a new
`export function registerSerializedTools(server: McpServer, scope: McpScope) { const guard = createGuard(scope); … }`. Copy the imports
those tools use from `inventory.ts` (`z`, `prisma`, `createGuard`, `text`, `serializedInventoryService`, `simCustodyService`,
`auditMcpWrite`, `ROLE_HIERARCHY`, `StaffRole`, `moduleService`, `MODULE_CODES`, `CUSTODY_STATE_ES`, `SERIALIZED_OFF_MSG`). Also move the
`CUSTODY_STATE_ES` const and `SERIALIZED_OFF_MSG` const into `serialized.ts` (they are only used by these tools). Delete those four blocks
and now-unused imports/consts from `inventory.ts`.

- [ ] **Step 2: Add the two new tools inside `registerSerializedTools`**

Append these two `server.tool` blocks (guard + module gate mirror the existing serialized tools):

```ts
server.tool(
  'serialized_stock_by_category',
  'Serialized inventory (SIMs) broken down BY CATEGORY/TYPE across your organization: for each type (e.g. "SIM de Intercambio", "SIM de Evento", "$100 de Promotor", "e-SIM"), how many are AVAILABLE vs SOLD. Counts the ORG-LEVEL pool (PlayTelecom registers SIMs at org level, not per store). Answers "¿cuántas SIM de cada tipo tengo disponibles / vendidas?". Only for venues with the SERIALIZED_INVENTORY module. Pass venueId (any venue in the org — used for the module gate and to resolve the org).',
  { venueId: z.string().describe('A venue in the org (must be in your scope) — for the module gate + org resolution') },
  async ({ venueId }) => {
    guard.venueFilter(venueId) // throws if out of scope
    guard.requirePermission('inventory:read', venueId)
    if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
      return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
    }
    const access = scope.perVenueAccess.get(venueId)
    const orgId = access?.organizationId
    if (!orgId) return text({ ok: false, error: 'No pude resolver la organización de este venue.' })
    const rows = await serializedInventoryService.getOrgStockByCategory(orgId, scope.allowedVenueIds)
    return text({
      orgId,
      categories: rows.map(r => ({ category: r.category.name, available: r.available, sold: r.sold })),
      totalAvailable: rows.reduce((a, r) => a + r.available, 0),
      totalSold: rows.reduce((a, r) => a + r.sold, 0),
    })
  },
)

server.tool(
  'list_serialized_items',
  'List INDIVIDUAL serialized items (SIMs / ICCIDs) in your organization, including the ORG-LEVEL pool (venueId=null). Filter by status (AVAILABLE / SOLD / RETURNED / DAMAGED), by category name, by custody state, or by the promoter currently holding them (assignedPromoterId). Paginated (returns `total`). Answers "lista los SIMs disponibles", "¿qué SIMs trae el promotor X?". Only for venues with the SERIALIZED_INVENTORY module. Pass venueId (any venue in the org — for the module gate + org resolution).',
  {
    venueId: z.string().describe('A venue in the org (must be in your scope) — for the module gate + org resolution'),
    status: z.enum(['AVAILABLE', 'SOLD', 'RETURNED', 'DAMAGED']).optional().describe('Filter by item status'),
    categoryName: z.string().optional().describe('Filter by category/type name (case-insensitive, resolved to an org category)'),
    custodyState: z
      .enum(['ADMIN_HELD', 'SUPERVISOR_HELD', 'PROMOTER_PENDING', 'PROMOTER_HELD', 'PROMOTER_REJECTED', 'SOLD'])
      .optional()
      .describe('Filter by custody state'),
    assignedPromoterId: z.string().optional().describe('Only items currently held by this promoter (staffId)'),
    limit: z.number().int().positive().max(200).optional().describe('Max items (default 50)'),
    offset: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
  },
  async ({ venueId, status, categoryName, custodyState, assignedPromoterId, limit, offset }) => {
    guard.venueFilter(venueId)
    guard.requirePermission('inventory:read', venueId)
    if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
      return text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG })
    }
    const orgId = scope.perVenueAccess.get(venueId)?.organizationId
    if (!orgId) return text({ ok: false, error: 'No pude resolver la organización de este venue.' })
    let categoryId: string | undefined
    if (categoryName) {
      const cats = await prisma.itemCategory.findMany({
        where: { OR: [{ organizationId: orgId }, { venue: { organizationId: orgId } }] },
        select: { id: true, name: true },
      })
      const match = cats.find(c => c.name.trim().toLowerCase() === categoryName.trim().toLowerCase())
      if (!match)
        return text({ ok: false, error: `No encontré la categoría "${categoryName}".`, availableCategories: cats.map(c => c.name) })
      categoryId = match.id
    }
    const { items, total } = await serializedInventoryService.listOrgItems({
      orgId,
      allowedVenueIds: scope.allowedVenueIds,
      categoryId,
      status: status as never,
      custodyState: custodyState as never,
      assignedPromoterId,
      skip: offset ?? 0,
      take: limit ?? 50,
    })
    return text({
      orgId,
      total,
      count: items.length,
      items: items.map(i => ({
        serialNumber: i.serialNumber,
        status: i.status,
        custodyState: i.custodyState,
        category: i.category?.name ?? null,
        venueId: i.venueId, // null = org-level pool
      })),
    })
  },
)
```

- [ ] **Step 3: Update `server.ts` import + call (temporary, unconditional)**

In `src/mcp/server.ts` add `import { registerSerializedTools } from './tools/serialized'` and, right after
`registerInventoryTools(server, scope)`, add `registerSerializedTools(server, scope)`. (Task 9 makes it conditional.)

- [ ] **Step 4: Re-point the existing gating test import**

The existing `tests/unit/mcp-customer/serialized-gating.test.ts` imports `registerInventoryTools` and calls `serialized_inventory` /
`mark_serialized_item`. Change its import to `registerSerializedTools` from `../../../src/mcp/tools/serialized` and its `beforeAll` to
register that. The rest of the file is unchanged.

- [ ] **Step 5: Write the new-tools test**

```ts
// tests/unit/mcp-customer/serialized-tools.test.ts
import { registerSerializedTools } from '../../../src/mcp/tools/serialized'
import type { McpScope } from '../../../src/mcp/scope'

const mockIsEnabled = jest.fn()
const mockGetOrgStock = jest.fn()
const mockListOrgItems = jest.fn()

jest.mock('@/services/modules/module.service', () => ({
  moduleService: { isModuleEnabled: (...a: unknown[]) => mockIsEnabled(...(a as [])) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  serializedInventoryService: {
    getOrgStockByCategory: (...a: unknown[]) => mockGetOrgStock(...(a as [])),
    listOrgItems: (...a: unknown[]) => mockListOrgItems(...(a as [])),
  },
}))
jest.mock('@/services/serialized-inventory/custody.service', () => ({ simCustodyService: {} }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { itemCategory: { findMany: jest.fn() } } }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: () => ({ venueId: { in: ['v1'] } }), requirePermission: jest.fn() }),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { organizationId: 'o1' }]]),
} as unknown as McpScope
const call = (n: string, a: Record<string, unknown>) => handlers.get(n)!(a, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() =>
  registerSerializedTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => jest.clearAllMocks())

describe('serialized_stock_by_category', () => {
  it('module OFF → moduleRequired, no service call', async () => {
    mockIsEnabled.mockResolvedValue(false)
    const out = parse(await call('serialized_stock_by_category', { venueId: 'v1' }))
    expect(out.moduleRequired).toBe(true)
    expect(mockGetOrgStock).not.toHaveBeenCalled()
  })
  it('module ON → totals per category', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockGetOrgStock.mockResolvedValue([{ category: { name: 'SIM de Evento' }, available: 4, sold: 1 }])
    const out = parse(await call('serialized_stock_by_category', { venueId: 'v1' }))
    expect(out).toMatchObject({ orgId: 'o1', totalAvailable: 4, totalSold: 1 })
    expect(mockGetOrgStock).toHaveBeenCalledWith('o1', ['v1'])
  })
})

describe('list_serialized_items', () => {
  it('module ON → passes org pool + filters', async () => {
    mockIsEnabled.mockResolvedValue(true)
    mockListOrgItems.mockResolvedValue({
      items: [
        { serialNumber: 'ICC1', status: 'AVAILABLE', custodyState: 'ADMIN_HELD', category: { name: 'SIM de Evento' }, venueId: null },
      ],
      total: 1,
    })
    const out = parse(await call('list_serialized_items', { venueId: 'v1', status: 'AVAILABLE' }))
    expect(out.total).toBe(1)
    expect(mockListOrgItems).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'o1', allowedVenueIds: ['v1'], status: 'AVAILABLE' }))
  })
})
```

- [ ] **Step 6: Run tests**

Run: `npm run test:unit -- tests/unit/mcp-customer/serialized-tools.test.ts tests/unit/mcp-customer/serialized-gating.test.ts` Expected:
PASS (both files).

- [ ] **Step 7: Type-check the touched files**

Run: `npx tsc -p tsconfig.json --noEmit` (or the repo's build) — expect no errors in `inventory.ts` / `serialized.ts` / `server.ts`.

- [ ] **Step 8: Checkpoint** — tests + typecheck green; leave in working tree.

---

### Task 4: `promoterWeekly` — weekly per-promoter sales with store + supervisor

**Files:**

- Modify: `src/services/dashboard/sale-verification.org.dashboard.service.ts` (extract `resolveSupervisorByVenue`, add
  `getSalesByPromoterWeekly`)
- Modify: `src/mcp/tools/saleVerifications.ts` (import + add `promoterWeekly` to the `groupBy` enum and switch)
- Test: `tests/unit/services/sales-promoter-weekly.test.ts` (create)

**Interfaces:**

- Consumes: existing `baseAggregationWhere`, `toWeekLabel`.
- Produces:

  - `resolveSupervisorByVenue(venueIds: string[]): Promise<Map<string, { id: string; name: string }>>`
  - `getSalesByPromoterWeekly(orgId, range): Promise<Array<{ staffId: string; promoterName: string; venueId: string; venueName: string; supervisorId: string | null; supervisorName: string; byWeek: Record<string, number>; total: number }>>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/sales-promoter-weekly.test.ts
const mockSVFindMany = jest.fn()
const mockStaffVenueFindMany = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    saleVerification: { findMany: (...a: unknown[]) => mockSVFindMany(...(a as [])) },
    staffVenue: { findMany: (...a: unknown[]) => mockStaffVenueFindMany(...(a as [])) },
  },
}))
jest.mock('@/services/dashboard/sale-verification.dashboard.service', () => ({ reviewSaleVerification: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: {}, MODULE_CODES: {} }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { emit: jest.fn() } }))
jest.mock('@/communication/sockets/types', () => ({ SocketEventType: {} }))

import { getSalesByPromoterWeekly } from '../../../src/services/dashboard/sale-verification.org.dashboard.service'

beforeEach(() => jest.clearAllMocks())

it('buckets a promoter by ISO week and attributes venue + supervisor', async () => {
  // Two COMPLETED sales same promoter same store, weeks W18 and W19.
  mockSVFindMany.mockResolvedValue([
    {
      createdAt: new Date('2026-05-01T18:00:00Z'),
      venueId: 'v1',
      venue: { id: 'v1', name: 'BAE Uno' },
      staff: { id: 'p1', firstName: 'Ana', lastName: 'León' },
    },
    {
      createdAt: new Date('2026-05-08T18:00:00Z'),
      venueId: 'v1',
      venue: { id: 'v1', name: 'BAE Uno' },
      staff: { id: 'p1', firstName: 'Ana', lastName: 'León' },
    },
  ])
  // Supervisor lookup: v1 → MANAGER Hugo.
  mockStaffVenueFindMany.mockResolvedValue([{ venueId: 'v1', role: 'MANAGER', staff: { id: 'sup1', firstName: 'Hugo', lastName: 'G' } }])
  const rows = await getSalesByPromoterWeekly('o1', { from: new Date('2026-04-01'), to: new Date('2026-06-01') } as never)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    staffId: 'p1',
    venueId: 'v1',
    venueName: 'BAE Uno',
    supervisorId: 'sup1',
    supervisorName: 'Hugo G',
    total: 2,
  })
  expect(Object.values(rows[0].byWeek).reduce((a, b) => a + b, 0)).toBe(2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/services/sales-promoter-weekly.test.ts` Expected: FAIL — `getSalesByPromoterWeekly` not exported.

- [ ] **Step 3: Extract `resolveSupervisorByVenue` + implement `getSalesByPromoterWeekly`**

In `sale-verification.org.dashboard.service.ts`, extract the supervisor-lookup block currently inside `getSalesBySupervisor` (the
`venueManagers` findMany + `supervisorByVenue` map build) into an exported helper, and have `getSalesBySupervisor` call it (no behavior
change):

```ts
/** One MANAGER (ADMIN fallback) per venue, deterministic by staffId asc. Shared by supervisor aggregations. */
export async function resolveSupervisorByVenue(venueIds: string[]): Promise<Map<string, { id: string; name: string }>> {
  const supervisorByVenue = new Map<string, { id: string; name: string }>()
  if (venueIds.length === 0) return supervisorByVenue
  const venueManagers = await prisma.staffVenue.findMany({
    where: { venueId: { in: venueIds }, role: { in: ['ADMIN', 'MANAGER'] }, active: true },
    orderBy: { staffId: 'asc' },
    include: { staff: { select: { id: true, firstName: true, lastName: true } } },
  })
  for (const role of ['MANAGER', 'ADMIN'] as const) {
    for (const sv of venueManagers) {
      if (sv.role !== role) continue
      if (!supervisorByVenue.has(sv.venueId)) {
        supervisorByVenue.set(sv.venueId, { id: sv.staff.id, name: `${sv.staff.firstName} ${sv.staff.lastName}`.trim() })
      }
    }
  }
  return supervisorByVenue
}

/**
 * Confirmed (COMPLETED) sales per promoter × ISO week, attributed to the store and its
 * supervisor. One row per (promoter, store). Weeks with zero sales are absent keys (the
 * caller treats a missing week as 0). Solves the "análisis por supervisor / semana" query
 * with no cross-referencing.
 */
export async function getSalesByPromoterWeekly(
  orgId: string,
  range: AggregationRange,
): Promise<
  Array<{
    staffId: string
    promoterName: string
    venueId: string
    venueName: string
    supervisorId: string | null
    supervisorName: string
    byWeek: Record<string, number>
    total: number
  }>
> {
  const verifications = await prisma.saleVerification.findMany({
    where: baseAggregationWhere(orgId, range),
    select: {
      createdAt: true,
      venueId: true,
      venue: { select: { id: true, name: true } },
      staff: { select: { id: true, firstName: true, lastName: true } },
    },
  })
  const venueIds = Array.from(new Set(verifications.map(v => v.venueId).filter((x): x is string => !!x)))
  const supervisorByVenue = await resolveSupervisorByVenue(venueIds)

  // key = `${staffId}|${venueId}` → one row per promoter per store.
  const map = new Map<
    string,
    { staffId: string; promoterName: string; venueId: string; venueName: string; byWeek: Record<string, number> }
  >()
  for (const v of verifications) {
    if (!v.staff || !v.venueId) continue
    const key = `${v.staff.id}|${v.venueId}`
    const week = toWeekLabel(v.createdAt)
    const row = map.get(key) ?? {
      staffId: v.staff.id,
      promoterName: `${v.staff.firstName} ${v.staff.lastName}`.trim(),
      venueId: v.venueId,
      venueName: v.venue?.name ?? 'Sin tienda',
      byWeek: {},
    }
    row.byWeek[week] = (row.byWeek[week] ?? 0) + 1
    map.set(key, row)
  }
  return Array.from(map.values())
    .map(r => {
      const sup = supervisorByVenue.get(r.venueId)
      const total = Object.values(r.byWeek).reduce((a, b) => a + b, 0)
      return { ...r, supervisorId: sup?.id ?? null, supervisorName: sup?.name ?? 'Sin supervisor', total }
    })
    .sort((a, b) => b.total - a.total)
}
```

- [ ] **Step 4: Wire the `promoterWeekly` groupBy into the tool**

In `src/mcp/tools/saleVerifications.ts`: import `getSalesByPromoterWeekly`; add `'promoterWeekly'` to the `groupBy` `z.enum([...])`; add a
`case 'promoterWeekly': return text({ promoters: await getSalesByPromoterWeekly(orgId, range) })` to the switch; and extend the tool
description with:
`"promoterWeekly" (por promotor × semana, ya atribuido a su tienda y supervisor — úsalo para análisis por supervisor sin cruzar datos)`.

- [ ] **Step 5: Run tests**

Run: `npm run test:unit -- tests/unit/services/sales-promoter-weekly.test.ts` Expected: PASS. Also re-run existing org sales tests if
present: `npm run test:unit -- tests/unit/services` (no regressions in `getSalesBySupervisor`).

- [ ] **Step 6: Checkpoint** — green; leave in working tree.

---

### Task 5: `org_structure` roster tool

**Files:**

- Modify: `src/services/dashboard/sale-verification.org.dashboard.service.ts` (add `getOrgStructure`)
- Modify: `src/mcp/tools/saleVerifications.ts` (add `org_structure` tool)
- Test: `tests/unit/services/org-structure.test.ts` (create)

**Interfaces:**

- Consumes: `resolveSupervisorByVenue` (Task 4).
- Produces:
  `getOrgStructure(orgId): Promise<{ supervisors: Array<{ supervisorId: string; supervisorName: string; stores: Store[] }>; unassignedStores: Store[] }>`
  where `Store = { venueId: string; venueName: string; promoters: Array<{ staffId: string; name: string }> }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/org-structure.test.ts
const mockVenueFindMany = jest.fn()
const mockStaffVenueFindMany = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findMany: (...a: unknown[]) => mockVenueFindMany(...(a as [])) },
    staffVenue: { findMany: (...a: unknown[]) => mockStaffVenueFindMany(...(a as [])) },
  },
}))
jest.mock('@/services/dashboard/sale-verification.dashboard.service', () => ({ reviewSaleVerification: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: {}, MODULE_CODES: {} }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { emit: jest.fn() } }))
jest.mock('@/communication/sockets/types', () => ({ SocketEventType: {} }))

import { getOrgStructure } from '../../../src/services/dashboard/sale-verification.org.dashboard.service'

beforeEach(() => jest.clearAllMocks())

it('groups promoters (CASHIER/WAITER) under the venue MANAGER; lists unassigned stores', async () => {
  mockVenueFindMany.mockResolvedValue([
    { id: 'v1', name: 'BAE Uno' },
    { id: 'v2', name: 'BAE Vacante' }, // no manager
  ])
  // resolveSupervisorByVenue query (role in ADMIN/MANAGER)
  mockStaffVenueFindMany.mockImplementation((args: any) => {
    const roles = args.where.role.in
    if (roles.includes('MANAGER'))
      return Promise.resolve([{ venueId: 'v1', role: 'MANAGER', staff: { id: 'sup1', firstName: 'Hugo', lastName: 'G' } }])
    // promoters query (role in CASHIER/WAITER)
    return Promise.resolve([{ venueId: 'v1', staff: { id: 'p1', firstName: 'Ana', lastName: 'León' } }])
  })
  const res = await getOrgStructure('o1')
  expect(res.supervisors).toHaveLength(1)
  expect(res.supervisors[0]).toMatchObject({ supervisorId: 'sup1', supervisorName: 'Hugo G' })
  expect(res.supervisors[0].stores[0]).toMatchObject({ venueId: 'v1', promoters: [{ staffId: 'p1', name: 'Ana León' }] })
  expect(res.unassignedStores.map(s => s.venueId)).toEqual(['v2'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/services/org-structure.test.ts` Expected: FAIL — `getOrgStructure` not exported.

- [ ] **Step 3: Implement `getOrgStructure`**

```ts
export interface OrgStructureStore {
  venueId: string
  venueName: string
  promoters: Array<{ staffId: string; name: string }>
}
export interface OrgStructure {
  supervisors: Array<{ supervisorId: string; supervisorName: string; stores: OrgStructureStore[] }>
  unassignedStores: OrgStructureStore[]
}

/**
 * Org roster: supervisor (venue MANAGER, ADMIN fallback) → their stores → promoters
 * (StaffVenue role CASHIER/WAITER — the same definition organizationDashboard uses).
 * Includes stores with zero sales (roster ≠ sales). Venues with no MANAGER/ADMIN land in
 * `unassignedStores`.
 */
export async function getOrgStructure(orgId: string): Promise<OrgStructure> {
  const venues = await prisma.venue.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } })
  const venueIds = venues.map(v => v.id)
  const supervisorByVenue = await resolveSupervisorByVenue(venueIds)
  const promoterRows =
    venueIds.length === 0
      ? []
      : await prisma.staffVenue.findMany({
          where: { venueId: { in: venueIds }, active: true, role: { in: ['CASHIER', 'WAITER'] } },
          select: { venueId: true, staff: { select: { id: true, firstName: true, lastName: true } } },
        })
  const promotersByVenue = new Map<string, Array<{ staffId: string; name: string }>>()
  for (const r of promoterRows) {
    const list = promotersByVenue.get(r.venueId) ?? []
    list.push({ staffId: r.staff.id, name: `${r.staff.firstName} ${r.staff.lastName}`.trim() })
    promotersByVenue.set(r.venueId, list)
  }
  const storeOf = (v: { id: string; name: string }): OrgStructureStore => ({
    venueId: v.id,
    venueName: v.name,
    promoters: promotersByVenue.get(v.id) ?? [],
  })

  const bySupervisor = new Map<string, { supervisorName: string; stores: OrgStructureStore[] }>()
  const unassignedStores: OrgStructureStore[] = []
  for (const v of venues) {
    const sup = supervisorByVenue.get(v.id)
    if (!sup) {
      unassignedStores.push(storeOf(v))
      continue
    }
    const entry = bySupervisor.get(sup.id) ?? { supervisorName: sup.name, stores: [] }
    entry.stores.push(storeOf(v))
    bySupervisor.set(sup.id, entry)
  }
  return {
    supervisors: Array.from(bySupervisor.entries()).map(([supervisorId, e]) => ({
      supervisorId,
      supervisorName: e.supervisorName,
      stores: e.stores,
    })),
    unassignedStores,
  }
}
```

- [ ] **Step 4: Add the `org_structure` tool**

In `src/mcp/tools/saleVerifications.ts` import `getOrgStructure` and register (reuse the module's existing `requireReviewAccess()` gate):

```ts
server.tool(
  'org_structure',
  'The organization roster: each supervisor (the store MANAGER) → their stores → the promoters (CASHIER/WAITER staff) working there. Includes stores with ZERO sales and stores with no assigned supervisor (unassignedStores). Answers "¿qué tiendas y promotores tiene cada supervisor? ¿qué promotores hay en la tienda X?". Serialized-inventory / PlayTelecom org back-office. No arguments — uses your active organization.',
  {},
  async () => {
    requireReviewAccess()
    return text(await getOrgStructure(scope.activeOrg))
  },
)
```

- [ ] **Step 5: Run test**

Run: `npm run test:unit -- tests/unit/services/org-structure.test.ts` Expected: PASS.

- [ ] **Step 6: Checkpoint** — green; leave in working tree.

---

### Task 6: `list_sale_verifications` tool (per-sale detail + rejection reason)

**Files:**

- Modify: `src/mcp/tools/saleVerifications.ts` (add tool; import `listOrgSaleVerifications`)
- Test: `tests/unit/mcp-customer/list-sale-verifications.test.ts` (create)

**Interfaces:**

- Consumes: existing `listOrgSaleVerifications(orgId, filters)` and its `OrgSaleListFilters` / `OrgSaleListResponse`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/mcp-customer/list-sale-verifications.test.ts
import { registerSaleVerificationTools } from '../../../src/mcp/tools/saleVerifications'
import type { McpScope } from '../../../src/mcp/scope'

const mockList = jest.fn()
jest.mock('@/services/dashboard/sale-verification.org.dashboard.service', () => ({
  __esModule: true,
  listOrgSaleVerifications: (...a: unknown[]) => mockList(...(a as [])),
  getOrgSalesSummary: jest.fn(),
  getSalesByMonth: jest.fn(),
  getSalesByCity: jest.fn(),
  getSalesByStore: jest.fn(),
  getSalesBySupervisor: jest.fn(),
  getSalesByPromoter: jest.fn(),
  getSalesByPromoterDaily: jest.fn(),
  getSalesBySaleTypeWeekly: jest.fn(),
  getSalesBySimTypeWeekly: jest.fn(),
  getSalesByPromoterWeekly: jest.fn(),
  getOrgStructure: jest.fn(),
  parseRange: (a?: string, b?: string) => ({ from: a, to: b }),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: () => true }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = {
  staffId: 's1',
  activeOrg: 'o1',
  allowedVenueIds: ['v1'],
  perVenueAccess: new Map([['v1', { organizationId: 'o1' }]]),
} as unknown as McpScope
const call = (n: string, a: Record<string, unknown>) => handlers.get(n)!(a, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() =>
  registerSaleVerificationTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope),
)
beforeEach(() => jest.clearAllMocks())

it('passes filters and returns the rows', async () => {
  mockList.mockResolvedValue({ rows: [{ id: 'sv1', status: 'FAILED' }], totalCount: 1, pageNumber: 1, pageSize: 20 })
  const out = parse(await call('list_sale_verifications', { status: 'FAILED', pageSize: 20, pageNumber: 1 }))
  expect(out.totalCount).toBe(1)
  expect(mockList).toHaveBeenCalledWith('o1', expect.objectContaining({ status: 'FAILED', pageSize: 20, pageNumber: 1 }))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/mcp-customer/list-sale-verifications.test.ts` Expected: FAIL — handler `list_sale_verifications`
undefined.

- [ ] **Step 3: Add the tool**

In `src/mcp/tools/saleVerifications.ts` import `listOrgSaleVerifications` and add:

```ts
server.tool(
  'list_sale_verifications',
  'List INDIVIDUAL sale verifications (the back-office approval queue) for your organization — the per-sale detail behind the confirmed-sales counters. Each row is one sale with its status (PENDING/COMPLETED/FAILED/REJECTED), the promoter, the store, the SIM(s), and — when not approved — WHY. Filter by status (e.g. FAILED = las que el promotor debe corregir; REJECTED = rechazadas), by promoter (staffId), by portabilidad, by category, or free `search` (ICCID / promoter name). Answers "muéstrame las ventas en revisión / rechazadas y por qué", "¿qué tiene pendiente de corregir el promotor X?". Paginated. Serialized-inventory / PlayTelecom back-office.',
  {
    status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'REJECTED']).optional().describe('Filter by verification status'),
    staffId: z.string().optional().describe('Only sales by this promoter (staffId)'),
    isPortabilidad: z.boolean().optional().describe('true = only portabilidades; false = only líneas nuevas'),
    search: z.string().optional().describe('Free text: ICCID or promoter name'),
    pageSize: z.number().int().positive().max(100).optional().describe('Rows per page (default 20)'),
    pageNumber: z.number().int().positive().optional().describe('1-based page (default 1)'),
  },
  async ({ status, staffId, isPortabilidad, search, pageSize, pageNumber }) => {
    requireReviewAccess()
    const res = await listOrgSaleVerifications(scope.activeOrg, {
      status: status as never,
      staffId,
      isPortabilidad,
      search,
      pageSize: pageSize ?? 20,
      pageNumber: pageNumber ?? 1,
    })
    return text(res)
  },
)
```

- [ ] **Step 4: Run test**

Run: `npm run test:unit -- tests/unit/mcp-customer/list-sale-verifications.test.ts` Expected: PASS.

- [ ] **Step 5: Checkpoint** — green; leave in working tree.

---

### Task 7: `getSaldosForOrg` + `cash_out_org_saldos` tool

**Files:**

- Modify: `src/services/dashboard/cash-out/cash-out.org.service.ts` (add `getSaldosForOrg`)
- Modify: `src/mcp/tools/cash-out.ts` (add `cash_out_org_saldos`)
- Test: `tests/unit/services/cash-out-org-saldos.test.ts` (create)

**Interfaces:**

- Consumes: `listVenueIdsForOrg` (same file), `materializeEntries`, `reconcileClawbacks` (`cash-out.ledger.service`),
  `prisma.promoterCommissionEntry.groupBy`, `prisma.staff.findMany`.
- Produces: `getSaldosForOrg(orgId): Promise<Array<{ venueId: string; staffId: string; promoterName: string; saldo: string }>>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/cash-out-org-saldos.test.ts
const mockMaterialize = jest.fn()
const mockReconcile = jest.fn()
const mockGroupBy = jest.fn()
const mockStaffFindMany = jest.fn()

jest.mock('@/services/dashboard/cash-out/cash-out.ledger.service', () => ({
  materializeEntries: (...a: unknown[]) => mockMaterialize(...(a as [])),
  reconcileClawbacks: (...a: unknown[]) => mockReconcile(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    promoterCommissionEntry: { groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])) },
    staff: { findMany: (...a: unknown[]) => mockStaffFindMany(...(a as [])) },
    venue: { findMany: jest.fn().mockResolvedValue([{ id: 'v1' }]) },
  },
}))

import { getSaldosForOrg } from '../../../src/services/dashboard/cash-out/cash-out.org.service'

beforeEach(() => jest.clearAllMocks())

it('materializes + reconciles per venue, then sums AVAILABLE by staff', async () => {
  mockMaterialize.mockResolvedValue({ created: 0 })
  mockReconcile.mockResolvedValue({ clawedBack: 0 })
  mockGroupBy.mockResolvedValue([{ venueId: 'v1', staffId: 'p1', _sum: { amount: '120.50' } }])
  mockStaffFindMany.mockResolvedValue([{ id: 'p1', firstName: 'Ana', lastName: 'León' }])
  const res = await getSaldosForOrg('o1')
  expect(mockMaterialize).toHaveBeenCalledWith('v1')
  expect(mockReconcile).toHaveBeenCalledWith('v1')
  expect(res).toEqual([{ venueId: 'v1', staffId: 'p1', promoterName: 'Ana León', saldo: '120.5' }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/services/cash-out-org-saldos.test.ts` Expected: FAIL — `getSaldosForOrg` not exported.

- [ ] **Step 3: Implement `getSaldosForOrg`**

In `cash-out.org.service.ts` (imports: `listVenueIdsForOrg` is local; add
`import { materializeEntries, reconcileClawbacks } from './cash-out.ledger.service'`, `import prisma from '../../../utils/prismaClient'`,
`import { Prisma } from '@prisma/client'`):

```ts
/**
 * Org-wide available Cash Out balance per promoter. Reproduces the real fresh-read path
 * (getSaldo only SUMS AVAILABLE entries; freshness + business exclusions — ADMIN active days,
 * MANUAL_ENTRY exclusion — live inside materializeEntries). So per venue: materialize then
 * reconcile clawbacks (both idempotent, module-gated no-ops when off), then group AVAILABLE by
 * staff. Perf note: runs materialize across all org venues on read; idempotent (skips existing).
 */
export async function getSaldosForOrg(
  orgId: string,
): Promise<Array<{ venueId: string; staffId: string; promoterName: string; saldo: string }>> {
  const venueIds = await listVenueIdsForOrg(orgId)
  if (venueIds.length === 0) return []
  for (const venueId of venueIds) {
    await materializeEntries(venueId)
    await reconcileClawbacks(venueId)
  }
  const grouped = await prisma.promoterCommissionEntry.groupBy({
    by: ['venueId', 'staffId'],
    where: { venueId: { in: venueIds }, status: 'AVAILABLE' },
    _sum: { amount: true },
  })
  const staffIds = [...new Set(grouped.map(g => g.staffId))]
  const staff = staffIds.length
    ? await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })
    : []
  const nameOf = new Map(staff.map(s => [s.id, `${s.firstName} ${s.lastName}`.trim()]))
  return grouped
    .map(g => ({
      venueId: g.venueId,
      staffId: g.staffId,
      promoterName: nameOf.get(g.staffId) ?? g.staffId,
      saldo: new Prisma.Decimal(g._sum.amount ?? 0).toString(), // pesos
    }))
    .sort((a, b) => Number(b.saldo) - Number(a.saldo))
}
```

- [ ] **Step 4: Add the `cash_out_org_saldos` tool**

In `src/mcp/tools/cash-out.ts` import `getSaldosForOrg` and add (reuse `requireOrgReadAccess()`):

```ts
server.tool(
  'cash_out_org_saldos',
  'Saldo de Cash Out DISPONIBLE por promotor, agregado en TODA tu organización activa (PESOS). Cada fila: venue, promotor y su saldo retirable. Ordenado de mayor a menor. Responde "¿cuánto le debo de comisión a todos los promotores? ¿quién trae más saldo?". Refresca el saldo antes de leer (respeta días activos y excluye ventas MANUAL_ENTRY). No requiere venueId — usa la organización activa de esta conexión.',
  {},
  async () => {
    try {
      const orgId = requireOrgReadAccess()
      const saldos = await getSaldosForOrg(orgId)
      return text({
        ok: true,
        orgId,
        count: saldos.length,
        totalSaldo: saldos.reduce((a, s) => a + Number(s.saldo), 0).toFixed(2),
        saldos,
      })
    } catch (err) {
      return text({ ok: false, error: (err as Error).message })
    }
  },
)
```

- [ ] **Step 5: Run test**

Run: `npm run test:unit -- tests/unit/services/cash-out-org-saldos.test.ts` Expected: PASS.

- [ ] **Step 6: Checkpoint** — green; leave in working tree.

---

### Task 8: `getLatestPromoterLocationsForVenue` + `promoters_live_locations` tool

**Files:**

- Modify: `src/services/promoters/promoterLocation.service.ts` (add function)
- Modify: `src/mcp/tools/promoterLocation.ts` (add tool)
- Test: `tests/unit/services/promoter-latest-locations.test.ts` (create)

**Interfaces:**

- Produces:
  `getLatestPromoterLocationsForVenue(venueId, date?): Promise<Array<{ promoterId: string; name: string; latest: PromoterTrackPoint | null }>>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/promoter-latest-locations.test.ts
const mockVenueFindUnique = jest.fn()
const mockPingFindMany = jest.fn()
const mockStaffFindMany = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) },
    promoterLocationPing: { findMany: (...a: unknown[]) => mockPingFindMany(...(a as [])) },
    staff: { findMany: (...a: unknown[]) => mockStaffFindMany(...(a as [])) },
  },
}))
import { getLatestPromoterLocationsForVenue } from '../../../src/services/promoters/promoterLocation.service'
beforeEach(() => jest.clearAllMocks())

it('returns the latest ping per promoter', async () => {
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  // Two pings for p1 (keep the later), one for p2. Ordered desc by capturedAt in the query.
  mockPingFindMany.mockResolvedValue([
    { staffId: 'p1', latitude: 1, longitude: 2, accuracy: 5, capturedAt: new Date('2026-05-01T18:00:00Z'), source: 'PERIODIC' },
    { staffId: 'p1', latitude: 1, longitude: 2, accuracy: 5, capturedAt: new Date('2026-05-01T17:00:00Z'), source: 'PERIODIC' },
    { staffId: 'p2', latitude: 3, longitude: 4, accuracy: 5, capturedAt: new Date('2026-05-01T16:00:00Z'), source: 'PERIODIC' },
  ])
  mockStaffFindMany.mockResolvedValue([
    { id: 'p1', firstName: 'Ana', lastName: 'León' },
    { id: 'p2', firstName: 'Beto', lastName: 'Ruiz' },
  ])
  const res = await getLatestPromoterLocationsForVenue('v1', '2026-05-01')
  expect(res).toHaveLength(2)
  const p1 = res.find(r => r.promoterId === 'p1')!
  expect(p1.name).toBe('Ana León')
  expect(p1.latest?.capturedAt).toEqual(new Date('2026-05-01T18:00:00Z'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/services/promoter-latest-locations.test.ts` Expected: FAIL — function not exported.

- [ ] **Step 3: Implement the function**

Add to `src/services/promoters/promoterLocation.service.ts` (reuse the file's existing `toPoint`, `venueStartOfDay`, `venueEndOfDay`,
`DEFAULT_TIMEZONE`, `formatInTimeZone`, `prisma`):

```ts
/** Latest ping per promoter for a venue on a venue-local day (default: today). */
export async function getLatestPromoterLocationsForVenue(
  venueId: string,
  date?: string,
): Promise<Array<{ promoterId: string; name: string; latest: PromoterTrackPoint | null }>> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue?.timezone ?? DEFAULT_TIMEZONE
  const day = date ?? formatInTimeZone(new Date(), tz, 'yyyy-MM-dd')
  const anchor = new Date(`${day}T12:00:00`)
  const rows = await prisma.promoterLocationPing.findMany({
    where: { venueId, capturedAt: { gte: venueStartOfDay(tz, anchor), lte: venueEndOfDay(tz, anchor) } },
    orderBy: { capturedAt: 'desc' },
  })
  const latestByStaff = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!latestByStaff.has(r.staffId)) latestByStaff.set(r.staffId, r) // first seen = latest (desc order)
  const staffIds = [...latestByStaff.keys()]
  const staff = staffIds.length
    ? await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, firstName: true, lastName: true } })
    : []
  const nameOf = new Map(staff.map(s => [s.id, `${s.firstName} ${s.lastName}`.trim()]))
  return staffIds.map(id => ({ promoterId: id, name: nameOf.get(id) ?? id, latest: toPoint(latestByStaff.get(id)!) }))
}
```

- [ ] **Step 4: Add the `promoters_live_locations` tool**

In `src/mcp/tools/promoterLocation.ts` import `getLatestPromoterLocationsForVenue` and add (same gates as `promoter_location`: WL module +
`teams:read`):

```ts
server.tool(
  'promoters_live_locations',
  'Latest known location of ALL field promoters reporting to a venue, for one venue-local day. Each promoter: name + their most recent ping (lat/lng, when, source) or null if none today. White-label venues only. Answers "¿dónde andan todos mis promotores ahora?". Pass venueId; date optional (YYYY-MM-DD, defaults to venue-local today).',
  {
    venueId: z.string().describe('Venue the promoters report to (must be in your scope)'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Venue-local day (YYYY-MM-DD); omit for today'),
  },
  async ({ venueId, date }) => {
    guard.venueFilter(venueId)
    guard.requirePermission('teams:read', venueId)
    if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.WHITE_LABEL_DASHBOARD))) {
      return text({ ok: false, moduleRequired: true, error: WHITE_LABEL_OFF_MSG })
    }
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
    const tz = venue?.timezone ?? DEFAULT_TIMEZONE
    const list = await getLatestPromoterLocationsForVenue(venueId, date)
    const fmt = (d: Date) => formatInTimeZone(d, tz, 'yyyy-MM-dd HH:mm')
    return text({
      ok: true,
      venueId,
      date: date ?? formatInTimeZone(new Date(), tz, 'yyyy-MM-dd'),
      count: list.length,
      promoters: list.map(p => ({
        promoterId: p.promoterId,
        name: p.name,
        latest: p.latest
          ? {
              lat: p.latest.lat,
              lng: p.latest.lng,
              accuracy: p.latest.accuracy,
              capturedAt: fmt(p.latest.capturedAt),
              source: p.latest.source,
            }
          : null,
      })),
    })
  },
)
```

- [ ] **Step 5: Run test**

Run: `npm run test:unit -- tests/unit/services/promoter-latest-locations.test.ts` Expected: PASS.

- [ ] **Step 6: Checkpoint** — green; leave in working tree.

---

### Task 9: Conditional registration in `server.ts`

**Files:**

- Modify: `src/mcp/server.ts` (extract `registerAllTools`, compute flags, register PT groups conditionally)
- Test: `tests/unit/mcp-customer/conditional-registration.test.ts` (create)

**Interfaces:**

- Consumes: `moduleService.anyVenueHasModule` (Task 1); all `register*Tools`.
- Produces: `registerAllTools(server, scope, flags: { serializedEnabled: boolean; whiteLabelEnabled: boolean })`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/mcp-customer/conditional-registration.test.ts
// Importing server.ts pulls the whole tool+service graph. Mock the only import-time-heavy
// dependencies so the import can't fail on missing DATABASE_URL/env. registerAllTools only
// stores handlers (server.tool) — no query runs — so these stubs are sufficient. If a newly
// added tool module introduces another import-time side effect, mock it here too.
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: new Proxy({}, { get: () => () => undefined }) }))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import { registerAllTools } from '../../../src/mcp/server'
import type { McpScope } from '../../../src/mcp/scope'

// Capture every registered tool name via a fake McpServer.
function collect(scope: McpScope, flags: { serializedEnabled: boolean; whiteLabelEnabled: boolean }): Set<string> {
  const names = new Set<string>()
  const fake = { tool: (...a: unknown[]) => names.add(a[0] as string) } as never
  registerAllTools(fake, scope, flags)
  return names
}
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as unknown as McpScope

it('PT connection (serialized ON) sees serialized + sale-verification + cash-out tools', () => {
  const names = collect(scope, { serializedEnabled: true, whiteLabelEnabled: true })
  expect(names.has('serialized_inventory')).toBe(true)
  expect(names.has('list_serialized_items')).toBe(true)
  expect(names.has('org_confirmed_sales_report')).toBe(true)
  expect(names.has('cash_out_org_saldos')).toBe(true)
  expect(names.has('promoters_live_locations')).toBe(true)
  expect(names.has('low_stock')).toBe(true) // generic tool always present
})

it('scalable connection (all modules OFF) sees NO SIM/PT tools, only generic', () => {
  const names = collect(scope, { serializedEnabled: false, whiteLabelEnabled: false })
  expect(names.has('serialized_inventory')).toBe(false)
  expect(names.has('list_serialized_items')).toBe(false)
  expect(names.has('org_confirmed_sales_report')).toBe(false)
  expect(names.has('list_sale_verifications')).toBe(false)
  expect(names.has('cash_out_org_saldos')).toBe(false)
  expect(names.has('record_serialized_sale')).toBe(false)
  expect(names.has('promoters_live_locations')).toBe(false)
  expect(names.has('low_stock')).toBe(true) // generic tools stay
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/mcp-customer/conditional-registration.test.ts` Expected: FAIL — `registerAllTools` not exported.

- [ ] **Step 3: Refactor `buildServerForIdentity` to use `registerAllTools`**

In `src/mcp/server.ts`, export a new `registerAllTools` that takes the flags and moves the register-calls into it. Generic groups always
register; PT groups gate on flags. Then `buildServerForIdentity` computes the flags and calls it:

```ts
export function registerAllTools(
  server: McpServer,
  scope: McpScope,
  flags: { serializedEnabled: boolean; whiteLabelEnabled: boolean },
): void {
  // Always-on (generic product) groups:
  registerVenueTools(server, scope)
  registerSalesTools(server, scope)
  registerOrderTools(server, scope)
  registerTerminalTools(server, scope)
  registerReservationTools(server, scope)
  registerInventoryTools(server, scope) // generic inventory only (serialized moved out)
  registerProcurementTools(server, scope)
  registerCfdiTools(server, scope)
  registerCommissionTools(server, scope)
  registerSubscriptionTools(server, scope)
  registerMenuTools(server, scope)
  registerStaffTools(server, scope)
  registerReviewTools(server, scope)
  registerCustomerTools(server, scope)
  registerCustomerGroupTools(server, scope)
  registerCreditPackTools(server, scope)
  registerShiftTools(server, scope)
  registerDiscountTools(server, scope)
  registerPaymentTools(server, scope)
  registerOverviewTools(server, scope)
  registerTableTools(server, scope)
  registerFeatureTools(server, scope)
  registerProductTools(server, scope)
  registerTrendTools(server, scope)
  registerOrganizationTools(server, scope)
  registerPaymentLinkTools(server, scope)
  registerSeatTools(server, scope)
  registerLoyaltyTools(server, scope)
  registerReferralTools(server, scope)
  registerPlanAdminTools(server, scope)
  registerAccountingTools(server, scope)
  registerActivityLogTools(server, scope)

  // Serialized-inventory (PlayTelecom / white-label serialized) groups — only when the
  // connection actually has the module, so non-PT users never see SIM tools in the catalog.
  if (flags.serializedEnabled) {
    registerSerializedTools(server, scope)
    registerSaleVerificationTools(server, scope)
    registerManualSaleTools(server, scope)
    registerCashOutTools(server, scope)
  }
  // Promoter tracking lives in the white-label dashboard module.
  if (flags.whiteLabelEnabled) {
    registerPromoterLocationTools(server, scope)
  }
}
```

And in `buildServerForIdentity`, replace the block of `register*` calls with:

```ts
const [serializedEnabled, whiteLabelEnabled] = await Promise.all([
  moduleService.anyVenueHasModule(scope.allowedVenueIds, MODULE_CODES.SERIALIZED_INVENTORY),
  moduleService.anyVenueHasModule(scope.allowedVenueIds, MODULE_CODES.WHITE_LABEL_DASHBOARD),
])
registerAllTools(server, scope, { serializedEnabled, whiteLabelEnabled })
```

Add imports at the top of `server.ts`: `import { moduleService, MODULE_CODES } from './services/modules/module.service'` (adjust to the
repo's alias, e.g. `@/services/modules/module.service`). Remove the now-duplicated inline `register*` calls.

- [ ] **Step 4: Run the registration test**

Run: `npm run test:unit -- tests/unit/mcp-customer/conditional-registration.test.ts` Expected: PASS (2 tests).

- [ ] **Step 5: Full MCP unit sweep + typecheck**

Run: `npm run test:unit -- tests/unit/mcp-customer` then `npx tsc -p tsconfig.json --noEmit`. Expected: all green, no type errors.

- [ ] **Step 6: Checkpoint** — green; leave in working tree.

---

### Task 10: Closeout — full-testing + doc sync

**Files:**

- Modify (docs): the MCP tool inventory doc if one exists (`grep -ril "org_confirmed_sales_report" docs` → update the tool list); otherwise
  none.

- [ ] **Step 1: Run the whole unit suite**

Run: `npm run test:unit` Expected: green (no regressions in existing MCP / service tests).

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc -p tsconfig.json --noEmit` and the repo lint (`npm run lint` if present). Expected: clean.

- [ ] **Step 3: `/full-testing`**

Invoke the `/full-testing` skill against this change (happy-path + destructive: a PT-scoped connection sees + can call the new tools; a
non-PT connection does not see them; validate against Postgres; tail the backend log). Git stays read-only.

- [ ] **Step 4: Note MCP connector restart**

After deploy, the MCP connector must be restarted to advertise the new tools + `promoterWeekly` groupBy. Record this in the PR/handoff
notes.

- [ ] **Step 5: Final checkpoint** — everything green; summarize for Jose; await explicit commit permission.

---

## Self-review notes

- **Spec coverage:** #1 `serialized_stock_by_category` (T2/T3), #2 `list_serialized_items` (T2/T3), #3 `list_sale_verifications` (T6), #7
  `promoterWeekly` (T4), #6 `org_structure` (T5), #4 `cash_out_org_saldos` (T7), #5 `promoters_live_locations` (T8), conditional
  registration (T9), bulk module helper (T1). All 4 audit findings: org-level SIM pool (T2 test), saldo freshness (T7 reuses
  materialize+reconcile), module override (T1 test), promoter=CASHIER/WAITER (T5). All covered.
- **No writes** introduced. **No tier logic** added. **No hardcoded PT slug.**
- **Type consistency:** `resolveSupervisorByVenue` used identically in T4 & T5; `getOrgStockByCategory(orgId, allowedVenueIds)` and
  `listOrgItems({orgId, allowedVenueIds, …})` signatures match between T2 (def) and T3 (call); `anyVenueHasModule` signature matches between
  T1 (def) and T9 (call).
