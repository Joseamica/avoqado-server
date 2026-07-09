# PlayTelecom MCP Coverage — Design Spec

**Date:** 2026-07-08
**Repo:** `avoqado-server` (MCP + backing services both live here)
**Status:** Approved design, pending implementation plan
**Owner decision on tier:** All new capabilities are READS gated by the existing
`SERIALIZED_INVENTORY` module (PREMIUM today). No new tier. No writes.

---

## 1. Problem

PlayTelecom (white-label serialized-inventory client) uses the Avoqado customer MCP,
but it cannot answer many natural PT questions in a single call. The model is forced to
**cross-reference** across tools — and sometimes cannot answer at all. A real production
incident: Isaac asked for a 12-week per-supervisor performance analysis (average weekly
approved sales per promoter → average per supervisor, excluding vacant store-weeks). The
MCP exposes no supervisor→store→promoter mapping and no weekly per-promoter series, so the
model resorted to a **subset-sum / meet-in-the-middle** heuristic to *guess* which store
belongs to which supervisor by matching weekly totals — fragile and unsafe for a real
conversation with supervisors.

Two problems to solve:

1. **Coverage** — expose the PT reads that today force cross-referencing, so Isaac can do
   everything from the MCP without opening the dashboard.
2. **Isolation & no-confusion** — a connection *without* the serialized-inventory /
   white-label modules must not even *see* SIM tools in its catalog (today they are
   registered for everyone and only blocked at call-time; data never leaks, but the tools
   are visible and can confuse a non-PT user or the model).

### What already works (verified, do not change)

Data isolation is **solid**. Every PT tool gates on BOTH:
- the connection scope (`activeOrg` + `allowedVenueIds`, enforced by `guard.venueFilter`), AND
- the `SERIALIZED_INVENTORY` / `WHITE_LABEL_DASHBOARD` module or a PT-specific permission
  (`sale-verifications:review`, `manual-sales:create`, `cash-out:read`).

A scalable-product user in their own org can never receive PT data: their PT venues are not
in scope, the module is off, and they lack the permissions. **This spec keeps every
call-time gate unchanged** — it only *adds* conditional registration on top (defense in depth).

---

## 2. Goals / Non-goals

**Goals**
- Add 7 read capabilities (below) so PT questions are answerable in one call.
- Conditionally register all PT tool groups so non-PT connections don't see them.
- Solve the Isaac-class analytical query with zero cross-referencing.

**Non-goals (explicitly out of scope)**
- Sale-verification **writes** (approve/reject/reopen/edit). Read-only for now (owner decision).
- Any change to tier packaging or to the existing call-time gates.
- Dashboard UI changes. This is MCP + backing services only.
- Hardcoding any PlayTelecom slug/name — everything stays module/permission-driven.

---

## 3. Architecture — Conditional Registration (Directive A)

Today `buildServerForIdentity` in `src/mcp/server.ts` registers every tool group
unconditionally; PT tools only block at call-time. New behavior:

1. After `resolveScope`, compute two booleans for the connection:
   - `serializedEnabled` = any venue in `scope.allowedVenueIds` has `SERIALIZED_INVENTORY`
     enabled (venue-level VenueModule OR org-level OrganizationModule fallback).
   - `whiteLabelEnabled` = same for `WHITE_LABEL_DASHBOARD`.
2. Register PT tool groups **only when their flag is on**:
   - `serializedEnabled` → serialized/SIM tools, sale-verification tools, manual-sale tool,
     cash-out tools.
   - `whiteLabelEnabled` → promoter-location tools.
3. Generic inventory tools (`low_stock`, `reorder_suggestions`, `configure_auto_reorder`,
   `adjust_stock`, `stock_value`, `create_raw_material`, `get_inventory_movements`) stay
   registered for **everyone**.
4. **Every call-time module/permission gate stays** — conditional registration is a
   UX/clarity layer, not the security boundary. A SUPERADMIN connection sees the PT tools
   (some venue in scope has the module), which is correct.

### Required refactor

`src/mcp/tools/inventory.ts` currently mixes generic inventory tools with the 4 serialized
tools (`serialized_inventory`, `mark_serialized_item`, `sim_custody`, `change_sim_category`).
Split the serialized tools into a new `src/mcp/tools/serialized.ts` (`registerSerializedTools`)
so `inventory.ts` keeps only the generic, always-registered tools and the new serialized
reads join `serialized.ts`. `registerSerializedTools`, `registerSaleVerificationTools`,
`registerManualSaleTools`, `registerCashOutTools` become conditionally registered on
`serializedEnabled`; `registerPromoterLocationTools` on `whiteLabelEnabled`.

