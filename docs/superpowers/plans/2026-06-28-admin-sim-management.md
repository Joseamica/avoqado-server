# Admin SIM Management (Reassign Promotor + Change Category) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a PlayTelecom ADMIN bulk-reassign SIMs between promotores and bulk-change SIM category from the dashboard, replacing the
manual prod scripts.

**Architecture:** Two new bulk, idempotent, audited endpoints in the org-scoped sim-custody namespace on `avoqado-server`, reusing the
existing custody framework (`BulkResult`, `processOneRow`, `updateWithVersion`, `writeEvent` dual-write). Two new dashboard dialogs in the
existing Control-de-Stock tabs, reusing the `AssignToSupervisorDialog` bulk pattern. Scoped to PlayTelecom by the `SERIALIZED_INVENTORY`
module gate (never a hardcoded slug).

**Tech Stack:** Express + TypeScript + Prisma (backend, jest); React 18 + Vite + TanStack Query (dashboard, vitest).

## Global Constraints

- Money/units N/A here. Tenant isolation: every query scoped by org (`organizationId`) — verbatim per `.claude/rules/critical-warnings.md`.
- `authContext` is `(req as any).authContext` with `{ userId, orgId, venueId, role }` — NEVER `req.user`.
- Zod messages **Spanish only** (validation middleware shows them to users).
- Never hardcode `venue.slug === 'playtelecom'` — gate by `moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)`.
- Migrations: `npx prisma migrate dev --name ...` — NEVER `db push`.
- Audit: every mutation dual-writes `ActivityLog` (reassign also writes `SerializedItemCustodyEvent`). `logAction` is fire-and-forget,
  OUTSIDE the money/DB tx.
- New permission requires the full mirror: catalog + defaults + dependencies + backend gate + dashboard gate + `npm run audit:permissions`
  exit 0.
- Git policy: do NOT commit without the user's explicit OK. The per-task "Commit" steps are gated on that standing permission — if not
  granted, stage only and pause.
- After editing TS: `npm run format && npm run lint:fix` (server) / `npx eslint --fix` (dashboard).

---

# Phase 1 — Backend (`avoqado-server`)

### Task 1: Prisma enum value + migration

**Files:**

- Modify: `prisma/schema.prisma` (enum `SerializedItemCustodyEventType`)

**Interfaces:**

- Produces: enum value `REASSIGNED_PROMOTER_TO_PROMOTER` usable by `custody.service.ts`.

- [ ] **Step 1: Add the enum value.** In `prisma/schema.prisma`, in `enum SerializedItemCustodyEventType { ... }`, add a line after
      `MARKED_SOLD`:

```prisma
  REASSIGNED_PROMOTER_TO_PROMOTER // Admin moved a held/pending SIM from one promotor to another
```

- [ ] **Step 2: Create the migration.**

Run: `npx prisma migrate dev --name sim_reassign_promoter_event` Expected: migration created under `prisma/migrations/...`, client
regenerated, no errors.

