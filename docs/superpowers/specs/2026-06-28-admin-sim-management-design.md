# Admin SIM Management — Reassign Promotor + Change Category

**Date:** 2026-06-28 **Status:** Design approved, pending implementation plan **Source:** Asana 1216095149541817 (Bait <> Play Telecom) —
"Agregar funcionalidad para reasignar SIMs de promotor o cambiar de tipo de SIM" **Repos:** `avoqado-server` (backend, core) +
`avoqado-web-dashboard` (UI)

## Problem

PlayTelecom demand swings during events/weekends, leaving some promotores out of sellable SIMs. Today, two corrective operations are done
**manually by an engineer running prod scripts** (done repeatedly 2026-06-26/28):

1. **Reassign SIMs from one promotor to another** (e.g. 91 SIMs → Isela/Elizabeth; 20 → Tirza).
2. **Change a SIM's category/type** (e.g. 147 SIMs "$100 de promotor" → "SIM de intercambio").

Isaac wants an **ADMIN** to do both **remotely from the dashboard**, ending the manual scripts.

## Goals

- ADMIN can bulk-**reassign** SIMs from their current promotor to a chosen promotor.
- ADMIN can bulk-**change the category** of SIMs (any non-SOLD SIM → another org category).
- Both audited, idempotent, partial-success, optimistic-locked — same guarantees the manual scripts had.

## Non-goals / boundaries

- **Reassign is promotor→promotor only** (SIMs in `PROMOTER_HELD` / `PROMOTER_PENDING`). SIMs in `SUPERVISOR_HELD` / `ADMIN_HELD` return a
  per-row error pointing to the existing `assign-to-promoter` / `assign-to-promoter-direct` endpoints. Matches Isaac's ask; extendable
  later.
- **No SOLD mutations.** SOLD SIMs are skipped with a per-row error in both actions.
- No new MCP **write** tools (see MCP decision below).
- No change to the existing custody endpoints' behavior.

## Gating (no new paid tier; scoped to PlayTelecom by module, NOT by hardcoded slug)

Per founder decision: PlayTelecom is FREE and the **only** org that will use this. Scoping is achieved by the `SERIALIZED_INVENTORY`
**Module** (enabled org-level for PlayTelecom only) — never by `venue.slug === 'playtelecom'` (forbidden by
`.claude/rules/critical-warnings.md`).

- **Module gate:** every new endpoint checks `moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY)` (org-level fallback
  included). Orgs without the module get `{ ok:false, moduleRequired:true }`.
- **Permissions (new):** `sim-custody:reassign`, `serialized-inventory:change-category`.
  - `DEFAULT_PERMISSIONS`: granted to ADMIN + OWNER (SUPERADMIN via `*:*`).
  - `PERMISSION_DEPENDENCIES`: `'sim-custody:reassign': ['sim-custody:reassign','inventory:read']`,
    `'serialized-inventory:change-category': ['serialized-inventory:change-category','inventory:org-manage']`.
  - `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`: add both so they're assignable in the role editor.
  - `npm run audit:permissions` must exit 0 (PHANTOM/CATALOG_GAP checks).
- **No** `Feature`/`VenueFeature`/tier/`FeatureGate` wiring (this is admin management within a Module, not a monetizable Feature).

## Backend design (`avoqado-server`)

Reuses the existing custody framework in `src/services/serialized-inventory/custody.service.ts`: `BulkResult`/`BulkResultRow` (≤500/req),
`processOneRow` (per-row tx + error capture), `updateWithVersion` (optimistic `custodyVersion` lock), idempotency middleware, bulk
rate-limit, and the `writeEvent` dual-write (`SerializedItemCustodyEvent` + `logAction`→`ActivityLog`).

### 1. Prisma

Add one value to `enum SerializedItemCustodyEventType`: **`REASSIGNED_PROMOTER_TO_PROMOTER`**. Migration via
`npx prisma migrate dev --name sim_reassign_event`. (Category change is recorded in `ActivityLog` only — it is an item-attribute change, not
a custody transition — so the custody timeline stays custody-only and no 2nd enum value is needed.)

