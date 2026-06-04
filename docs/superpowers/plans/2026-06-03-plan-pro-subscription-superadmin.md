# Superadmin Subscription Visibility + MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan. Each task below is a bite-sized TDD loop (write failing test → run → see it fail → implement → run → see it pass → verify). Dispatch one subagent per task in order; tasks within a "wave" (marked) are independent and may run in parallel. Do **NOT** commit — this runs on `develop` alongside other parallel LLMs; the "Verify" step replaces "Commit" and work is left **uncommitted** for the human to stage.

## Goal

Make the **PLAN_PRO base subscription visible to superadmin** in `avoqado-superadmin` — who is subscribed / trialing / suspended / canceling / past_due / canceled / none, with **MRR** — replacing today's hardcoded mock (`subscriptionPlan: 'PROFESSIONAL'`, `$299`, fake `nextBillingDate`), and expose the same aggregate + per-venue state through a **new MCP tool** so AI agents can read subscription health. This is **Plan 2 = spec Part C + the MCP tool**. The client-facing self-service plan management (Part A/B) is **Plan 1, a separate plan** — out of scope here.

## Architecture

```
avoqado-superadmin (React)                      avoqado-server (Express hub)                          scripts/mcp (MCP server)
─────────────────────────────                  ───────────────────────────────────────────         ──────────────────────────
features/subscriptions/                         GET /api/v1/superadmin/subscriptions/overview         tool: subscription_overview
  api.ts  ─────────────────── HTTP ───────────► GET /api/v1/superadmin/subscriptions/venues           (per-venue + aggregate)
  use-subscriptions.ts                                │                                                       │
  SubscriptionsPage.tsx                               ▼                                                       ▼
  + column/filter in VenuesPage                controllers/superadmin/subscription.controller.ts      both back onto ↓
                                                       │
                                                       ▼
                                                services/superadmin/subscription.service.ts ──────────────────┘
                                                       │  (reuses ↓ from Plan 1)
                                                       ▼
                                                services/access/basePlan.service.ts → derivePlanState()  [Plan 1 dependency]
                                                services/stripe.service.ts → read sub/price (period, interval, MRR)
```

- **Separate namespace** (locked decision): new endpoints live under the dedicated `/api/v1/superadmin/*` namespace (`src/routes/superadmin.routes.ts` already applies `authenticateTokenMiddleware` + `authorizeRole([StaffRole.SUPERADMIN])` globally — see `src/routes/superadmin.routes.ts:41-42`). The legacy `dashboard/superadmin.service.ts` mock is **left untouched**.
- **Server flow** matches the repo's `Routes → thin Controller → Service → Prisma/Stripe` convention (`CLAUDE.md` Architecture table).
- **Frontend** mirrors the existing `features/venues` slice: `api.ts` + `use-*.ts` (TanStack Query) + a page + reusable `data-table`/`filters` (`src/shared/data-table/DataTable.tsx`, `src/shared/filters`).

## Tech Stack

- **Backend:** Express + TypeScript, Prisma (PostgreSQL), Stripe SDK, Jest unit tests (`--runInBand`, mocked Prisma via `tests/__helpers__/setup.ts`).
- **MCP:** `@modelcontextprotocol/sdk` server in `scripts/mcp/` (tools register via `server.tool(name, desc, zodShape, handler)`; pure aggregation functions exported for unit testing — pattern from `scripts/mcp/tools/sales.ts` + `tests/unit/mcp/summarizeSales.test.ts`).
- **Frontend:** React 18 + Vite, TanStack Query, TanStack Table (`@tanstack/react-table`), Tailwind, Vitest + MSW (`msw/node`) for `api.ts` tests.

## Dependency on Plan 1 (`derivePlanState`)

This plan **consumes** a pure helper that **Plan 1 creates**:

```ts
// Lives in avoqado-server/src/services/access/basePlan.service.ts (next to venueHasActiveBasePlan, basePlan.service.ts:13)
// Plan 1 owns its creation + its own unit tests for all 7 states.
export function derivePlanState(
  venueFeature: { active: boolean; endDate: Date | null; suspendedAt: Date | null; gracePeriodEndsAt: Date | null } | null,
  stripeSub?: { status: string; cancel_at_period_end: boolean; current_period_end: number } | null,
): 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'
```

State logic (from spec §"State derivation", assume this exact output):

1. `venueFeature == null` → `none`
2. `suspendedAt != null` → `suspended`
3. `!active` → `canceled`
4. `gracePeriodEndsAt != null && now < gracePeriodEndsAt` (or Stripe `status === 'past_due'`) → `past_due`
5. `endDate != null && endDate > now` → `trial`
6. `stripeSub?.cancel_at_period_end === true` → `canceling`
7. otherwise → `active`

**Coordination guard (Task 0):** if `derivePlanState` is not yet exported when this plan runs, Task 0 creates a **minimal local copy** in the superadmin service folder (`src/services/superadmin/_derivePlanState.ts`) implementing the exact 7-state logic above + its own test, and the service imports from there. When Plan 1 lands, a follow-up swaps the import to `@/services/access/basePlan.service` and deletes the local copy. This keeps Plan 2 independently shippable. **Do not duplicate silently** — the local file header MUST say `// TEMPORARY: mirrors Plan 1 derivePlanState; delete + re-import once Plan 1 lands.`

---

## File Structure

### avoqado-server (new)

| File | Responsibility (one) |
|------|----------------------|
| `src/services/superadmin/subscription.service.ts` | Query `Venue.planTier` + each venue's `PLAN_PRO` `VenueFeature`, read Stripe sub/price on demand, derive state via `derivePlanState`, normalize MRR (annual/12), and assemble `SubscriptionOverview` + paginated `SuperadminVenueSubscription[]`. Exports pure helpers `monthlyMrrFromPrice()` + `buildOverviewCounts()` for unit testing. |
| `src/controllers/superadmin/subscription.controller.ts` | Thin: extract query params (`state`, `q`, `page`, `pageSize`), call service, respond `{ success, data, ... }`. No DB/Stripe access. |
| `src/routes/superadmin/subscription.routes.ts` | Two GET routes (`/overview`, `/venues`) + Zod query validation. Mounted under `/subscriptions` in `superadmin.routes.ts`. |
| `src/routes/superadmin/subscription.schemas.ts` | Zod schemas for `/venues` query (`state`, `q`, `page`, `pageSize`) — Spanish messages, shape-only. |
| `scripts/mcp/tools/subscriptions.ts` | MCP tool `subscription_overview`: registers via `registerSubscriptionTools(server)`, calls the **same** `subscription.service.ts`, returns aggregate + per-venue state. Re-exports nothing novel (logic stays in the service). |

### avoqado-server (modified)

| File | Edit |
|------|------|
| `src/routes/superadmin.routes.ts` | Import + mount `subscriptionRoutes` at `/subscriptions`. |
| `scripts/mcp/server.ts` | Import + call `registerSubscriptionTools(server)`. |

### avoqado-server (tests, new — COMMIT-equivalent, leave uncommitted)

| File | Covers |
|------|--------|
| `tests/unit/services/superadmin/subscription.service.test.ts` | `monthlyMrrFromPrice`, `buildOverviewCounts`, overview aggregate (monthly + annual normalization), `/venues` filtering by state + `q`, pagination, regression (mock service untouched). |
| `tests/unit/mcp/subscriptionOverview.test.ts` | The MCP tool's pure aggregate path returns counts/MRR shape; tolerant of empty fleet. |
| `tests/unit/services/superadmin/_derivePlanState.test.ts` | (Task 0 only) all 7 states — deleted when Plan 1's import is swapped in. |

### avoqado-superadmin (new)

| File | Responsibility (one) |
|------|----------------------|
| `src/features/subscriptions/types.ts` | `SubscriptionState`, `PlanTier`, `SuperadminVenueSubscription`, `SubscriptionOverview` types (mirror spec shapes) + `STATE_TONE`/`humanizeState` helpers for the Badge. |
| `src/features/subscriptions/api.ts` | `fetchSubscriptionOverview()` + `fetchVenueSubscriptions(params)` → `GET /superadmin/subscriptions/overview` & `/venues`. Unwraps the `{ success, data }` envelope (`SuperadminEnvelope<T>`). |
| `src/features/subscriptions/use-subscriptions.ts` | TanStack Query hooks `useSubscriptionOverview()` + `useVenueSubscriptions(params)`. |
| `src/features/subscriptions/SubscriptionsPage.tsx` | Summary header (counts + MRR from `/overview`) + `DataTable` of `SuperadminVenueSubscription` with a **state `FilterPill`** + search. |