- [ ] **Step 3: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(sim-custody): add REASSIGNED_PROMOTER_TO_PROMOTER custody event type"
```

---

### Task 2: Error codes

**Files:**

- Modify: `src/lib/sim-custody-error-codes.ts`

**Interfaces:**

- Produces: `SimCustodyError` codes `PROMOTER_NOT_FOUND`, `NOT_IN_PROMOTER_STATE`, `CATEGORY_NOT_FOUND` (Spanish messages), consumed by the
  two services.

- [ ] **Step 1: Add the codes.** Follow the existing object shape in that file (code + httpStatus + Spanish message). Add:

```typescript
PROMOTER_NOT_FOUND: { code: 'PROMOTER_NOT_FOUND', httpStatus: 404, message: 'El promotor destino no existe o no pertenece a esta organización.' },
NOT_IN_PROMOTER_STATE: { code: 'NOT_IN_PROMOTER_STATE', httpStatus: 409, message: 'El SIM no está asignado a un promotor (usa asignación a promotor/supervisor).' },
CATEGORY_NOT_FOUND: { code: 'CATEGORY_NOT_FOUND', httpStatus: 404, message: 'La categoría destino no existe en esta organización.' },
```

(Match the exact existing key/field names — read the file's existing entries first. If `CATEGORY_NOT_FOUND` already exists, reuse it.)

- [ ] **Step 2: Typecheck.** Run: `npx tsc -p tsconfig.json --noEmit` → Expected: no new errors.

- [ ] **Step 3: Commit.**

```bash
git add src/lib/sim-custody-error-codes.ts
git commit -m "feat(sim-custody): add error codes for admin reassign + category change"
```

---

### Task 3: Permissions (+ audit)

**Files:**

- Modify: `src/lib/permissions.ts` (`INDIVIDUAL_PERMISSIONS_BY_RESOURCE`, `DEFAULT_PERMISSIONS`, `PERMISSION_DEPENDENCIES`)

**Interfaces:**

- Produces: permissions `sim-custody:reassign`, `serialized-inventory:change-category` satisfiable by ADMIN/OWNER/SUPERADMIN.

- [ ] **Step 1: Add to `PERMISSION_DEPENDENCIES`.**

```typescript
'sim-custody:reassign': ['sim-custody:reassign', 'inventory:read'],
'serialized-inventory:change-category': ['serialized-inventory:change-category', 'inventory:org-manage'],
```

- [ ] **Step 2: Add to `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`.** Under the `sim-custody` resource add `'reassign'`; under
      `serialized-inventory` add `'change-category'` (match the file's existing structure — list of action strings per resource).

- [ ] **Step 3: Add to `DEFAULT_PERMISSIONS`.** Add both strings to the ADMIN and OWNER arrays (SUPERADMIN already has `*:*`). Mirror how
      existing `sim-custody:*` perms are listed for OWNER.

- [ ] **Step 4: Run the audit.**

Run: `npm run audit:permissions` Expected: exit 0 (no PHANTOM/CATALOG_GAP for the two new perms).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/permissions.ts
git commit -m "feat(permissions): add sim-custody:reassign + serialized-inventory:change-category"
```

---

### Task 4: `reassignPromoter` service (TDD)

**Files:**

- Modify: `src/services/serialized-inventory/custody.service.ts`
- Test: `tests/unit/services/serialized-inventory/custody.reassign.service.test.ts`

**Interfaces:**

- Consumes: existing `CustodyActor`, `BulkResult`, `processOneRow`, `updateWithVersion`, `writeEvent`, `findOrgItem` (read their exact
  signatures in the file first).
- Produces: `async reassignPromoter(input: ReassignPromoterInput): Promise<BulkResult>` where
  `ReassignPromoterInput = { actor: CustodyActor; toPromoterStaffId: string; serialNumbers: string[]; idempotencyRequestId?: string | null }`.

- [ ] **Step 1: Write the failing test.** Mirror an existing custody service test for setup/mocks (read one in
      `tests/unit/services/serialized-inventory/` first; register any new `prisma.*` model used in `tests/__helpers__/setup.ts`).

```typescript
// happy path: PROMOTER_HELD item moves to a new promotor, state kept, event written
it('reassigns a PROMOTER_HELD sim to a new promotor and writes audit', async () => {
  // arrange: promoter B valid in org; item serial 'X' is PROMOTER_HELD by promoter A
  const res = await custodyService.reassignPromoter({
    actor,
    toPromoterStaffId: 'promoterB',
    serialNumbers: ['X'],
  })
  expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
  expect(res.results[0]).toMatchObject({ serialNumber: 'X', status: 'ok', event: 'REASSIGNED_PROMOTER_TO_PROMOTER' })
})
// edges
it('errors SIM_SOLD for a sold sim', async () => {
  /* item status SOLD → results[0].code === 'SIM_SOLD' */
})
it('errors NOT_IN_PROMOTER_STATE for an ADMIN_HELD sim', async () => {
  /* code NOT_IN_PROMOTER_STATE */
})
it('errors PROMOTER_NOT_FOUND when target is not an org promotor', async () => {
  /* code PROMOTER_NOT_FOUND */
})
it('is idempotent when already on target promotor', async () => {
  /* status ok, no state change */
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm run test:unit -- custody.reassign` → Expected: FAIL (`reassignPromoter` undefined).

- [ ] **Step 3: Implement `reassignPromoter`.** Add to the service class, reusing the existing helpers. Validate the target promotor once
      (WAITER/CASHIER active in org) before the loop; then `processOneRow` per serial:

