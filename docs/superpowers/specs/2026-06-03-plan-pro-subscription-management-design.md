# PLAN_PRO Subscription Management & Visibility — Design

> **Status:** Approved design (2026-06-03), pending implementation plans. **Builds on:** `2026-06-02-venue-base-subscription-design.md`
> (PLAN_PRO base subscription, live in prod) and `2026-06-03-subscription-lifecycle-emails-design.md` (Phase 1.5 emails). **Repos:** >
> `avoqado-server` (backend hub), `avoqado-web-dashboard` (client), `avoqado-superadmin` (superadmin).

## Goal

Make the **PLAN_PRO base subscription** (a) **manageable by the venue** in `avoqado-web-dashboard` (see current plan, cancel / reactivate,
manage payment, view invoices) and (b) **visible to superadmin** in `avoqado-superadmin` (who is subscribed / trialing / suspended / none,
with MRR) — replacing today's mock data, and **without rebuilding the billing UI that already exists** for à-la-carte features.

## Current state (audited 2026-06-03 against prod)

Prod: 60 venues, **all legacy** (0 PLAN_PRO, 0 trials). The client billing section already exists; the gaps below are about the **new base
plan** specifically.

**What already works (do NOT rebuild):**

- Client billing UI exists: `avoqado-web-dashboard/src/pages/Settings/Billing/` — `Subscriptions.tsx`, `History.tsx`, `PaymentMethods.tsx`,
  `Tokens.tsx`, `BillingLayout.tsx`. Route `settings/billing` (ADMIN + `billing:read`).
- Invoices/history (`GET /dashboard/venues/:venueId/invoices`), invoice retry, and payment methods (list/add/remove/set-default) **already
  work for PLAN_PRO automatically** (Stripe customer-level). No gap.
- PLAN_PRO appears in `getVenueFeatureStatus` because it is a real active `VenueFeature` — but as a **generic à-la-carte row**.

**Gaps (client):**

1. 🔴 **Dangerous unguarded cancel.** The à-la-carte "Cancelar" button is live for the real PLAN_PRO `VenueFeature`;
   `DELETE /features/:featureId` → `removeFeatureFromVenue` → `cancelSubscription()` cancels the Stripe sub **immediately**
   (`stripe.service.ts:697`). The existing guard (`Subscriptions.tsx:587`) only protects synthesized `grantedByBasePlan` rows, NOT PLAN_PRO.
   The cancel dialog copy says "until {endDate}" but the cancel is immediate → copy/behaviour mismatch.
2. No distinct **"current plan"** card — PLAN_PRO renders like CHATBOT etc. (`Subscriptions.tsx:568-610`).
3. **Renewal date is fabricated** client-side (`now()+1 month`, `Subscriptions.tsx:388-396`); never reads Stripe `current_period_end`.
4. **No `past_due` / `suspended` / grace status** — only trial/active/canceled (`Subscriptions.tsx:364-375`); the features API does not even
   return `suspendedAt` / `gracePeriodEndsAt` (`venueFeature.dashboard.service.ts:354-371`).
5. No **interval** (monthly vs annual) and no **IVA** shown (price is base ex-IVA only).
6. No **Stripe billing-portal** entry point in the Billing pages (endpoint exists, wired only in `TrialStatusBanner.tsx:114`).

**Gaps (superadmin):** `getAllVenuesForSuperadmin` (`dashboard/superadmin.service.ts`) never queries `VenueFeature` or `Venue.planTier`;
`subscriptionPlan: 'PROFESSIONAL'` and the whole `billing` block (`$299`, `paymentStatus:'PAID'`, fake `nextBillingDate`) are hardcoded mock
(`:351,:372-378`).

**Gap (MCP):** no MCP tool exposes PLAN_PRO subscription state.

**Permissions mismatch:** frontend route guards use `billing:*`; the backend billing endpoints check `venues:*` / `features:*` /
`payments:*`. To be aligned.

## Decisions (locked with product owner)

- **Client = Hybrid.** Rich in-app "current plan" card (real state) + **native cancel/reactivate using `cancel_at_period_end`** (end of
  period, correct copy) + guard the dangerous immediate-cancel; **delegate only card-update / compliance to the Stripe Customer Portal** (a
  button). Invoices/payment-methods stay as-is.
- **Superadmin = SEPARATE namespace.** New endpoints under `/api/v1/superadmin/*` (dedicated superadmin namespace, `src/routes/superadmin/`
  - `src/controllers/superadmin/` + `src/services/superadmin/`). **Do NOT extend** the legacy `/api/v1/dashboard/superadmin/venues` mock —
    it stays intact.
- **Client endpoints stay in `/dashboard/*`** (venue-scoped; not superadmin).
- **Permissions standardized on `billing:*`** for the client billing/plan endpoints (align front+back), registered per the permission-policy
  rule.

## Architecture

### Part A — Shared backend foundation (`avoqado-server`)