### avoqado-superadmin (modified)

| File | Edit |
|------|------|
| `src/app/router.tsx` | Lazy-import + `<Route path="/subscriptions" element={<SubscriptionsPage />} />`. |
| `src/shared/layouts/AppLayout.tsx` | Add `{ to: '/subscriptions', label: 'Suscripciones', icon: <X> }` to the `Catálogo` nav section (after Venues). |

### avoqado-superadmin (tests, new — leave uncommitted)

| File | Covers |
|------|--------|
| `src/features/subscriptions/api.test.ts` | MSW: `fetchSubscriptionOverview` + `fetchVenueSubscriptions` unwrap the envelope; tolerate malformed payload (return safe empty). |
| `src/features/subscriptions/types.test.ts` | `humanizeState` + `STATE_TONE` cover all 7 states. |
| `src/features/subscriptions/SubscriptionsPage.test.tsx` | Renders summary counts + MRR; renders a row per venue; the state filter narrows rows. |

---

## Data shapes (spec — exact, no placeholders)

```ts
// avoqado-server: returned by subscription.service.ts (and mirrored in avoqado-superadmin/src/features/subscriptions/types.ts)
type SubscriptionState = 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'
type PlanTier = 'GRATIS' | 'PRO' | 'PREMIUM' | 'ENTERPRISE' | null

type SuperadminVenueSubscription = {
  venueId: string
  name: string
  slug: string
  planTier: PlanTier
  state: SubscriptionState
  trialEndsAt: string | null      // ISO
  currentPeriodEnd: string | null // ISO, from Stripe; null when no Stripe sub
  mrr: number                     // monthly-normalized gross MXN; 0 when not active/trial
  stripeSubscriptionId: string | null
  owner: { name: string | null; email: string | null }
}

type SubscriptionOverview = {
  counts: { active: number; trial: number; canceling: number; past_due: number; suspended: number; canceled: number; none: number; total: number }
  mrr: { total: number; currency: 'MXN' }
  trialsEndingSoon: Array<{ venueId: string; name: string; trialEndsAt: string }> // next 7 days
}
```

> **MRR rule (spec §State derivation):** `mrr` = gross monthly amount of the Stripe price; annual prices normalized as `annual / 12`; `0` for non-`active`/non-`trial` states. Stripe `unit_amount` is in **cents** → divide by 100. `VenueFeature.monthlyPrice` (`Decimal`, schema.prisma:2958) is the **fallback** when no Stripe sub exists (e.g. comped trial), already monthly + ex-IVA — see "Money & IVA" note.

> **Money & IVA:** The Stripe PLAN_PRO price is stored **gross (IVA-inclusive)** per the base-subscription design (matches what the customer is charged). So `mrr` = the price amount as-is (already gross). Do **not** re-apply IVA. When falling back to `VenueFeature.monthlyPrice` (rare DB-only trials), use it as-is too. Use `Number()` only at the JSON boundary; keep `Prisma.Decimal` internally where summing (`critical-warnings.md` "Money = Decimal").

---

## Tasks

> Conventions for every task: paths are absolute-from-repo-root. "Verify" = run `npx tsc --noEmit` (server: from `avoqado-server/`; frontend: from `avoqado-superadmin/`) **and** the task's test command, confirm the shown expected output, then **leave changes uncommitted**. Server tests run with `--runInBand` (OOM otherwise — `testing-and-git.md`).

### Wave 1 — Backend service (sequential: Task 0 → 1 → 2 → 3)

---

#### Task 0 — `derivePlanState` availability shim (only if Plan 1 not yet merged)

**Goal:** Guarantee `derivePlanState` is importable so the rest of Plan 2 is independent of Plan 1's merge timing.

**Step 0a — check:**
```bash
grep -n "export function derivePlanState" /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/access/basePlan.service.ts
```
If it prints a match → **skip the rest of Task 0**, the service will import from `@/services/access/basePlan.service`. If no match → do 0b–0d.

**Step 0b — failing test** `tests/unit/services/superadmin/_derivePlanState.test.ts`:
```ts
import { derivePlanState } from '@/services/superadmin/_derivePlanState'

const future = new Date(Date.now() + 7 * 86400_000)
const past = new Date(Date.now() - 7 * 86400_000)

describe('derivePlanState (temp mirror of Plan 1)', () => {
  it('none when no VenueFeature', () => expect(derivePlanState(null)).toBe('none'))
  it('suspended when suspendedAt set', () =>
    expect(derivePlanState({ active: true, endDate: null, suspendedAt: past, gracePeriodEndsAt: null })).toBe('suspended'))
  it('canceled when inactive', () =>
    expect(derivePlanState({ active: false, endDate: null, suspendedAt: null, gracePeriodEndsAt: null })).toBe('canceled'))
  it('past_due when in grace window', () =>
    expect(derivePlanState({ active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: future })).toBe('past_due'))
  it('past_due when Stripe status past_due', () =>
    expect(
      derivePlanState({ active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null }, { status: 'past_due', cancel_at_period_end: false, current_period_end: 0 }),
    ).toBe('past_due'))
  it('trial when endDate in future', () =>
    expect(derivePlanState({ active: true, endDate: future, suspendedAt: null, gracePeriodEndsAt: null })).toBe('trial'))
  it('canceling when cancel_at_period_end', () =>
    expect(
      derivePlanState({ active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null }, { status: 'active', cancel_at_period_end: true, current_period_end: 0 }),
    ).toBe('canceling'))
  it('active otherwise', () =>
    expect(derivePlanState({ active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null })).toBe('active'))
})
```
Run → fails (module missing):
```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server && npm test -- tests/unit/services/superadmin/_derivePlanState.test.ts --runInBand
```

**Step 0c — implement** `src/services/superadmin/_derivePlanState.ts`:
```ts
// TEMPORARY: mirrors Plan 1 derivePlanState; delete + re-import from
// '@/services/access/basePlan.service' once Plan 1 lands. See plan
// docs/superpowers/plans/2026-06-03-plan-pro-subscription-superadmin.md (Task 0).
export type PlanState = 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'

export function derivePlanState(
  vf: { active: boolean; endDate: Date | null; suspendedAt: Date | null; gracePeriodEndsAt: Date | null } | null,
  stripeSub?: { status: string; cancel_at_period_end: boolean; current_period_end: number } | null,
): PlanState {
  if (!vf) return 'none'
  if (vf.suspendedAt) return 'suspended'
  if (!vf.active) return 'canceled'
  const now = new Date()
  if ((vf.gracePeriodEndsAt && now < vf.gracePeriodEndsAt) || stripeSub?.status === 'past_due') return 'past_due'
  if (vf.endDate && vf.endDate > now) return 'trial'
  if (stripeSub?.cancel_at_period_end === true) return 'canceling'
  return 'active'
}
```

**Step 0d — Verify:** `npx tsc --noEmit` (0 errors) + the test command above → **8 passed**. Leave uncommitted.

> All later tasks import `derivePlanState` from whichever path the check chose. Below code shows the Plan-1 path; substitute `@/services/superadmin/_derivePlanState` if Task 0 created the shim.

---

#### Task 1 — Pure MRR + counts helpers (`monthlyMrrFromPrice`, `buildOverviewCounts`)

**Goal:** Isolate the two pieces of novel logic (annual→monthly normalization; counting by state) as pure, table-tested functions before any Prisma/Stripe wiring.