```typescript
async reassignPromoter(input: ReassignPromoterInput): Promise<BulkResult> {
  const { actor, toPromoterStaffId, serialNumbers } = input
  // 1. validate target promotor belongs to actor's org as WAITER/CASHIER (else throw SimCustodyError PROMOTER_NOT_FOUND for ALL rows)
  // 2. per serial:
  return this.runBulk(serialNumbers, (serialNumber) =>
    this.processOneRow(serialNumber, async (tx) => {
      const item = await findOrgItem(tx, actor.organizationId, serialNumber) // throws NOT_FOUND
      if (item.status === 'SOLD' || item.custodyState === 'SOLD') throw new SimCustodyError('SIM_SOLD')
      if (item.custodyState !== 'PROMOTER_HELD' && item.custodyState !== 'PROMOTER_PENDING')
        throw new SimCustodyError('NOT_IN_PROMOTER_STATE')
      if (item.assignedPromoterId === toPromoterStaffId) {
        return { item, event: 'REASSIGNED_PROMOTER_TO_PROMOTER' } // idempotent no-op (skip update+event or write a no-op)
      }
      const updated = await updateWithVersion(tx, item, {
        assignedPromoterId: toPromoterStaffId,
        assignedPromoterAt: new Date(),
        ...(item.custodyState === 'PROMOTER_HELD' ? { promoterAcceptedAt: new Date() } : {}),
      })
      const eventId = await this.writeEvent(tx, {
        item, eventType: 'REASSIGNED_PROMOTER_TO_PROMOTER',
        fromState: item.custodyState, toState: item.custodyState,
        fromStaffId: item.assignedPromoterId, toStaffId: toPromoterStaffId, actorStaffId: actor.staffId,
      })
      return { item: updated, event: 'REASSIGNED_PROMOTER_TO_PROMOTER', eventId }
    }))
}
```

(Match the real helper names/signatures found in the file — `runBulk`/`processOneRow`/`updateWithVersion`/`writeEvent` may differ slightly;
adapt. `writeEvent` already dual-writes `ActivityLog` as `SIM_CUSTODY_REASSIGNED_TO_PROMOTER`.)

- [ ] **Step 4: Run to verify it passes.** Run: `npm run test:unit -- custody.reassign` → Expected: PASS (all cases).

- [ ] **Step 5: Format + commit.**

```bash
npm run format && npm run lint:fix
git add src/services/serialized-inventory/custody.service.ts tests/unit/services/serialized-inventory/custody.reassign.service.test.ts tests/__helpers__/setup.ts
git commit -m "feat(sim-custody): admin reassignPromoter (promotor→promotor) service + tests"
```

---

### Task 5: `changeCategory` service (TDD)

**Files:**

- Modify: `src/services/serialized-inventory/serializedInventory.service.ts`
- Test: `tests/unit/services/serialized-inventory/changeCategory.service.test.ts`

**Interfaces:**

- Produces: `async changeCategory(input: ChangeCategoryInput): Promise<BulkResult>` where
  `ChangeCategoryInput = { actor: CustodyActor; serialNumbers: string[]; categoryId: string; idempotencyRequestId?: string | null }`.
- Consumes: `BulkResult`/`processOneRow` helpers (import/share from custody service or replicate the small bulk wrapper), `logAction` from
  the activity-log util.

- [ ] **Step 1: Write the failing test.**

```typescript
it('changes category of a non-sold sim and logs ActivityLog', async () => {
  const res = await serializedInventoryService.changeCategory({
    actor,
    serialNumbers: ['X'],
    categoryId: 'cat-intercambio',
  })
  expect(res.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
  expect(logActionMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'SERIALIZED_ITEM_CATEGORY_CHANGED' }))
})
it('errors SIM_SOLD for a sold sim', async () => {
  /* code SIM_SOLD */
})
it('errors CATEGORY_NOT_FOUND for a category outside the org', async () => {
  /* code CATEGORY_NOT_FOUND */
})
it('is idempotent when already in target category', async () => {
  /* status ok, no update */
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npm run test:unit -- changeCategory` → Expected: FAIL.

- [ ] **Step 3: Implement `changeCategory`.**