**A1. Base-plan state endpoint (client, venue-scoped).** New `GET /api/v1/dashboard/venues/:venueId/plan` → `venue.dashboard.controller` →
new `planState.service.ts`. Reads the `VenueFeature(code='PLAN_PRO')` and, when a `stripeSubscriptionId` exists, the Stripe subscription
(for `current_period_end`, `cancel_at_period_end`, interval, status). Returns the **PlanState** shape (see Data shapes). `state` is derived
by a shared pure helper `derivePlanState(venueFeature, stripeSub?)` reused by Part C.

**A2. Base-plan-aware cancel / reactivate (client).**

- `POST /api/v1/dashboard/venues/:venueId/plan/cancel` → set `cancel_at_period_end = true` on the Stripe subscription (end of period). The
  `VenueFeature` stays `active` until period end; record intent. Returns updated PlanState.
- `POST /api/v1/dashboard/venues/:venueId/plan/reactivate` → set `cancel_at_period_end = false`. Returns updated PlanState.
- These are the ONLY way to cancel the base plan.

**A3. Guard the à-la-carte delete.** `DELETE /api/v1/dashboard/venues/:venueId/features/:featureId` → if the feature's code is in
`PAID_PLAN_TIER_CODES` (i.e. PLAN_PRO), respond **400**
`{ error, message: 'Usa el flujo de plan (cancelar suscripción) para el plan base', useEndpoint: '/plan/cancel' }`. Kills the
immediate-cancel path for the base plan.

**A4. Permissions.** Standardize the plan/billing endpoints on `billing:*` (`billing:subscriptions:read`, `billing:subscriptions:manage`,
`billing:history:read`, `billing:payment-methods:read`, `billing:payment-methods:manage`). Register in `src/lib/permissions.ts`
(`INDIVIDUAL_PERMISSIONS_BY_RESOURCE` + `DEFAULT_PERMISSIONS` for OWNER/ADMIN + any `PERMISSION_DEPENDENCIES`), update routes + frontend
gates to the same strings, and pass `npm run audit:permissions`. Keep the old `venues:*`/`features:*` reachable via alias if any stored
overrides exist (bidirectional alias per the rename pattern).

### Part B — Client Hybrid UI (`avoqado-web-dashboard`)

A **"Tu plan"** card at the top of `Settings/Billing/Subscriptions` (fed by `GET /plan`):

- Shows: plan name, **price with IVA** (`$1,158.84/mes` or `$11,588.40/año`), interval, **status badge** (trial / active / past_due /
  suspended / grace / canceled / canceling), **trial end OR real renewal date** (from `currentPeriodEnd`), payment-method summary.
- Actions: **"Cancelar plan"** (calls `/plan/cancel`; confirmation explains access continues until `currentPeriodEnd`; correct copy) ·
  **"Reactivar"** (shown when `cancelAtPeriodEnd`; calls `/plan/reactivate`) · **"Actualizar método de pago"** → opens the Stripe Customer
  Portal (existing `/billing-portal` endpoint).
- **PLAN_PRO is removed from the generic à-la-carte list** (managed only from the "Tu plan" card). À-la-carte feature rows keep their
  existing cancel behaviour. Fix the cancel-dialog copy.
- New i18n keys in `locales/{es,en,fr}/billing.json`.

### Part C — Superadmin subscription visibility (separate namespace)

**Backend (`avoqado-server`), new + separate:**

- `src/routes/superadmin/subscription.routes.ts`, `src/controllers/superadmin/subscription.controller.ts`,
  `src/services/superadmin/subscription.service.ts`. Mounted under the dedicated `/api/v1/superadmin/*` namespace; guard
  `authorizeRole(SUPERADMIN)` (the namespace convention). Reuses `derivePlanState` from Part A.
- `GET /api/v1/superadmin/subscriptions/overview` → **SubscriptionOverview** (counts by state, trials ending in N days, total MRR).
- `GET /api/v1/superadmin/subscriptions/venues?state=&q=&page=` → paginated per-venue **SuperadminVenueSubscription** list, filterable by
  state.
- The legacy `dashboard/superadmin.service.ts` mock is **left untouched** (not extended).

**Frontend (`avoqado-superadmin`):** new feature `src/features/subscriptions/` with its own `api.ts` pointing to
`/superadmin/subscriptions/*` (separate from the legacy `venues` feature). A subscription **column + state filter** in `VenuesPage` (or a
small Subscriptions view) + a **summary header** (counts + MRR) fed by `/overview`.

### MCP (`avoqado-server/scripts/mcp/`)

New tool `subscription_overview` (and/or extend the existing venues tool) returning the aggregate + per-venue state, backed by the same
`subscription.service.ts`. Mandatory per the MCP-sync rule.

## Data shapes