**Step 1a — failing test** `tests/unit/services/superadmin/subscription.service.test.ts` (first two describes):
```ts
import { monthlyMrrFromPrice, buildOverviewCounts } from '@/services/superadmin/subscription.service'
import type { SuperadminVenueSubscription } from '@/services/superadmin/subscription.service'

describe('monthlyMrrFromPrice', () => {
  it('monthly price: cents → pesos as-is', () => {
    expect(monthlyMrrFromPrice({ unit_amount: 115884, recurring: { interval: 'month', interval_count: 1 } })).toBe(1158.84)
  })
  it('annual price: divides by 12', () => {
    // 11588.40 / yr → 965.70 / mo
    expect(monthlyMrrFromPrice({ unit_amount: 1158840, recurring: { interval: 'year', interval_count: 1 } })).toBeCloseTo(965.7, 2)
  })
  it('multi-month interval normalizes by interval_count', () => {
    // 3-month price of $300 → $100/mo
    expect(monthlyMrrFromPrice({ unit_amount: 30000, recurring: { interval: 'month', interval_count: 3 } })).toBe(100)
  })
  it('returns 0 for null/odd input', () => {
    expect(monthlyMrrFromPrice(null)).toBe(0)
    expect(monthlyMrrFromPrice({ unit_amount: null, recurring: { interval: 'month', interval_count: 1 } })).toBe(0)
  })
})

describe('buildOverviewCounts', () => {
  const rows = (states: SuperadminVenueSubscription['state'][]): SuperadminVenueSubscription[] =>
    states.map((state, i) => ({
      venueId: `v${i}`, name: `V${i}`, slug: `v${i}`, planTier: 'PRO', state,
      trialEndsAt: null, currentPeriodEnd: null, mrr: state === 'active' || state === 'trial' ? 1000 : 0,
      stripeSubscriptionId: null, owner: { name: null, email: null },
    }))

  it('tallies each state + total', () => {
    const c = buildOverviewCounts(rows(['active', 'active', 'trial', 'suspended', 'none', 'canceling']))
    expect(c).toMatchObject({ active: 2, trial: 1, suspended: 1, none: 1, canceling: 1, past_due: 0, canceled: 0, total: 6 })
  })
  it('empty fleet → all zeros', () => {
    expect(buildOverviewCounts([])).toEqual({ active: 0, trial: 0, canceling: 0, past_due: 0, suspended: 0, canceled: 0, none: 0, total: 0 })
  })
})
```
Run → fails (no exports):
```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server && npm test -- tests/unit/services/superadmin/subscription.service.test.ts --runInBand
```

**Step 1b — implement** the two pure exports at the top of `src/services/superadmin/subscription.service.ts`:
```ts
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import Stripe from 'stripe'
import { PAID_PLAN_TIER_CODES } from '@/services/access/basePlan.service'
import { derivePlanState } from '@/services/access/basePlan.service' // OR '@/services/superadmin/_derivePlanState' (Task 0)

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

export type SubscriptionState = 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'
export type SuperadminPlanTier = 'GRATIS' | 'PRO' | 'PREMIUM' | 'ENTERPRISE' | null

export type SuperadminVenueSubscription = {
  venueId: string
  name: string
  slug: string
  planTier: SuperadminPlanTier
  state: SubscriptionState
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  mrr: number
  stripeSubscriptionId: string | null
  owner: { name: string | null; email: string | null }
}

export type SubscriptionOverview = {
  counts: { active: number; trial: number; canceling: number; past_due: number; suspended: number; canceled: number; none: number; total: number }
  mrr: { total: number; currency: 'MXN' }
  trialsEndingSoon: Array<{ venueId: string; name: string; trialEndsAt: string }>
}

/** Monthly-normalized gross amount (pesos) from a Stripe price. Annual → /12; N-month → /N. Stripe unit_amount is cents. */
export function monthlyMrrFromPrice(
  price: { unit_amount: number | null; recurring: { interval: string; interval_count: number } | null } | null,
): number {
  if (!price || price.unit_amount == null || !price.recurring) return 0
  const pesos = price.unit_amount / 100
  const { interval, interval_count } = price.recurring
  const months = interval === 'year' ? 12 * interval_count : interval === 'month' ? interval_count : 1
  if (months <= 0) return 0
  return Math.round((pesos / months) * 100) / 100
}

/** Tally a per-venue list into SubscriptionOverview['counts']. */
export function buildOverviewCounts(rows: SuperadminVenueSubscription[]): SubscriptionOverview['counts'] {
  const counts = { active: 0, trial: 0, canceling: 0, past_due: 0, suspended: 0, canceled: 0, none: 0, total: 0 }
  for (const r of rows) {
    counts[r.state] += 1
    counts.total += 1
  }
  return counts
}
```