```typescript
async changeCategory(input: ChangeCategoryInput): Promise<BulkResult> {
  const { actor, serialNumbers, categoryId } = input
  // validate category exists in org (prisma.itemCategory.findFirst org-scoped) else throw CATEGORY_NOT_FOUND for all
  const cat = await prisma.itemCategory.findFirst({ where: { id: categoryId, OR: [{ organizationId: actor.organizationId }, { venue: { organizationId: actor.organizationId } }] } })
  if (!cat) throw new SimCustodyError('CATEGORY_NOT_FOUND')
  return runBulk(serialNumbers, (serialNumber) => processOneRow(serialNumber, async (tx) => {
    const item = await findOrgItem(tx, actor.organizationId, serialNumber) // NOT_FOUND
    if (item.status === 'SOLD') throw new SimCustodyError('SIM_SOLD')
    if (item.categoryId === categoryId) return { item } // idempotent
    const upd = await tx.serializedItem.updateMany({ where: { id: item.id, categoryId: item.categoryId }, data: { categoryId } })
    if (upd.count !== 1) throw new SimCustodyError('VERSION_CONFLICT')
    void logAction({
      staffId: actor.staffId,
      venueId: item.sellingVenueId ?? item.registeredFromVenueId ?? item.venueId ?? null,
      action: 'SERIALIZED_ITEM_CATEGORY_CHANGED', entity: 'SerializedItem', entityId: item.id,
      data: { serialNumber: item.serialNumber, fromCategoryId: item.categoryId, toCategoryId: categoryId, toCategoryName: cat.name },
    })
    return { item }
  }))
}
```

- [ ] **Step 4: Run to verify it passes.** Run: `npm run test:unit -- changeCategory` → Expected: PASS.

- [ ] **Step 5: Format + commit.**

```bash
npm run format && npm run lint:fix
git add src/services/serialized-inventory/serializedInventory.service.ts tests/unit/services/serialized-inventory/changeCategory.service.test.ts tests/__helpers__/setup.ts
git commit -m "feat(serialized-inventory): admin changeCategory service + tests"
```

---

### Task 6: Routes + controllers + validation

**Files:**

- Modify: `src/routes/dashboard/simCustody.dashboard.routes.ts`
- Modify: `src/controllers/dashboard/simCustody.dashboard.controller.ts`
- Modify/Create: the request Zod schema file used by that controller (follow the existing assign-to-promoter schema)

**Interfaces:**

- Consumes: `custodyService.reassignPromoter`, `serializedInventoryService.changeCategory`.
- Produces: `POST /dashboard/organizations/:orgId/sim-custody/reassign-promoter` and `.../change-category`, returning `BulkResult`.

- [ ] **Step 1: Add Zod schemas (Spanish messages).**

```typescript
export const reassignPromoterSchema = z.object({
  body: z.object({
    toPromoterStaffId: z.string().min(1, 'El promotor destino es requerido'),
    serialNumbers: z.array(z.string().min(1)).min(1, 'Debes incluir al menos un SIM').max(500, 'Máximo 500 SIMs por solicitud'),
  }),
})
export const changeCategorySchema = z.object({
  body: z.object({
    categoryId: z.string().min(1, 'La categoría destino es requerida'),
    serialNumbers: z.array(z.string().min(1)).min(1, 'Debes incluir al menos un SIM').max(500, 'Máximo 500 SIMs por solicitud'),
  }),
})
```

- [ ] **Step 2: Add controller handlers.** Follow the existing `assignToPromoter` controller: read `(req as any).authContext` for
      `{ userId, orgId, role }`, build the `CustodyActor`, call the service, `res.json(result)`. Map a thrown all-rows `SimCustodyError`
      (PROMOTER_NOT_FOUND / CATEGORY_NOT_FOUND) to its httpStatus.

- [ ] **Step 3: Add routes with the full pipeline + module gate.**

```typescript
router.post(
  '/organizations/:orgId/sim-custody/reassign-promoter',
  authenticateToken,
  requireSerializedInventoryModule,
  checkPermission('sim-custody:reassign'),
  idempotencyMiddleware,
  bulkRateLimit,
  validateRequest(reassignPromoterSchema),
  controller.reassignPromoter,
)

router.post(
  '/organizations/:orgId/sim-custody/change-category',
  authenticateToken,
  requireSerializedInventoryModule,
  checkPermission('serialized-inventory:change-category'),
  idempotencyMiddleware,
  bulkRateLimit,
  validateRequest(changeCategorySchema),
  controller.changeCategory,
)
```