### 2. `custodyService.reassignPromoter(input)`

```
input = { actor: CustodyActor, toPromoterStaffId: string, serialNumbers: string[], idempotencyRequestId? }
```

- Validate `toPromoterStaffId` is an active promotor (WAITER/CASHIER) in the org → else `PROMOTER_NOT_FOUND`.
- Per SIM (tx + version lock):
  - resolve org item (case-insensitive serial); not found → `NOT_FOUND`.
  - `status === 'SOLD' || custodyState === 'SOLD'` → `SIM_SOLD`.
  - custodyState ∉ {`PROMOTER_HELD`,`PROMOTER_PENDING`} → `NOT_IN_PROMOTER_STATE` (guidance to use assign endpoints).
  - already `assignedPromoterId === toPromoterStaffId` → idempotent ok (no-op).
  - else set `assignedPromoterId = toPromoterStaffId`, `assignedPromoterAt = now`, `promoterAcceptedAt = now` if state is `PROMOTER_HELD`,
    **keep custodyState**, bump `custodyVersion`.
  - `writeEvent(REASSIGNED_PROMOTER_TO_PROMOTER, fromState=toState=current, fromStaffId=oldPromoter, toStaffId=new, actor)` + ActivityLog
    `SIM_CUSTODY_REASSIGNED_TO_PROMOTER`.
- **Admin override:** no owning-supervisor requirement (the gap vs `assignToPromoter`). Permission `sim-custody:reassign` is the gate.

### 3. `serializedInventoryService.changeCategory(input)`

```
input = { actor, serialNumbers: string[], categoryId: string, idempotencyRequestId? }
```

- Validate target `categoryId` exists and belongs to the org → else `CATEGORY_NOT_FOUND`.
- Per SIM (tx):
  - not found → `NOT_FOUND`; `status === 'SOLD'` → `SIM_SOLD`; already in target category → idempotent ok.
  - set `categoryId` (guarded `updateMany where {id, categoryId: current}` to avoid clobber).
  - `logAction({ action:'SERIALIZED_ITEM_CATEGORY_CHANGED', entity:'SerializedItem', entityId, venueId: sellingVenueId??registeredFromVenueId??venueId, staffId: actor.staffId, data:{ serialNumber, fromCategoryId, fromCategoryName, toCategoryId, toCategoryName } })`.
- New error codes in `src/lib/sim-custody-error-codes.ts`: `CATEGORY_NOT_FOUND`, `NOT_IN_PROMOTER_STATE`, `PROMOTER_NOT_FOUND` (Spanish
  messages).

### 4. Routes + controllers

In `src/routes/dashboard/simCustody.dashboard.routes.ts` (org-scoped `/dashboard/organizations/:orgId/sim-custody`):

- `POST /reassign-promoter` → `checkPermission('sim-custody:reassign')`
- `POST /change-category` → `checkPermission('serialized-inventory:change-category')`

Pipeline each:
`authenticateToken → moduleGate(SERIALIZED_INVENTORY) → checkPermission → idempotency → rateLimit(bulk) → validateRequest(zod, Spanish) → controller`.
Controllers are thin (parse, call service, return `BulkResult`). **Module gate is added to these new routes** (the existing custody routes
currently lack route-level module gating — fixing those is out of scope, noted as tech-debt).

### 5. MCP decision

No new MCP tool. The readable custody/category state is already exposed by the read-only `sim_custody` tool (`src/mcp/tools/inventory.ts`).
These are admin **writes**, outside the customer MCP's read scope (`getUserAccess`). Revisit if/when admin actions are exposed via MCP.

## Frontend design (`avoqado-web-dashboard`)

Integrated into the existing `OrgStockControlPage` (`/wl/organizations/:orgId/stock-control`) tabs (per founder choice — no new tab). Reuse
the `AssignToSupervisorDialog` bulk pattern (search / manual / CSV input + per-row result summary), `SimMultiSelect`, `SearchableSelect`,
`useOrgPromoters`.