**Step 1c — Verify:** `npx tsc --noEmit` + the test command → **monthlyMrrFromPrice (4) + buildOverviewCounts (2) = 6 passed** (the later describes for the full service come in Task 2 and will not exist yet — that's fine).

---

#### Task 2 — Service: `getSubscriptionsForSuperadmin` + `getSubscriptionOverview`

**Goal:** The DB + Stripe orchestration that produces `SuperadminVenueSubscription[]` and the `SubscriptionOverview` aggregate, with state filtering, `q` search, and pagination.

**Step 2a — failing test** — append to `tests/unit/services/superadmin/subscription.service.test.ts`:
```ts
import { prismaMock } from '../../../__helpers__/setup'
import { getSubscriptionsForSuperadmin, getSubscriptionOverview } from '@/services/superadmin/subscription.service'

// Stripe is mocked module-wide; resolve subs/prices deterministically.
jest.mock('stripe')

const future = new Date(Date.now() + 5 * 86400_000)

function venueRow(over: Partial<any> = {}) {
  return {
    id: 'cven1', name: 'Lagree HQ', slug: 'lagree-hq', planTier: 'PRO',
    features: [
      { active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null,
        stripeSubscriptionId: 'sub_1', stripePriceId: 'price_m', monthlyPrice: { toString: () => '1158.84' } },
    ],
    staff: [{ role: 'OWNER', staff: { firstName: 'Ana', lastName: 'Ruiz', email: 'ana@x.mx' } }],
    ...over,
  }
}

describe('getSubscriptionsForSuperadmin', () => {
  beforeEach(() => {
    prismaMock.venue.findMany.mockResolvedValue([venueRow()])
    prismaMock.venue.count.mockResolvedValue(1)
    // Stripe sub: active, monthly, current_period_end in 30d
    const Stripe = require('stripe')
    Stripe.prototype.subscriptions = { retrieve: jest.fn().mockResolvedValue({ status: 'active', cancel_at_period_end: false, current_period_end: Math.floor(future.getTime() / 1000), items: { data: [{ price: { id: 'price_m', unit_amount: 115884, recurring: { interval: 'month', interval_count: 1 } } }] } }) }
  })

  it('maps a venue with active PLAN_PRO to state=active + MRR from Stripe price', async () => {
    const { items, total } = await getSubscriptionsForSuperadmin({ page: 1, pageSize: 25 })
    expect(total).toBe(1)
    expect(items[0]).toMatchObject({
      venueId: 'cven1', name: 'Lagree HQ', planTier: 'PRO', state: 'active', mrr: 1158.84,
      stripeSubscriptionId: 'sub_1', owner: { name: 'Ana Ruiz', email: 'ana@x.mx' },
    })
  })

  it('filters by state (server re-derives, then filters)', async () => {
    const { items } = await getSubscriptionsForSuperadmin({ page: 1, pageSize: 25, state: 'suspended' })
    expect(items).toHaveLength(0) // the one venue is active
  })

  it('venue with NO PLAN_PRO feature → state=none, mrr=0, currentPeriodEnd=null', async () => {
    prismaMock.venue.findMany.mockResolvedValue([venueRow({ features: [] })])
    const { items } = await getSubscriptionsForSuperadmin({ page: 1, pageSize: 25 })
    expect(items[0]).toMatchObject({ state: 'none', mrr: 0, currentPeriodEnd: null, stripeSubscriptionId: null })
  })

  it('DB-only trial (no Stripe sub) → MRR from VenueFeature.monthlyPrice', async () => {
    prismaMock.venue.findMany.mockResolvedValue([
      venueRow({ features: [{ active: true, endDate: future, suspendedAt: null, gracePeriodEndsAt: null, stripeSubscriptionId: null, stripePriceId: null, monthlyPrice: { toString: () => '1158.84' } }] }),
    ])
    const { items } = await getSubscriptionsForSuperadmin({ page: 1, pageSize: 25 })
    expect(items[0]).toMatchObject({ state: 'trial', mrr: 1158.84, stripeSubscriptionId: null, currentPeriodEnd: null })
    expect(items[0].trialEndsAt).toBe(future.toISOString())
  })
})

describe('getSubscriptionOverview', () => {
  it('aggregates counts + total MRR + trialsEndingSoon', async () => {
    prismaMock.venue.findMany.mockResolvedValue([
      venueRow(), // active, mrr 1158.84 (Stripe mock from beforeEach is per-describe; re-stub here)
    ])
    const Stripe = require('stripe')
    Stripe.prototype.subscriptions = { retrieve: jest.fn().mockResolvedValue({ status: 'active', cancel_at_period_end: false, current_period_end: Math.floor(future.getTime() / 1000), items: { data: [{ price: { id: 'price_m', unit_amount: 115884, recurring: { interval: 'month', interval_count: 1 } } }] } }) }
    const ov = await getSubscriptionOverview()
    expect(ov.counts.active).toBe(1)
    expect(ov.counts.total).toBe(1)
    expect(ov.mrr).toEqual({ total: 1158.84, currency: 'MXN' })
  })

  it('annual subscription normalizes into MRR (annual/12)', async () => {
    prismaMock.venue.findMany.mockResolvedValue([venueRow({ features: [{ active: true, endDate: null, suspendedAt: null, gracePeriodEndsAt: null, stripeSubscriptionId: 'sub_y', stripePriceId: 'price_y', monthlyPrice: { toString: () => '0' } }] })])
    const Stripe = require('stripe')
    Stripe.prototype.subscriptions = { retrieve: jest.fn().mockResolvedValue({ status: 'active', cancel_at_period_end: false, current_period_end: Math.floor(future.getTime() / 1000), items: { data: [{ price: { id: 'price_y', unit_amount: 1158840, recurring: { interval: 'year', interval_count: 1 } } }] } }) }
    const ov = await getSubscriptionOverview()
    expect(ov.mrr.total).toBeCloseTo(965.7, 1)
  })
})
```
Run → fails (functions don't exist).

**Step 2b — implement** the orchestration in `src/services/superadmin/subscription.service.ts`:
```ts
type ListParams = { state?: SubscriptionState; q?: string; page: number; pageSize: number }

const PLAN_TIER_NAME: Record<string, string> = { PRO: 'Plan Avoqado Pro', PREMIUM: 'Plan Avoqado Premium', ENTERPRISE: 'Plan Avoqado Enterprise', GRATIS: 'Plan Gratis' }

/** Map one venue row (with its PLAN_PRO feature + owner) into a SuperadminVenueSubscription, reading Stripe when a sub id exists. */
async function mapVenueSubscription(v: {
  id: string; name: string; slug: string; planTier: string | null
  features: Array<{ active: boolean; endDate: Date | null; suspendedAt: Date | null; gracePeriodEndsAt: Date | null; stripeSubscriptionId: string | null; stripePriceId: string | null; monthlyPrice: { toString(): string } }>
  staff: Array<{ role: string; staff: { firstName: string; lastName: string; email: string } | null }>
}): Promise<SuperadminVenueSubscription> {
  const vf = v.features[0] ?? null

  // Read Stripe on demand (best-effort — never throw the whole list on one bad sub).
  let stripeSub: { status: string; cancel_at_period_end: boolean; current_period_end: number } | null = null
  let mrr = 0
  let currentPeriodEnd: string | null = null
  if (vf?.stripeSubscriptionId) {
    try {
      const sub = (await stripe.subscriptions.retrieve(vf.stripeSubscriptionId)) as any
      stripeSub = { status: sub.status, cancel_at_period_end: !!sub.cancel_at_period_end, current_period_end: sub.current_period_end }
      currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
      const price = sub.items?.data?.[0]?.price ?? null
      mrr = monthlyMrrFromPrice(price)
    } catch (err) {
      logger.warn(`[superadmin/subscriptions] Stripe read failed for ${vf.stripeSubscriptionId}`, err)
    }
  }

  const state = derivePlanState(vf, stripeSub)
  // MRR only counts for entitled states. Fallback to VenueFeature.monthlyPrice when no Stripe amount (DB-only trial).
  if (state !== 'active' && state !== 'trial') mrr = 0
  else if (mrr === 0 && vf) mrr = Number(vf.monthlyPrice.toString()) || 0

  const ownerStaff = v.staff.find(s => s.role === 'OWNER') ?? v.staff.find(s => s.role === 'ADMIN')
  const owner = ownerStaff?.staff
    ? { name: `${ownerStaff.staff.firstName} ${ownerStaff.staff.lastName}`.trim() || null, email: ownerStaff.staff.email || null }
    : { name: null, email: null }

  return {
    venueId: v.id, name: v.name, slug: v.slug,
    planTier: (v.planTier as SuperadminPlanTier) ?? null,
    state,
    trialEndsAt: vf?.endDate ? vf.endDate.toISOString() : null,
    currentPeriodEnd,
    mrr,
    stripeSubscriptionId: vf?.stripeSubscriptionId ?? null,
    owner,
  }
}

/** Shared loader: every venue + its single PLAN_PRO VenueFeature (if any) + owner staff. Tenant scope = superadmin (all venues). */
async function loadVenueSubscriptions(q?: string): Promise<SuperadminVenueSubscription[]> {
  const venues = await prisma.venue.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }] } : undefined,
    select: {
      id: true, name: true, slug: true, planTier: true,
      features: {
        where: { feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
        select: { active: true, endDate: true, suspendedAt: true, gracePeriodEndsAt: true, stripeSubscriptionId: true, stripePriceId: true, monthlyPrice: true },
        take: 1,
      },
      staff: { where: { role: { in: ['OWNER', 'ADMIN'] } }, select: { role: true, staff: { select: { firstName: true, lastName: true, email: true } } }, take: 5 },
    },
    orderBy: { name: 'asc' },
  })
  return Promise.all(venues.map(mapVenueSubscription))
}

/** Paginated, state-filterable per-venue subscription list. */
export async function getSubscriptionsForSuperadmin(params: ListParams): Promise<{ items: SuperadminVenueSubscription[]; total: number; page: number; pageSize: number }> {
  const all = await loadVenueSubscriptions(params.q)
  const filtered = params.state ? all.filter(r => r.state === params.state) : all
  const start = (params.page - 1) * params.pageSize
  return { items: filtered.slice(start, start + params.pageSize), total: filtered.length, page: params.page, pageSize: params.pageSize }
}

/** Fleet-wide aggregate: counts by state, total monthly-normalized MRR, trials ending in the next 7 days. */
export async function getSubscriptionOverview(): Promise<SubscriptionOverview> {
  const all = await loadVenueSubscriptions()
  const counts = buildOverviewCounts(all)
  const total = Math.round(all.reduce((sum, r) => sum + r.mrr, 0) * 100) / 100
  const now = Date.now()
  const sevenDays = now + 7 * 86400_000
  const trialsEndingSoon = all
    .filter(r => r.state === 'trial' && r.trialEndsAt && new Date(r.trialEndsAt).getTime() <= sevenDays && new Date(r.trialEndsAt).getTime() >= now)
    .map(r => ({ venueId: r.venueId, name: r.name, trialEndsAt: r.trialEndsAt as string }))
  return { counts, mrr: { total, currency: 'MXN' }, trialsEndingSoon }
}
```

> **prismaMock note** (`testing-and-git.md` / memory "prismaMock is a manual registry"): `venue`, `venueFeature`, `staff`, `staffVenue` are all already registered in `tests/__helpers__/setup.ts:70-95`. The tests above stub `prismaMock.venue.findMany`/`.count` directly — no registry edit needed. The query uses the nested `features`/`staff` relation selects (same shape the legacy service uses, `superadmin.service.ts:267-283`), so the mock just returns the shaped object.

**Step 2c — Verify:** `npx tsc --noEmit` + `npm test -- tests/unit/services/superadmin/subscription.service.test.ts --runInBand` → all describes pass (helpers 6 + list 4 + overview 2 = **12 passed**).

---

#### Task 3 — Routes + controller + Zod schema (mount under `/api/v1/superadmin/subscriptions`)

**Goal:** Expose the service over HTTP under the SUPERADMIN-guarded namespace, with validated query params.

**Step 3a — Zod schema** `src/routes/superadmin/subscription.schemas.ts` (Spanish messages, shape-only — `critical-warnings.md`):
```ts
import { z } from 'zod'

const STATES = ['none', 'trial', 'active', 'canceling', 'past_due', 'suspended', 'canceled'] as const

export const listSubscriptionsSchema = z.object({
  query: z.object({
    state: z.enum(STATES, { errorMap: () => ({ message: 'Estado de suscripción inválido' }) }).optional(),
    q: z.string().trim().min(1).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
  }),
})
```

**Step 3b — controller** `src/controllers/superadmin/subscription.controller.ts` (thin, envelope matches sibling `aggregator.controller.ts`):
```ts
import { Request, Response, NextFunction } from 'express'
import { getSubscriptionOverview, getSubscriptionsForSuperadmin, type SubscriptionState } from '@/services/superadmin/subscription.service'

/** GET /api/v1/superadmin/subscriptions/overview */
export async function overview(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getSubscriptionOverview()
    res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/** GET /api/v1/superadmin/subscriptions/venues?state=&q=&page=&pageSize= */
export async function venues(req: Request, res: Response, next: NextFunction) {
  try {
    const { state, q, page, pageSize } = req.query as { state?: SubscriptionState; q?: string; page?: unknown; pageSize?: unknown }
    const result = await getSubscriptionsForSuperadmin({ state, q, page: Number(page) || 1, pageSize: Number(pageSize) || 25 })
    res.json({ success: true, data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } })
  } catch (error) {
    next(error)
  }
}
```

**Step 3c — routes** `src/routes/superadmin/subscription.routes.ts` (mirror `venue-access.routes.ts:14-19`; auth/role already applied by the parent router):
```ts
import { Router } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { listSubscriptionsSchema } from './subscription.schemas'
import * as controller from '@/controllers/superadmin/subscription.controller'

/**
 * PLAN_PRO subscription visibility for superadmin. Mounted under `/subscriptions`
 * in superadmin.routes.ts, which already applies authenticateTokenMiddleware +
 * authorizeRole([SUPERADMIN]) globally — no extra guard here.
 *
 *   GET /api/v1/superadmin/subscriptions/overview
 *   GET /api/v1/superadmin/subscriptions/venues?state=&q=&page=&pageSize=
 */
const router = Router()

router.get('/overview', controller.overview)
router.get('/venues', validateRequest(listSubscriptionsSchema), controller.venues)

export default router
```

**Step 3d — mount** in `src/routes/superadmin.routes.ts`. Add the import near the other sub-route imports (after line 34, `terminalOrderSuperadminRoutes`):
```ts
import subscriptionRoutes from './superadmin/subscription.routes'
```
Add the mount in the `router.use(...)` block (e.g. after `router.use('/venue-commissions', venueCommissionRoutes)` at line 67):
```ts
router.use('/subscriptions', subscriptionRoutes)
```

**Step 3e — Verify:** `npx tsc --noEmit` (0 errors) confirms the route/controller/service types line up. Re-run the service test from Task 2 to confirm no regression:
```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server && npm test -- tests/unit/services/superadmin/subscription.service.test.ts --runInBand
```
→ **12 passed**. (No new failing test for the thin controller/route — they are exercised via the service tests; an optional supertest could be added but the spec's testing list does not require it.) Leave uncommitted.

> **Permissions note:** these are SUPERADMIN-only endpoints guarded by `authorizeRole([StaffRole.SUPERADMIN])` (the established superadmin-namespace convention, `superadmin.routes.ts:42`), **not** `checkPermission`. No `permissions.ts` catalog entry is needed (spec Part A4's `billing:*` work belongs to Plan 1's client endpoints, not here). Do **not** run `audit:permissions` for this plan — no `checkPermission` strings are introduced.

---

### Wave 2 — MCP tool (depends on Wave 1; Task 4)

---

#### Task 4 — MCP `subscription_overview` tool (mandatory MCP-sync)

**Goal:** Expose the same aggregate + per-venue state through the MCP, backed by the **same** `subscription.service.ts` (MCP-sync rule, `CLAUDE.md` 🔴). Pattern: `scripts/mcp/tools/sales.ts` + registration in `scripts/mcp/server.ts`.

> **Location note:** `scripts/mcp/` is the canonical MCP path per `CLAUDE.md`. On the current `develop` checkout it is not yet materialized (it lives on the `feat/admin-mcp` branch / worktree). When executing: if `scripts/mcp/server.ts` does not exist in the working tree, the executing agent must first restore the MCP scaffold onto the branch (cherry-pick / copy `scripts/mcp/{server.ts,context.ts,stdout-guard.ts,tools/*}` from `feat/admin-mcp`) so this tool has a server to register into. The tool code + test below are written against the real patterns in that scaffold (`context.ts` exports `prisma`, `text`, `formatMoney`; `server.ts` calls `registerXTools(server)`).

**Step 4a — failing test** `tests/unit/mcp/subscriptionOverview.test.ts` (pure-path, mirrors `summarizeSales.test.ts`):
```ts
import { prismaMock } from '../../__helpers__/setup'
import { buildSubscriptionMcpPayload } from '../../../scripts/mcp/tools/subscriptions'

describe('subscription_overview MCP payload', () => {
  it('combines overview + per-venue rows into one MCP-friendly object', () => {
    const overview = { counts: { active: 1, trial: 0, canceling: 0, past_due: 0, suspended: 0, canceled: 0, none: 0, total: 1 }, mrr: { total: 1158.84, currency: 'MXN' as const }, trialsEndingSoon: [] }
    const venues = [{ venueId: 'v1', name: 'X', slug: 'x', planTier: 'PRO' as const, state: 'active' as const, trialEndsAt: null, currentPeriodEnd: null, mrr: 1158.84, stripeSubscriptionId: 'sub_1', owner: { name: 'A', email: 'a@x.mx' } }]
    const payload = buildSubscriptionMcpPayload(overview, venues)
    expect(payload.counts.active).toBe(1)
    expect(payload.mrrFormatted).toMatch(/1,158\.84/)
    expect(payload.venues).toHaveLength(1)
  })
  it('tolerates an empty fleet', () => {
    const empty = { counts: { active: 0, trial: 0, canceling: 0, past_due: 0, suspended: 0, canceled: 0, none: 0, total: 0 }, mrr: { total: 0, currency: 'MXN' as const }, trialsEndingSoon: [] }
    const payload = buildSubscriptionMcpPayload(empty, [])
    expect(payload.venues).toEqual([])
    expect(payload.counts.total).toBe(0)
  })
})

// Silence "unused" — prismaMock import keeps the global mock active for the service import chain.
void prismaMock
```
Run → fails (module missing):
```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server && npm test -- tests/unit/mcp/subscriptionOverview.test.ts --runInBand
```

**Step 4b — implement** `scripts/mcp/tools/subscriptions.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { text, formatMoney } from '../context'
import {
  getSubscriptionOverview,
  getSubscriptionsForSuperadmin,
  type SubscriptionOverview,
  type SuperadminVenueSubscription,
} from '@/services/superadmin/subscription.service'

/** Pure shaper — combines the overview aggregate with the per-venue rows into one MCP text payload. Unit-tested. */
export function buildSubscriptionMcpPayload(overview: SubscriptionOverview, venues: SuperadminVenueSubscription[]) {
  return {
    counts: overview.counts,
    mrr: overview.mrr,
    mrrFormatted: formatMoney(overview.mrr.total),
    trialsEndingSoon: overview.trialsEndingSoon,
    venues,
  }
}

export function registerSubscriptionTools(server: McpServer) {
  server.tool(
    'subscription_overview',
    'PLAN_PRO base-subscription health across the whole Avoqado fleet: counts by state (active/trial/canceling/past_due/suspended/canceled/none), total monthly-normalized MRR (MXN), trials ending in the next 7 days, and a per-venue breakdown (state, planTier, MRR, renewal date). Optionally filter the per-venue list by state.',
    {
      state: z
        .enum(['none', 'trial', 'active', 'canceling', 'past_due', 'suspended', 'canceled'])
        .optional()
        .describe('Filter the per-venue list to one subscription state'),
      limit: z.number().int().min(1).max(200).default(100).describe('Max venues in the per-venue breakdown'),
    },
    async ({ state, limit }) => {
      const [overview, list] = await Promise.all([
        getSubscriptionOverview(),
        getSubscriptionsForSuperadmin({ state, page: 1, pageSize: limit }),
      ])
      return text(buildSubscriptionMcpPayload(overview, list.items))
    },
  )
}
```

**Step 4c — register** in `scripts/mcp/server.ts`: add the import next to the others (after `import { registerCreateTools } from './tools/create'`, line 12) and the call inside `main()` (after `registerCreateTools(server)`, line 28):
```ts
import { registerSubscriptionTools } from './tools/subscriptions'
// ...
registerSubscriptionTools(server)
```

**Step 4d — Verify:** `npx tsc --noEmit` + `npm test -- tests/unit/mcp/subscriptionOverview.test.ts --runInBand` → **2 passed**. Leave uncommitted.

---

### Wave 3 — Superadmin frontend (independent of Wave 1/2 at code level; runs against the new endpoints. Tasks 5 → 6 → 7 → 8)

---

#### Task 5 — Types + state humanizer (`features/subscriptions/types.ts`)

**Goal:** Mirror the spec shapes on the client and map each state to a Badge tone + Spanish label.

**Step 5a — failing test** `src/features/subscriptions/types.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { humanizeState, STATE_TONE, type SubscriptionState } from './types'

const ALL: SubscriptionState[] = ['none', 'trial', 'active', 'canceling', 'past_due', 'suspended', 'canceled']

describe('humanizeState', () => {
  it('returns a non-empty Spanish label for every state', () => {
    for (const s of ALL) expect(humanizeState(s).length).toBeGreaterThan(0)
  })
  it('maps active and trial to positive tones', () => {
    expect(STATE_TONE.active).toBe('success')
    expect(STATE_TONE.trial).toBe('info')
  })
  it('maps risk states to warn/danger', () => {
    expect(STATE_TONE.past_due).toBe('warn')
    expect(STATE_TONE.suspended).toBe('danger')
  })
})
```

**Step 5b — implement** `src/features/subscriptions/types.ts`:
```ts
/** Mirror of avoqado-server SubscriptionState (subscription.service.ts). */
export type SubscriptionState = 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'
/** Mirror of avoqado-server PlanTier enum (schema.prisma:5629). */
export type PlanTier = 'GRATIS' | 'PRO' | 'PREMIUM' | 'ENTERPRISE' | null

export interface SuperadminVenueSubscription {
  venueId: string
  name: string
  slug: string
  planTier: PlanTier
  state: SubscriptionState
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  mrr: number
  stripeSubscriptionId: string | null
  owner: { name: string | null; email: string | null }
}

export interface SubscriptionOverview {
  counts: { active: number; trial: number; canceling: number; past_due: number; suspended: number; canceled: number; none: number; total: number }
  mrr: { total: number; currency: 'MXN' }
  trialsEndingSoon: Array<{ venueId: string; name: string; trialEndsAt: string }>
}

// Tone union mirrors src/shared/ui/Badge.tsx ('muted'|'success'|'warn'|'danger'|'info'|'accent').
export const STATE_TONE: Record<SubscriptionState, 'muted' | 'success' | 'warn' | 'danger' | 'info' | 'accent'> = {
  active: 'success',
  trial: 'info',
  canceling: 'warn',
  past_due: 'warn',
  suspended: 'danger',
  canceled: 'muted',
  none: 'muted',
}

const STATE_LABEL: Record<SubscriptionState, string> = {
  active: 'Activa',
  trial: 'En prueba',
  canceling: 'Por cancelar',
  past_due: 'Pago vencido',
  suspended: 'Suspendida',
  canceled: 'Cancelada',
  none: 'Sin plan',
}

export function humanizeState(state: SubscriptionState): string {
  return STATE_LABEL[state] ?? 'Desconocido'
}
```

**Step 5c — Verify:** `npx tsc --noEmit` + `npm run test:run -- src/features/subscriptions/types.test.ts` → **3 passed**. Leave uncommitted.

---

#### Task 6 — API client (`features/subscriptions/api.ts`) + hooks

**Goal:** Fetch the two new endpoints, unwrap the `{ success, data }` envelope (`SuperadminEnvelope<T>` pattern from `features/venues/api.ts:72-76`), pointed at the **new** `/superadmin/subscriptions/*` namespace.

**Step 6a — failing test** `src/features/subscriptions/api.test.ts` (MSW pattern from `features/venues/api.test.ts:1-66`):
```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { fetchSubscriptionOverview, fetchVenueSubscriptions } from './api'

const baseURL = 'http://localhost:3000/api/v1'
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('fetchSubscriptionOverview', () => {
  it('unwraps { success, data }', async () => {
    server.use(
      http.get(`${baseURL}/superadmin/subscriptions/overview`, () =>
        HttpResponse.json({ success: true, data: { counts: { active: 2, trial: 1, canceling: 0, past_due: 0, suspended: 0, canceled: 0, none: 3, total: 6 }, mrr: { total: 2317.68, currency: 'MXN' }, trialsEndingSoon: [] } }),
      ),
    )
    const ov = await fetchSubscriptionOverview()
    expect(ov.counts.active).toBe(2)
    expect(ov.mrr.total).toBe(2317.68)
  })
  it('returns safe empty overview on malformed payload', async () => {
    server.use(http.get(`${baseURL}/superadmin/subscriptions/overview`, () => HttpResponse.json({ success: true })))
    const ov = await fetchSubscriptionOverview()
    expect(ov.counts.total).toBe(0)
  })
})

describe('fetchVenueSubscriptions', () => {
  it('returns the data array + passes state/q params', async () => {
    server.use(
      http.get(`${baseURL}/superadmin/subscriptions/venues`, ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('state')).toBe('active')
        return HttpResponse.json({ success: true, data: [{ venueId: 'v1', name: 'X', slug: 'x', planTier: 'PRO', state: 'active', trialEndsAt: null, currentPeriodEnd: null, mrr: 1000, stripeSubscriptionId: 'sub_1', owner: { name: 'A', email: 'a@x.mx' } }], meta: { total: 1, page: 1, pageSize: 25 } })
      }),
    )
    const rows = await fetchVenueSubscriptions({ state: 'active' })
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('active')
  })
  it('returns [] on malformed payload', async () => {
    server.use(http.get(`${baseURL}/superadmin/subscriptions/venues`, () => HttpResponse.json({ success: true })))
    expect(await fetchVenueSubscriptions({})).toEqual([])
  })
})
```

**Step 6b — implement** `src/features/subscriptions/api.ts`:
```ts
/**
 * API client del feature Subscriptions.
 *
 * Apunta al namespace NUEVO `/api/v1/superadmin/subscriptions/*` (separado del
 * feature `venues`, que consume el legacy `/dashboard/superadmin/*`). Estos
 * endpoints son SUPERADMIN-only y devuelven el envelope `{ success, data }`
 * como el resto del namespace superadmin — lo desenvolvemos acá.
 */
import { api } from '@/shared/lib/api'
import type { SubscriptionOverview, SuperadminVenueSubscription, SubscriptionState } from './types'

interface SuperadminEnvelope<T> {
  success: boolean
  data: T
  meta?: { total: number; page: number; pageSize: number }
}

const EMPTY_OVERVIEW: SubscriptionOverview = {
  counts: { active: 0, trial: 0, canceling: 0, past_due: 0, suspended: 0, canceled: 0, none: 0, total: 0 },
  mrr: { total: 0, currency: 'MXN' },
  trialsEndingSoon: [],
}

export async function fetchSubscriptionOverview(): Promise<SubscriptionOverview> {
  const { data } = await api.get<SuperadminEnvelope<SubscriptionOverview>>('/superadmin/subscriptions/overview')
  // Defensa contra payload mal formado — overview vacío en vez de crashear el header.
  if (!data?.data?.counts) return EMPTY_OVERVIEW
  return data.data
}

export interface FetchVenueSubscriptionsParams {
  state?: SubscriptionState
  q?: string
  page?: number
  pageSize?: number
}

export async function fetchVenueSubscriptions(params: FetchVenueSubscriptionsParams = {}): Promise<SuperadminVenueSubscription[]> {
  const { data } = await api.get<SuperadminEnvelope<SuperadminVenueSubscription[]>>('/superadmin/subscriptions/venues', {
    params: { state: params.state, q: params.q, page: params.page, pageSize: params.pageSize ?? 200 },
  })
  if (!Array.isArray(data?.data)) return []
  return data.data
}
```

**Step 6c — hooks** `src/features/subscriptions/use-subscriptions.ts` (TanStack pattern from `use-venues.ts:21-29`):
```ts
import { useQuery } from '@tanstack/react-query'
import { fetchSubscriptionOverview, fetchVenueSubscriptions, type FetchVenueSubscriptionsParams } from './api'

export const SUBSCRIPTIONS_QUERY_KEY = ['superadmin', 'subscriptions'] as const

export function useSubscriptionOverview() {
  return useQuery({ queryKey: [...SUBSCRIPTIONS_QUERY_KEY, 'overview'], queryFn: fetchSubscriptionOverview, staleTime: 60_000 })
}

export function useVenueSubscriptions(params: FetchVenueSubscriptionsParams = {}) {
  return useQuery({ queryKey: [...SUBSCRIPTIONS_QUERY_KEY, 'venues', params], queryFn: () => fetchVenueSubscriptions(params), staleTime: 60_000 })
}
```

**Step 6d — Verify:** `npx tsc --noEmit` + `npm run test:run -- src/features/subscriptions/api.test.ts` → **4 passed**. Leave uncommitted.

---

#### Task 7 — `SubscriptionsPage.tsx` (summary header + table + state filter)

**Goal:** A page that shows the fleet summary (counts + MRR from `/overview`) and a `DataTable` of `SuperadminVenueSubscription` with a state `FilterPill` and search — built from the existing `DataTable` (`src/shared/data-table/DataTable.tsx`) and `filters` primitives, matching `VenuesPage.tsx`.

**Step 7a — failing test** `src/features/subscriptions/SubscriptionsPage.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { SubscriptionsPage } from './SubscriptionsPage'

const baseURL = 'http://localhost:3000/api/v1'
const server = setupServer(
  http.get(`${baseURL}/superadmin/subscriptions/overview`, () =>
    HttpResponse.json({ success: true, data: { counts: { active: 2, trial: 1, canceling: 0, past_due: 0, suspended: 1, canceled: 0, none: 0, total: 4 }, mrr: { total: 2317.68, currency: 'MXN' }, trialsEndingSoon: [] } }),
  ),
  http.get(`${baseURL}/superadmin/subscriptions/venues`, () =>
    HttpResponse.json({ success: true, data: [
      { venueId: 'v1', name: 'Lagree HQ', slug: 'lagree-hq', planTier: 'PRO', state: 'active', trialEndsAt: null, currentPeriodEnd: '2026-07-01T00:00:00.000Z', mrr: 1158.84, stripeSubscriptionId: 'sub_1', owner: { name: 'Ana', email: 'ana@x.mx' } },
      { venueId: 'v2', name: 'Iyashi Spa', slug: 'iyashi', planTier: 'PRO', state: 'suspended', trialEndsAt: null, currentPeriodEnd: null, mrr: 0, stripeSubscriptionId: 'sub_2', owner: { name: 'Bea', email: 'bea@x.mx' } },
    ], meta: { total: 2, page: 1, pageSize: 200 } }),
  ),
)
beforeEach(() => server.resetHandlers())

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><SubscriptionsPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SubscriptionsPage', () => {
  it('renders the MRR summary and a row per venue', async () => {
    server.listen({ onUnhandledRequest: 'bypass' })
    renderPage()
    expect(await screen.findByText('Lagree HQ')).toBeInTheDocument()
    expect(screen.getByText('Iyashi Spa')).toBeInTheDocument()
    // MRR total appears in the summary header
    expect(screen.getByText(/2,317\.68/)).toBeInTheDocument()
    server.close()
  })
})
```

**Step 7b — implement** `src/features/subscriptions/SubscriptionsPage.tsx`. Reuse: `DataTable`, `FilterPill` + `MultiSelectFilterContent` from `@/shared/filters`, `Badge` (tone from `STATE_TONE`), the MXN formatter pattern from `VenuesPage.tsx:37-47`. Columns: **Venue** (name + slug + owner — `Link` to `/venues/:venueId` like `VenuesPage.tsx:233-248`), **Plan** (`planTier` Badge), **Estado** (`humanizeState` Badge with `STATE_TONE`), **MRR** (right-aligned MXN, `—` when 0), **Renovación** (`currentPeriodEnd` via `formatDate` from `@/shared/lib/datetime`, or trial end). Summary header = a small KPI strip reading `useSubscriptionOverview()` counts + `mrr.total`. State filter = `Set<SubscriptionState>` applied client-side over `useVenueSubscriptions().data` (same in-memory filter approach as `VenuesPage.tsx:213-223`). Skeleton:
```tsx
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ColumnDef } from '@tanstack/react-table'
import { Badge } from '@/shared/ui/Badge'
import { DataTable } from '@/shared/data-table/DataTable'
import { FilterPill, MultiSelectFilterContent, type MultiSelectOption } from '@/shared/filters'
import { QueryError } from '@/shared/components/QueryError'
import { formatDate } from '@/shared/lib/datetime'
import { useSubscriptionOverview, useVenueSubscriptions } from './use-subscriptions'
import { humanizeState, STATE_TONE, type SubscriptionState, type SuperadminVenueSubscription } from './types'

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 })
const NUM = new Intl.NumberFormat('es-MX')