```ts
// PlanState — GET /dashboard/venues/:venueId/plan
type PlanState = {
  hasPlan: boolean
  state: 'none' | 'trial' | 'active' | 'canceling' | 'past_due' | 'suspended' | 'canceled'
  planTier: 'GRATIS' | 'PRO' | 'PREMIUM' | 'ENTERPRISE' | null
  planName: string | null // "Plan Avoqado Pro"
  interval: 'month' | 'year' | null
  price: { base: number; gross: number; currency: 'MXN' } | null // base ex-IVA, gross incl. 16% IVA
  trialEndsAt: string | null // ISO
  currentPeriodEnd: string | null // ISO, real renewal/next-charge (Stripe)
  cancelAtPeriodEnd: boolean
  suspendedAt: string | null
  gracePeriodEndsAt: string | null
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null
  stripeSubscriptionId: string | null
}

// SuperadminVenueSubscription — GET /superadmin/subscriptions/venues
type SuperadminVenueSubscription = {
  venueId: string
  name: string
  slug: string
  planTier: PlanState['planTier']
  state: PlanState['state']
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  mrr: number // monthly-normalized gross MXN; 0 when not active/trial
  stripeSubscriptionId: string | null
  owner: { name: string | null; email: string | null }
}

// SubscriptionOverview — GET /superadmin/subscriptions/overview
type SubscriptionOverview = {
  counts: {
    active: number
    trial: number
    canceling: number
    past_due: number
    suspended: number
    canceled: number
    none: number
    total: number
  }
  mrr: { total: number; currency: 'MXN' }
  trialsEndingSoon: Array<{ venueId: string; name: string; trialEndsAt: string }> // next 7 days
}
```

## State derivation (`derivePlanState`, shared, pure)

Given the PLAN_PRO `VenueFeature` (`active, endDate, suspendedAt, gracePeriodEndsAt`) and optional Stripe subscription
(`status, cancel_at_period_end, current_period_end`):

1. No PLAN_PRO `VenueFeature` row → `none`.
2. `suspendedAt != null` → `suspended`.
3. `!active` → `canceled`.
4. `gracePeriodEndsAt != null && now < gracePeriodEndsAt` (or Stripe `status === 'past_due'`) → `past_due`.
5. `endDate != null && endDate > now` → `trial`.
6. `cancel_at_period_end === true` → `canceling` (still entitled until `current_period_end`).
7. otherwise → `active`.

`venueHasActiveBasePlan()` remains the canonical "entitled" boolean and is unchanged. MRR = gross monthly amount of the Stripe price (annual
normalized as `annual / 12`); `0` for non-active/trial states.

## Edge cases

- **No Stripe subscription** (e.g. a DB-only/comped trial): PlanState derives from the `VenueFeature` only; `currentPeriodEnd` null;
  cancel/reactivate return a clear error ("no hay suscripción de Stripe que cancelar").
- **No payment method**: `paymentMethod: null`; the "Actualizar método de pago" button still opens the portal.
- **Cancel then reactivate before period end**: `cancel_at_period_end` toggles; access never interrupted.
- **Suspended venue**: card shows `suspended` + a "reactivar/actualizar pago" CTA to the portal.
- **No-recipient / null fields** tolerated (return nulls, never throw).
- **Money** uses `Prisma.Decimal` server-side; amounts formatted gross IVA-inclusive (matches Stripe price).

## Out of scope (YAGNI — v1)

Plan change annual↔monthly UI (backend proration endpoints already exist), a dedicated full superadmin Subscriptions dashboard, persisting
`current_period_end` onto `VenueFeature` via webhook (v1 reads Stripe on demand), CFDI/factura generation, and an in-app "subscribe" entry
point for legacy venues (separate product decision).

## Testing

- **Backend unit:** `derivePlanState` for all 7 states; `GET /plan` shape (trial / active / canceling / suspended / none); cancel sets
  `cancel_at_period_end` (not immediate); reactivate clears it; guard returns 400 for PLAN_PRO on `DELETE /features/:id`; superadmin
  `/overview` counts + MRR (monthly + annual normalization); superadmin `/venues` filtering. Regression: à-la-carte feature delete still
  works; à-la-carte feature status unchanged.
- **Frontend:** "Tu plan" card renders each state; cancel flow copy matches `currentPeriodEnd`; reactivate appears only when canceling;
  portal button opens the URL; PLAN_PRO no longer in the à-la-carte list.
- `--runInBand` (OOM otherwise).

## Decomposition — 2 implementation plans

1. **Plan 1 — Client PLAN_PRO billing:** Part A (A1–A4) + Part B. Delivers self-service plan management end-to-end.
2. **Plan 2 — Superadmin visibility + MCP:** Part C + MCP tool (depends on Part A's `derivePlanState`).

## Cross-cutting rules

- **MCP sync** (mandatory): the `subscription_overview` tool ships in the same change as Part C.
- **No API field removal** (cross-repo rule): add the `subscription` object to superadmin responses; do not remove existing fields old
  clients read.
- **Permissions** registered + `npm run audit:permissions` green (Part A4).
- **Migrations**: none expected (all fields already exist on `VenueFeature` / `Venue`); if any added, `prisma migrate dev` + Schema Map
  rules.
- **Tenant isolation**: every query scoped by `venueId` (client) or superadmin-guarded (Part C).