### New bulk module helper

Add to `src/services/modules/module.service.ts`:
```ts
// MUST replicate isModuleEnabled's per-venue precedence EXACTLY (see module.service.ts:63):
//   1. If a VenueModule row EXISTS for (venue, module), it is the source of truth →
//      use venueModule.enabled (an explicit venue-level FALSE overrides an org-level TRUE).
//   2. Only when NO VenueModule row exists, fall back to the org-level OrganizationModule.
// Do NOT collapse this to "any VenueModule.enabled=true OR org enabled" — that would wrongly
// count a venue whose explicit override is OFF. Bulk (2 queries: VenueModule rows for the set,
// then one org check per distinct org) — reused by tools that loop isModuleEnabled per venue.
async anyVenueHasModule(venueIds: string[], moduleCode: ModuleCode): Promise<boolean>
async venuesWithModule(venueIds: string[], moduleCode: ModuleCode): Promise<Set<string>>
```
`buildServerForIdentity` uses `anyVenueHasModule(scope.allowedVenueIds, …)`. Keeps the hot
connect path to ~2 extra queries. **Mandatory test:** "org enabled + venue-level override
disabled ⇒ that venue is NOT in `venuesWithModule` and does not flip `anyVenueHasModule`."

---

## 4. New read tools

All descriptions in the tool schema teach the model exactly what the tool answers (Spanish
Q-phrases), and every tool keeps its existing per-call gate. Money in pesos (major units),
dates venue-local (America/Mexico_City).

### 4.0 Serialized scope semantics (org-level pool) — read this before tools #1/#2

`SerializedItem.venueId` is **nullable** (`null` = org-level item), and PlayTelecom registers
its SIM pool **at the org level** (`registerBatchOrg` → `venueId: null, organizationId: orgId`).
Therefore the existing service helpers are **not** safe to wrap as-is for the MCP:

- `serializedInventoryService.listItems({venueId})` filters `venueId` **strictly**, so it
  **misses the entire org-level pool** (every `venueId=null` SIM) — for PT it would return
  almost nothing.
- `serializedInventoryService.getStockByCategory(venueId)` groups by `categoryId` with **no
  item-level org/venue filter**, so it silently counts org-wide — inconsistent with the above.

**Decision — both new SIM tools query the ORG POOL explicitly**, mirroring the pattern already
proven in `sim_custody`/`change_sim_category`: scope items by
`OR: [{ venueId: { in: allowedVenueIds } }, { organizationId: orgId }]` (never a bare
`venueId` equality). Add two org-aware helpers rather than reusing the venue-scoped ones:

```ts
// serializedInventory.service.ts (new, org-aware)
async listOrgItems(opts: {
  orgId: string; allowedVenueIds: string[];
  categoryId?: string; status?: SerializedItemStatus;
  custodyState?: SerializedItemCustodyState; assignedPromoterId?: string;
  skip?: number; take?: number;
}): Promise<{ items: (SerializedItem & { category: ItemCategory })[]; total: number }>
async getOrgStockByCategory(orgId: string, allowedVenueIds: string[]):
  Promise<Array<{ category: ItemCategory; available: number; sold: number }>>
```

Both count/list the org pool (`venueId=null` items INCLUDED) plus any venue-scoped items in
`allowedVenueIds`, and scope categories to the org (as `getStockByCategory` already does).
The tool descriptions state the SIM pool is org-wide (PT registers SIMs org-level), so a
`venueId`/holder filter is *optional* narrowing, not the default scope. This removes the
venue-vs-org ambiguity and keeps #1 and #2 mutually consistent.