If a `requireSerializedInventoryModule` middleware doesn't exist, add a thin one that resolves a venueId for the org and calls
`moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)`, returning `{ moduleRequired: true }` (403) when off. (Reuse
however the existing org sim-custody routes resolve venue/permission context.)

- [ ] **Step 4: Typecheck + curl smoke (dev DB).** Run: `npx tsc -p tsconfig.json --noEmit` (no errors). Optional manual: `npm run dev` then
      curl both endpoints with a dev token against a SERIALIZED_INVENTORY-enabled seed org; expect `BulkResult`.

- [ ] **Step 5: Format + commit.**

```bash
npm run format && npm run lint:fix
git add src/routes/dashboard/simCustody.dashboard.routes.ts src/controllers/dashboard/simCustody.dashboard.controller.ts src/**/schemas/*
git commit -m "feat(sim-custody): reassign-promoter + change-category endpoints (module+perm gated, bulk, idempotent)"
```

---

### Task 7: Backend verification gate

- [ ] **Step 1: Full unit suite.** Run: `npm run test:unit` → Expected: all green (incl. the 2 new files; no regressions).
- [ ] **Step 2: Permissions audit.** Run: `npm run audit:permissions` → Expected: exit 0.
- [ ] **Step 3: Build.** Run: `npm run build` → Expected: success.
- [ ] **Step 4: MCP sync check.** Confirm no MCP change required (decision: reads already exposed by `sim_custody`; admin writes out of
      customer-MCP scope). No action; note in PR.

---

# Phase 2 — Frontend (`avoqado-web-dashboard`)

### Task 8: Dashboard service functions

**Files:**

- Modify: `src/services/simCustody.service.ts`

**Interfaces:**

- Produces: `reassignSimsToPromoter(orgId, body, venueId)` and `changeSimsCategory(orgId, body, venueId)` returning the `BulkResult` shape,
  following the existing `assignSimsToPromoter` (same `x-venue-id` header pattern).

- [ ] **Step 1: Add the two client fns** (mirror `assignSimsToPromoter` exactly — same headers, error handling):

```typescript
export async function reassignSimsToPromoter(
  orgId: string,
  body: { toPromoterStaffId: string; serialNumbers: string[] },
  venueId?: string,
) {
  const res = await api.post(`/api/v1/dashboard/organizations/${orgId}/sim-custody/reassign-promoter`, body, {
    headers: venueId ? { 'x-venue-id': venueId } : {},
  })
  return res.data
}
export async function changeSimsCategory(orgId: string, body: { categoryId: string; serialNumbers: string[] }, venueId?: string) {
  const res = await api.post(`/api/v1/dashboard/organizations/${orgId}/sim-custody/change-category`, body, {
    headers: venueId ? { 'x-venue-id': venueId } : {},
  })
  return res.data
}
```

- [ ] **Step 2: Typecheck.** Run: `npx tsc -b` → Expected: no errors.
- [ ] **Step 3: Commit.**

```bash
git add src/services/simCustody.service.ts
git commit -m "feat(stock): client fns for reassign-promoter + change-category"
```

---

### Task 9: `ReassignPromoterDialog`

**Files:**

- Create: `src/pages/playtelecom/Organization/StockControl/components/ReassignPromoterDialog.tsx`

**Interfaces:**

- Consumes: `useOrgPromoters`, `SearchableSelect`, `SimMultiSelect`, `reassignSimsToPromoter`.
- Produces: `<ReassignPromoterDialog open onOpenChange orgId venueId preselectedSerials? onDone />`.

- [ ] **Step 1: Build the dialog** by copying `AssignToSupervisorDialog.tsx` and adapting: target = a single promotor via `SearchableSelect`
      (options from `useOrgPromoters`); SIM input via `SimMultiSelect` + manual/CSV modes; on submit call
      `reassignSimsToPromoter(orgId, { toPromoterStaffId, serialNumbers }, venueId)`; render the `BulkResult` summary (succeeded/failed with
      per-row reasons); on success `queryClient.invalidateQueries({ queryKey: ['org-stock-control'] })`.

- [ ] **Step 2: Typecheck + manual render.** Run: `npx tsc -b` (no errors). Verify it renders in the tab (Task 11).
- [ ] **Step 3: Commit.**