- **`OrgDetalleSimsTab`** — multi-select SIM rows → two bulk actions:
  - **"Reasignar a promotor"** → `ReassignPromoterDialog` (pick target promotor + SIMs) →
    `reassignSimsToPromoter(orgId, { toPromoterStaffId, serialNumbers }, venueId)`. Gate: `can('sim-custody:reassign') || isSuperOrOwner`.
  - **"Cambiar categoría"** → `ChangeCategoryDialog` (pick target category + SIMs) →
    `changeSimsCategory(orgId, { categoryId, serialNumbers }, venueId)`. Gate:
    `can('serialized-inventory:change-category') || isSuperOrOwner`.
- **`OrgPorCategoriaTab`** — secondary entry point for "Cambiar categoría".
- New client fns in `src/services/simCustody.service.ts` (org-scoped, `x-venue-id` header for permission eval). On success invalidate
  `['org-stock-control']` and show the `BulkResult` summary (succeeded/failed with per-row reasons).
- Category options sourced from the org's `ItemCategory` list (existing stock services already expose categories).

## Data flow

`Dashboard dialog → simCustody.service (POST, x-venue-id) → route (module+perm+idempotency+ratelimit) → controller → service (per-row tx: update + version bump + audit) → BulkResult → dialog result summary → query invalidation refreshes the stock tabs.`

## Error handling

Always HTTP 200 with `BulkResult` (partial success). Per-row codes: `NOT_FOUND`, `SIM_SOLD`, `NOT_IN_PROMOTER_STATE`, `PROMOTER_NOT_FOUND`,
`CATEGORY_NOT_FOUND`, `VERSION_CONFLICT`, `ALREADY_*` (idempotent ok). Module-off → top-level `{ moduleRequired:true }`.

## Testing

- Unit tests (`tests/unit/...`) for `reassignPromoter` and `changeCategory`: happy path + edges (SOLD, NOT_FOUND, wrong-state, invalid
  category, cross-org isolation, version conflict, idempotent re-run)
  - regression that existing `assignToPromoter`/`assignToSupervisor` are unaffected.
- `prismaMock` registry: register any newly-queried model/relation in `tests/__helpers__/setup.ts`.
- `npm run audit:permissions` (cross-repo perm mirror) + `npm run test:unit` green before commit.
- Manual prod parity: the new endpoints must reproduce what the manual scripts did (the 2026-06-26/28 batches are the golden reference).

## Permissions checklist (mirror across repos)

1. `src/lib/permissions.ts`: add to `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`, `DEFAULT_PERMISSIONS` (ADMIN/OWNER), `PERMISSION_DEPENDENCIES`.
2. Backend gate: `checkPermission('sim-custody:reassign')` / `checkPermission('serialized-inventory:change-category')`.
3. Dashboard gate: `can('...')` in the two dialogs + tab action visibility.
4. TPV/Android: N/A (no TPV/POS surface for these admin actions).
5. `npm run audit:permissions` exits 0.

## Audit (ActivityLog) — required

- Reassign: dual-write (CustodyEvent `REASSIGNED_PROMOTER_TO_PROMOTER` + `ActivityLog` `SIM_CUSTODY_REASSIGNED_TO_PROMOTER`).
- Category change: `ActivityLog` `SERIALIZED_ITEM_CATEGORY_CHANGED`.
- Actor = the authenticated ADMIN (`authContext.userId`), venueId stamped from `sellingVenueId ?? registeredFromVenueId ?? venueId`.

## Out of scope / follow-ups

- MCP write tools (deferred, rationale above).
- Route-level module gating on the **existing** custody endpoints (separate tech-debt).
- Sales presentation update — exempt (internal admin capability, no customer-visible packaging change).
- Extending reassign to accept SUPERVISOR_HELD/ADMIN_HELD SIMs in one action.