| # | Tool | File | Call gate | Backing fn (existing unless noted) | Answers |
|---|------|------|-----------|-----------------------------------|---------|
| 1 | `serialized_stock_by_category` | serialized.ts | module + `inventory:read` | **new** `serializedInventoryService.getOrgStockByCategory(orgId, allowedVenueIds)` (org pool) | "¿cuántas SIM de Intercambio / Evento / $100 / e-SIM disponibles vs vendidas?" |
| 2 | `list_serialized_items` | serialized.ts | module + `inventory:read` | **new** `serializedInventoryService.listOrgItems({orgId, allowedVenueIds, categoryId, status, custodyState, assignedPromoterId, skip, take})` | "lista los SIMs disponibles / los que trae el promotor X" (paginado, incluye `total`, incluye pool org-level) |
| 3 | `list_sale_verifications` | saleVerifications.ts | `sale-verifications:review` (org) | `listOrgSaleVerifications(orgId, {status, staffId, isPortabilidad, categoryId, search, pageNumber, pageSize})` | "muéstrame las ventas EN REVISIÓN / RECHAZADAS y **por qué**; qué debe corregir el promotor X" |
| 4 | `org_confirmed_sales_report` groupBy `promoterWeekly` | saleVerifications.ts | `sale-verifications:review` (org) | **new** `getSalesByPromoterWeekly(orgId, range)` | Isaac: por promotor × semana con tienda + supervisor, en una llamada |
| 5 | `org_structure` | saleVerifications.ts | `sale-verifications:review` (org) | **new** roster helper over `StaffVenue` | "supervisor → sus tiendas → sus promotores", incluye tiendas sin ventas |
| 6 | `cash_out_org_saldos` | cash-out.ts | `cash-out:read` (org) | **new** `getSaldosForOrg(orgId)` | "¿cuánto le debo de comisión a TODOS los promotores? top por saldo" |
| 7 | `promoters_live_locations` | promoterLocation.ts | WL module + `teams:read` | **new** `getLatestPromoterLocationsForVenue(venueId, date?)` | "¿dónde andan TODOS mis promotores ahora?" |

### 4.1 `promoterWeekly` (the Isaac fix) — output shape

New `groupBy: 'promoterWeekly'` value on the existing `org_confirmed_sales_report` tool.
Backed by a new `getSalesByPromoterWeekly(orgId, range)` in
`src/services/dashboard/sale-verification.org.dashboard.service.ts`. For each promoter
(from `SaleVerification.staffId`, COMPLETED only) it returns:

```jsonc
{
  "promoters": [
    {
      "staffId": "…",
      "promoterName": "…",
      "venueId": "…",            // store where they sold
      "venueName": "…",
      "supervisorId": "…",       // venue MANAGER (ADMIN fallback) — same rule as getSalesBySupervisor
      "supervisorName": "…",
      "byWeek": { "2026-W18": 12, "2026-W19": 9, … },  // ISO week → approved-sale count
      "total": 210
    }
  ]
}
```