```bash
git add src/pages/playtelecom/Organization/StockControl/components/ReassignPromoterDialog.tsx
git commit -m "feat(stock): ReassignPromoterDialog (bulk promotor→promotor)"
```

---

### Task 10: `ChangeCategoryDialog`

**Files:**

- Create: `src/pages/playtelecom/Organization/StockControl/components/ChangeCategoryDialog.tsx`

**Interfaces:**

- Consumes: `SearchableSelect` (category options from the org stock/category service), `SimMultiSelect`, `changeSimsCategory`.
- Produces: `<ChangeCategoryDialog open onOpenChange orgId venueId preselectedSerials? onDone />`.

- [ ] **Step 1: Build the dialog** like Task 9 but target = an `ItemCategory` via `SearchableSelect` (options from the existing org category
      list used by `OrgPorCategoriaTab`); submit calls `changeSimsCategory(orgId, { categoryId, serialNumbers }, venueId)`; same
      `BulkResult` summary + invalidation.

- [ ] **Step 2: Typecheck.** Run: `npx tsc -b` → no errors.
- [ ] **Step 3: Commit.**

```bash
git add src/pages/playtelecom/Organization/StockControl/components/ChangeCategoryDialog.tsx
git commit -m "feat(stock): ChangeCategoryDialog (bulk category change)"
```

---

### Task 11: Wire dialogs into tabs + permission gates + verify

**Files:**

- Modify: `src/pages/playtelecom/Organization/StockControl/tabs/OrgDetalleSimsTab.tsx`
- Modify: `src/pages/playtelecom/Organization/StockControl/tabs/OrgPorCategoriaTab.tsx`

- [ ] **Step 1: Add multi-select + action buttons in `OrgDetalleSimsTab`.** Add row selection (if not present), and two buttons over the
      selected serials: **"Reasignar a promotor"** (opens `ReassignPromoterDialog`) gated by
      `can('sim-custody:reassign') || isSuperOrOwner`; **"Cambiar categoría"** (opens `ChangeCategoryDialog`) gated by
      `can('serialized-inventory:change-category') || isSuperOrOwner`. Reuse the role-fallback
      (`currentUserRole = staffInfo?.role ?? user?.role`) used elsewhere in this tab.

- [ ] **Step 2: Add "Cambiar categoría" entry point in `OrgPorCategoriaTab`** (same dialog, same gate).

- [ ] **Step 3: Lint + typecheck.** Run: `npx eslint --fix <changed files>` then `npx tsc -b` → Expected: clean.

- [ ] **Step 4: Manual QA (local dev vs seed org with SERIALIZED_INVENTORY).** Open `/wl/organizations/:orgId/stock-control` → Detalle SIMs:
      select SIMs → reassign to a promotor → confirm `BulkResult` summary + table refresh; change category → confirm. Verify the buttons are
      hidden for a non-ADMIN role.

- [ ] **Step 5: Commit.**

```bash
git add src/pages/playtelecom/Organization/StockControl/tabs/OrgDetalleSimsTab.tsx src/pages/playtelecom/Organization/StockControl/tabs/OrgPorCategoriaTab.tsx
git commit -m "feat(stock): admin reassign + change-category actions in Control de Stock tabs"
```

---

## Self-Review

**Spec coverage:** reassign service (T4) ✓, change-category service (T5) ✓, enum (T1) ✓, error codes (T2) ✓, permissions+audit (T3) ✓,
endpoints+module gate (T6) ✓, dashboard service (T8) ✓, dialogs (T9/T10) ✓, tab wiring + gates (T11) ✓, audit dual-write (T4/T5) ✓, testing
gate (T7) ✓, MCP decision (T7.4) ✓, no-hardcoded-slug via module gate (T6) ✓. Boundary (promotor→promotor only) enforced in T4
(`NOT_IN_PROMOTER_STATE`).

**Placeholder scan:** code shown per step; helper names flagged as "match the real signature in the file" because exact internal names
(`runBulk`/`processOneRow`/`writeEvent`) must be read from `custody.service.ts` at implementation time — not invented.

**Type consistency:** `BulkResult`, `CustodyActor`, `ReassignPromoterInput`, `ChangeCategoryInput`, the two service method names, the two
endpoint paths, and the two client fns are consistent across tasks.

## Execution Handoff

(See chat for execution-mode choice.)