const STATE_OPTIONS: MultiSelectOption<SubscriptionState>[] = [
  { value: 'active', label: 'Activa' }, { value: 'trial', label: 'En prueba' }, { value: 'canceling', label: 'Por cancelar' },
  { value: 'past_due', label: 'Pago vencido' }, { value: 'suspended', label: 'Suspendida' }, { value: 'canceled', label: 'Cancelada' }, { value: 'none', label: 'Sin plan' },
]

export function SubscriptionsPage() {
  const overview = useSubscriptionOverview()
  const venues = useVenueSubscriptions({}) // load all; filter in-memory
  const [states, setStates] = useState<Set<SubscriptionState>>(new Set())

  const filtered = useMemo(() => {
    const rows = venues.data ?? []
    return states.size > 0 ? rows.filter(r => states.has(r.state)) : rows
  }, [venues.data, states])

  const columns = useMemo<ColumnDef<SuperadminVenueSubscription, unknown>[]>(() => [
    { id: 'venue', header: 'Venue', accessorFn: r => `${r.name} ${r.slug}`,
      cell: ({ row }) => (
        <Link to={`/venues/${row.original.venueId}`} className="block min-w-0">
          <p className="truncate text-[13.5px] font-semibold text-[var(--ink)]">{row.original.name}</p>
          <p className="truncate text-[10.5px] text-[var(--ink-faint)]">{row.original.owner.email ?? 'sin owner'}</p>
        </Link>
      ) },
    { id: 'plan', header: 'Plan', accessorFn: r => r.planTier ?? '', cell: ({ row }) => <Badge tone="accent">{row.original.planTier ?? '—'}</Badge> },
    { id: 'state', header: 'Estado', accessorFn: r => r.state, cell: ({ row }) => <Badge tone={STATE_TONE[row.original.state]}>{humanizeState(row.original.state)}</Badge> },
    { id: 'mrr', header: () => <span className="block text-right">MRR</span>, accessorFn: r => r.mrr,
      cell: ({ row }) => row.original.mrr > 0 ? <p className="tabular text-right text-[13px] font-semibold">{MXN.format(row.original.mrr)}</p> : <span className="block text-right text-[var(--ink-faint)]">—</span>, sortingFn: 'basic' },
    { id: 'renewal', header: 'Renovación', accessorFn: r => r.currentPeriodEnd ?? r.trialEndsAt ?? '',
      cell: ({ row }) => { const d = row.original.currentPeriodEnd ?? row.original.trialEndsAt; return <span className="tabular text-[12px]">{d ? formatDate(d) : '—'}</span> } },
  ], [])

  const toolbar = (
    <FilterPill label="Estado" activeCount={states.size} onClear={() => setStates(new Set())}>
      <MultiSelectFilterContent title="Estado de suscripción" options={STATE_OPTIONS} selected={states} onApply={setStates} />
    </FilterPill>
  )

  const c = overview.data?.counts
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 md:px-8 lg:px-10 lg:py-10">
      <header className="mb-7">
        <p className="eyebrow">Catálogo</p>
        <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-[-0.025em] text-[var(--ink)] sm:text-[34px]">Suscripciones</h1>
        <p className="mt-2 text-[14px] text-[var(--ink-muted)]">Estado del Plan Avoqado Pro por venue, con MRR de la flota.</p>
      </header>

      {overview.isError && <QueryError className="mb-5" error={overview.error} context="cargar resumen" onRetry={() => overview.refetch()} />}

      {c && (
        <section aria-label="Resumen de suscripciones" className="mb-8 flex flex-col gap-px overflow-hidden rounded-[8px] border border-[var(--line-strong)] bg-[var(--line)] sm:flex-row">
          <article className="flex-[2] bg-[var(--canvas)] p-5">
            <p className="eyebrow">MRR total</p>
            <p className="mt-2.5 font-display tabular text-[32px] font-semibold text-[var(--ink)]">{MXN.format(overview.data!.mrr.total)}</p>
            <p className="mt-3 text-[12px] text-[var(--ink-muted)]">{NUM.format(c.active)} activas · {NUM.format(c.trial)} en prueba</p>
          </article>
          {[{ k: 'Por cancelar', v: c.canceling }, { k: 'Pago vencido', v: c.past_due }, { k: 'Suspendidas', v: c.suspended }, { k: 'Sin plan', v: c.none }].map(t => (
            <article key={t.k} className="flex-1 bg-[var(--canvas)] p-4">
              <p className="eyebrow">{t.k}</p>
              <p className="mt-2.5 font-display tabular text-[22px] font-semibold text-[var(--ink)]">{NUM.format(t.v)}</p>
            </article>
          ))}
        </section>
      )}

      <DataTable
        data={filtered}
        columns={columns}
        searchPlaceholder="Buscar por nombre o slug…"
        caption={`Tabla de ${filtered.length} suscripciones.`}
        initialSorting={[{ id: 'mrr', desc: true }]}
        pageSize={25}
        toolbar={toolbar}
        emptyState={{ title: venues.isLoading ? 'Cargando…' : 'Sin suscripciones', description: 'Los venues con Plan Pro aparecerán aquí.' }}
      />
    </div>
  )
}
```

**Step 7c — Verify:** `npx tsc --noEmit` + `npm run test:run -- src/features/subscriptions/SubscriptionsPage.test.tsx` → **1 passed** (Lagree HQ + Iyashi Spa rows + MRR `2,317.68` visible). Leave uncommitted.

---

#### Task 8 — Route + nav registration (`router.tsx`, `AppLayout.tsx`)

**Goal:** Make the page reachable at `/subscriptions` and add a nav entry under the `Catálogo` section.

**Step 8a — router** `src/app/router.tsx`: add the lazy import alongside the others (near `VenuesPage`, line 19) and a `<Route>` inside the protected `AppLayout` block (after `/venues` routes, ~line 167):
```tsx
const SubscriptionsPage = lazy(() =>
  import('@/features/subscriptions/SubscriptionsPage').then((m) => ({ default: m.SubscriptionsPage })),
)
// ...inside the protected <Route> group:
<Route path="/subscriptions" element={<SubscriptionsPage />} />
```

**Step 8b — nav** `src/shared/layouts/AppLayout.tsx`: in the `Catálogo` section (around line 61-65) add after the Venues item:
```tsx
{ to: '/subscriptions', label: 'Suscripciones', icon: BadgeDollarSign },
```
Import `BadgeDollarSign` (or another available `lucide-react` icon already imported in that file — verify the import list; `CreditCard` is already imported and is an acceptable reuse if a new import is undesirable).

**Step 8c — Verify:** `npx tsc --noEmit` (0 errors) confirms the route + nav wire up. Re-run the page test from Task 7 to confirm no regression:
```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-superadmin && npm run test:run -- src/features/subscriptions/
```
→ all subscriptions-feature tests pass (types 3 + api 4 + page 1 = **8 passed**). Leave uncommitted.

---

## Cross-repo & policy guards (apply throughout)

- **No API field removal** (cross-repo rule, `CLAUDE.md`): this plan **adds** new endpoints (`/superadmin/subscriptions/*`) and a new MCP tool. It does **not** touch `dashboard/superadmin.service.ts` or its response shape — the legacy mock (`subscriptionPlan: 'PROFESSIONAL'`, `billing.*`, `:351`/`:372-378`) and the `features/venues` slice stay intact. Verified by re-running existing venue tests if touched (we don't touch them).
- **MCP-sync** (mandatory, `CLAUDE.md` 🔴): the `subscription_overview` tool (Task 4) ships **in this plan**, not later. It is backed by the same `subscription.service.ts` as the HTTP endpoints — single source of truth.
- **Tenant isolation** (`critical-warnings.md`): the per-venue query is superadmin-scoped (returns all venues) and gated by `authorizeRole([SUPERADMIN])` at the namespace (`superadmin.routes.ts:42`). No `venueId` body/param trust.
- **Money = Decimal** (`critical-warnings.md`): `VenueFeature.monthlyPrice` is `Decimal`; we read it via `.toString()` → `Number()` only at the JSON boundary. Stripe `unit_amount` is integer cents. No float arithmetic on stored money beyond the documented `/100` and `/months` normalization (rounded to 2 dp).
- **Zod Spanish, shape-only** (`critical-warnings.md`): `subscription.schemas.ts` messages are Spanish; no business logic in the schema.
- **Migrations: none** — all fields already exist (`VenueFeature.active/endDate/suspendedAt/gracePeriodEndsAt/stripeSubscriptionId/stripePriceId/monthlyPrice` schema.prisma:2950-2980; `Venue.planTier` + `PlanTier` enum schema.prisma:220,5629). No `prisma migrate`, no Schema Map edit.
- **Tests `--runInBand`** for all server Jest runs (OOM otherwise). Frontend uses `vitest run` (`npm run test:run`).
- **Format/lint** after edits in each repo: `npm run format && npm run lint:fix` (server) / repo equivalent (superadmin).
- **DO NOT commit** — `develop` is shared with parallel LLMs. Leave every task's output uncommitted for the human to stage.

## Self-review — spec Part C + MCP requirement → task number

| Spec requirement (Part C / MCP) | Task |
|---|---|
| New `src/services/superadmin/subscription.service.ts` | Tasks 1–2 |
| New `src/controllers/superadmin/subscription.controller.ts` | Task 3 |
| New `src/routes/superadmin/subscription.routes.ts`, mounted under `/api/v1/superadmin/*` with `authorizeRole(SUPERADMIN)` | Task 3 (+ mount edit in `superadmin.routes.ts`) |
| Reuses `derivePlanState` from Part A (Plan 1) | Task 0 (shim if needed) + imported in Task 2 |
| `GET /api/v1/superadmin/subscriptions/overview` → `SubscriptionOverview` (counts, trialsEndingSoon ≤7d, total MRR) | Tasks 2 (`getSubscriptionOverview`) + 3 (route) |
| `GET /api/v1/superadmin/subscriptions/venues?state=&q=&page=` → paginated `SuperadminVenueSubscription[]`, filterable by state | Tasks 2 (`getSubscriptionsForSuperadmin`) + 3 (route + schema) |
| MRR monthly-normalized (annual/12); 0 for non-active/trial | Task 1 (`monthlyMrrFromPrice`) + Task 2 (zeroing) |
| Legacy `dashboard/superadmin.service.ts` mock left untouched | Cross-repo guard (no task edits it) |
| MCP `subscription_overview` tool backed by same service (MCP-sync) | Task 4 |
| Frontend `src/features/subscriptions/` with own `api.ts` → `/superadmin/subscriptions/*` | Tasks 5 (types) + 6 (api + hooks) |
| Subscription column + state filter + summary header (counts + MRR) | Task 7 (`SubscriptionsPage`) |
| Reachable in the app (route + nav) | Task 8 |
| Edge: no Stripe sub → derive from VenueFeature, `currentPeriodEnd` null | Task 2 (test: "venue with NO PLAN_PRO" + "DB-only trial") |
| Edge: null owner fields tolerated, never throw | Task 2 (owner fallback `{ name: null, email: null }`); Stripe read wrapped in try/catch |
| Testing: 7-state derivation, overview counts + MRR (monthly + annual), `/venues` filtering, regression | Tasks 0, 1, 2 (server, `--runInBand`); 5, 6, 7 (frontend, MSW) |