A promoter selling across multiple stores yields one row per (promoter, store). Weeks with
zero appear as **absent keys** (the model treats a missing week as 0 and can drop it —
exactly Isaac's "excluir semanas en cero"). Reuses the existing supervisor-resolution logic
(`MANAGER` first, `ADMIN` fallback, deterministic by staffId) — extract it into a shared
helper so `getSalesBySupervisor` and `getSalesByPromoterWeekly` cannot drift apart.

### 4.2 `org_structure` — output shape

Derived from `StaffVenue` for the active org (no schema change; there is no `PROMOTER`
role and no explicit supervisor↔promoter FK). **Role definitions (must match existing
conventions, do not invent):**
- **Supervisor** = the venue's `MANAGER` (fallback `ADMIN`), deterministic by staffId —
  the SAME rule as `getSalesBySupervisor` (reuse `resolveSupervisorByVenue`).
- **Promoter** = active `StaffVenue` with `role ∈ { CASHIER, WAITER }` — the SAME filter the
  dashboard already uses to count promoters (`organizationDashboard.service.ts:572`). Do NOT
  list MANAGER/ADMIN/OWNER/VIEWER/etc. as promoters.

```jsonc
{
  "supervisors": [
    {
      "supervisorId": "…", "supervisorName": "…",
      "stores": [
        { "venueId": "…", "venueName": "…",
          "promoters": [ { "staffId": "…", "name": "…" } ] }
      ]
    }
  ],
  "unassignedStores": [ { "venueId": "…", "venueName": "…", "promoters": [ … ] } ]
}
```
Includes stores with zero sales (roster ≠ sales), so "no consideres tiendas vacantes" is
answerable by joining `org_structure` with the sales tools. `unassignedStores` = venues in
the org with no MANAGER/ADMIN.

### 4.3 Backend additions (signatures)

```ts
// sale-verification.org.dashboard.service.ts
export async function getSalesByPromoterWeekly(orgId: string, range: AggregationRange):
  Promise<Array<{ staffId: string; promoterName: string; venueId: string; venueName: string;
                  supervisorId: string | null; supervisorName: string;
                  byWeek: Record<string, number>; total: number }>>
export function resolveSupervisorByVenue(venueIds: string[]):
  Promise<Map<string, { id: string; name: string }>>   // extracted from getSalesBySupervisor

// new: org roster (or colocated in the tool)
export async function getOrgStructure(orgId: string): Promise<OrgStructure>

// cash-out.org.service.ts
export async function getSaldosForOrg(orgId: string):
  Promise<Array<{ venueId: string; staffId: string; promoterName: string; saldo: string /* pesos */ }>>
// MUST reproduce the real fresh-read path, NOT a raw groupBy over promoterCommissionEntry.
// getSaldo (cash-out.ledger.service.ts:128) only SUMS status=AVAILABLE entries — it does not
// materialize. Freshness + the business exclusions live in materializeEntries (ledger:34):
// it respects ADMIN active-days and EXCLUDES external MANUAL_ENTRY sales. So for each venue in
// the org (listVenueIdsForOrg): call materializeEntries(venueId) then reconcileClawbacks(venueId)
// (both idempotent, module-gated no-ops when off), then a single groupBy staffId where
// status=AVAILABLE. A naive ledger sum would return STALE/overstated saldos and re-implement
// exclusions that already exist. Perf note: this runs materialize across all org venues on a
// read; it is idempotent (skips existing entries) — acceptable, but log/observe cost at ~44 venues.

// promoterLocation.service.ts
export async function getLatestPromoterLocationsForVenue(venueId: string, date?: string):
  Promise<Array<{ promoterId: string; name: string; latest: PromoterTrackPoint | null }>>
// One query over promoterLocationPing for the venue-day, latest ping per staffId.

// module.service.ts
async anyVenueHasModule(venueIds: string[], code: ModuleCode): Promise<boolean>
async venuesWithModule(venueIds: string[], code: ModuleCode): Promise<Set<string>>
```

---

## 5. Isolation & gating guarantees (must hold after change)

- Non-PT connection: `serializedEnabled === false` → serialized/SIM, sale-verification,
  manual-sale, cash-out tools are **never registered**; `whiteLabelEnabled === false` →
  promoter-location tools never registered. The catalog shows only generic tools.
- PT connection: tools registered; each call still enforces module + permission + org/venue
  scope. No behavioral change for PT beyond the new reads.
- Cross-org: unchanged — `venueFilter` and org-scoped `requireReviewAccess` /
  `requireOrgReadAccess` already prevent reading another org's data. New org-level tools
  (`org_structure`, `cash_out_org_saldos`, `promoterWeekly`) use `scope.activeOrg` and the
  same org-permission gate as `org_confirmed_sales_report`.
- SUPERADMIN: global by design; sees PT tools; acceptable.

---

## 6. Testing

TDD (test-first) per repo convention.

- **Unit** (pure/aggregation): `getSalesByPromoterWeekly` (week bucketing, multi-store
  promoter, supervisor attribution, zero-week omission), `getOrgStructure` (MANAGER vs
  ADMIN fallback, unassigned stores, **promoters filtered to CASHIER/WAITER only**),
  `getSaldosForOrg`, `getLatestPromoterLocationsForVenue` (latest-per-promoter),
  `anyVenueHasModule` / `venuesWithModule`.
- **Audit-driven regression tests (from 2026-07-08 review — must exist):**
  1. **Org-level SIM pool**: `listOrgItems` / `getOrgStockByCategory` INCLUDE items with
     `venueId=null` (the PT pool). A fixture with an org-level SIM must appear — guards
     against the `listItems` strict-venueId miss.
  2. **Saldo freshness**: `getSaldosForOrg` reflects a just-created COMPLETED sale on an
     active day (i.e. it materialized) and EXCLUDES a `MANUAL_ENTRY` external sale — proves
     it uses the materialize path, not a stale raw sum.
  3. **Module override precedence**: org module ON + a venue-level VenueModule row with
     `enabled=false` ⇒ that venue is excluded from `venuesWithModule` and does not register
     PT tools for a connection scoped only to it.
- **Registration**: `buildServerForIdentity` registers PT groups when `serializedEnabled`
  and hides them when not (assert tool presence/absence for a PT-like vs scalable-like
  scope). This is the direct test of Directive A.
- **Gate**: each new tool returns the module/permission error for an out-of-module or
  low-permission caller (mirror existing tool tests).
- `/full-testing` on the finished change: happy-path + destructive, validate against
  Postgres, tail backend log. Git stays read-only (no commits without explicit permission).

---

## 7. MCP-in-sync note

This work **is** the MCP-sync obligation for the PT serialized-inventory surface — the
capabilities exist in services but were unreachable via MCP. No separate follow-up needed.
The MCP connector may need a restart to expose the new tools/groupBy after deploy.

---

## 8. Rollout

- No feature flag needed; conditional registration is inherent (module-driven).
- Deploy backend (services + MCP) together — single repo. After deploy, restart the MCP
  connector so the new tools/groupBy are advertised.
- No PAX / mobile involvement. No dashboard change.
