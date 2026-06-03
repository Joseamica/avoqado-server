# Phase 1 — Pro-Tier Trial Onboarding ($999 + IVA / mes, 30-day trial)

**Date:** 2026-06-02 **Status:** Approved for implementation planning **Repos affected:** `avoqado-server`, `avoqado-web-dashboard`

> **This is Phase 1 of a tiered pricing model** (Gratis $0 / Pro ~$999 / Premium ~$3,000 / Enterprise custom — see "Phasing & Roadmap" at
> the end). Phase 1 ships ONLY the **Pro** tier: every new venue starts a mandatory 30-day Pro trial with a card on file, then auto-charges
> $999 + IVA. The Gratis tier, downgrade/upgrade, Premium/Enterprise, add-on billing, and existing-venue migration are later phases, scoped
> at the end of this doc. Phase 1 is independently shippable and produces recurring revenue on its own.
>
> **Hybrid model decision:** card is mandatory at onboarding (captures the card for near-100% trial→paid conversion); the eventual escape
> valve is a downgrade to the Gratis tier (Phase 2), not skipping the card.

## Problem

Avoqado has no recurring revenue per venue. Premium add-ons (Chatbot, Loyalty, etc.) exist as `Feature`/`VenueFeature` subscriptions, but
the **base platform fee** — what every venue pays just to use Avoqado — does not exist. We need:

- Every new venue picks a plan at onboarding: **30-day free trial** OR **pay now with an intro discount** ($599 + IVA × 3 months, monthly).
  Monthly or annual.
- Default monthly price after any promo: **$999 MXN + IVA (16%) = $1,158.84**. Annual: **$9,990 + IVA** (2 months free).
- The venue must enter a card **up front** in every path; Stripe auto-charges at trial end (trial path) or immediately (pay-now path). No
  silent free-riders.
- Completing onboarding is **impossible without entering the card**.
- If the day-30 charge fails (after the existing 7-day grace period), the venue **drops to the basic feature set** — premium features (AI,
  advanced inventory, advanced reports, loyalty, etc.) lock, but basic operation and TPV/POS charging keep working so we never cut their
  ability to charge their own customers.

## Goals

1. Add a base subscription every venue must accept during onboarding.
2. Reuse the existing `Feature`/`VenueFeature` + Stripe + webhook machinery — no parallel billing system.
3. Card collected up front in all paths. Two choices at the plan step: (A) 30-day trial → auto-charge at trial end, or (B) pay now (no
   trial) with an intro discount. Monthly or annual interval in both.
4. Make the plan step structurally unskippable: last wizard step + no skip + backend hard-gate.
5. IVA handled correctly via Stripe Tax (16% line, proper breakdown).
6. Non-payment → premium features lock (drop to basic); basic operation + TPV charging unaffected; auto-recovers on payment. Enforced via
   existing `checkFeatureAccess` (no new flag or middleware).
7. Ship behind an env flag for clean rollback.

## Non-goals

- **No new parallel billing model.** The Pro plan is a `Feature` row (`PLAN_PRO`), reusing `VenueFeature`, not a new table.
- **No CFDI/factura generation.** Stripe Tax produces the IVA breakdown on the Stripe invoice; generating Mexican CFDI XML is out of scope
  (future work).
- **No other tiers in Phase 1.** Gratis/Premium/Enterprise and downgrade/upgrade are Phase 2/3 (roadmap at the end). Phase 1 only creates
  `PLAN_PRO`. The data model is made forward-compatible (`Venue.planTier` enum) so later tiers slot in without a migration.
- **No commission-by-tier.** The decreasing-commission idea (3.6→3.2→2.9) is undefined and is already MCC/`giro`-driven via
  `VenuePricingStructure`. It is a separate future project, not part of any SaaS-tier phase.
- **No change to premium add-on behavior.** Chatbot/Loyalty/etc. keep working exactly as today (à-la-carte `VenueFeature`).
- **No full ADMIN_SUSPENDED on non-payment.** Per product decision, non-payment drops the venue to the basic feature set (premium locked);
  TPV/charging and basic operation keep flowing. "Cobrar"/"Órdenes" are basic and never blocked.
- **No retroactive charging of existing venues.** They are never auto-charged. Their migration is a deliberate, consent-based, later phase
  (scoped at the end).

---

## Architecture — the base plan IS a `Feature`

Add one `Feature` row:

```
code: 'PLAN_PRO'
name: 'Plan Avoqado'
category: OPERATIONS
monthlyPrice: 999.00
stripeProductId / stripePriceId: created via sync-features-to-stripe
active: true
```

The venue's base subscription is a `VenueFeature` row pointing at this feature. This reuses, for free:

- `trialEndDate`, `endDate` (trial vs paid)
- `gracePeriodEndsAt`, `suspendedAt`, `paymentFailureCount`, `lastPaymentAttempt`
- `stripeSubscriptionId` / `stripeSubscriptionItemId` / `stripePriceId`
- Every Stripe webhook handler already wired in `stripe.webhook.service.ts`.

**The one behavioral difference:** on payment failure, deactivating the `PLAN_PRO` `VenueFeature` drops the venue to the basic set (premium
locks via `checkFeatureAccess`), whereas deactivating a premium add-on only removes that one feature. Same mechanism (`active = false`),
different blast radius — see "Access model & non-payment enforcement".

### Why a Feature row and not a dedicated `VenueSubscription` model

The trial/grace/suspend/webhook state machine is the hard part, and it already exists and is battle-tested on `VenueFeature`. A dedicated
model would re-implement all of it. The only cost of reuse is a `featureCode`-based branch in the webhook — cheap. YAGNI says reuse.

### Forward-compat for tiers

Phase 1 only creates the `PLAN_PRO` feature, but later tiers will be sibling feature codes: `PLAN_GRATIS` (no Stripe sub, $0),
`PLAN_PREMIUM` (~$3,000), plus `ENTERPRISE` (custom). To avoid a rename/migration later:

- Add a nullable `Venue.planTier` enum (`GRATIS | PRO | PREMIUM | ENTERPRISE`). In Phase 1 every newly-onboarded venue gets `PRO`. Existing
  venues stay `null` ("legacy / untiered") until their deliberate migration phase.
- The webhook keys on "the subscription's feature is a **paid plan tier**" (Phase 1: just `PLAN_PRO`; later also `PLAN_PREMIUM`), NOT a
  hard-coded single code. A paid-tier failure drops the venue to basic; premium add-ons (Chatbot, etc.) failing only remove that one
  feature.
- The Phase-2 tier→feature-code grouping + access resolver ("a capability is unlocked if the venue's tier bundles it OR it has an à-la-carte
  VenueFeature") layers on top without touching Phase 1's data.

---

## Wizard placement & enforcement

### Current wizard (all flags on)

| #   | id               | mandatory?    |
| --- | ---------------- | ------------- |
| 1   | businessInfo     | yes           |
| 2   | businessType     | yes           |
| 3   | entityType       | yes           |
| 4   | identity         | yes           |
| 5   | terms            | yes           |
| 6   | bankAccount      | yes           |
| 7   | paymentProviders | **skippable** |
| 8   | buyTpv           | **skippable** |

### New wizard

Insert the plan as the **last** step, with **no skip button**:

| #   | id               | mandatory?                   |
| --- | ---------------- | ---------------------------- |
| 1–6 | (unchanged)      | yes                          |
| 7   | paymentProviders | skippable → advances to next |
| 8   | buyTpv           | skippable → advances to next |
| 9   | **plan** (NEW)   | **mandatory, no skip**       |

Funnel rationale: show value first (connect online payments, buy a terminal), then ask for the card once the user is invested.

### Three-layer enforcement (can't finish without a card)

1. **No skip on the plan step.** Its only CTA is "Empezar 30 días gratis", which is the only action that calls `completeSetup`. The earlier
   optional steps' "Saltar" now advances toward the plan, never to completion.

2. **"Finish later" modal.** The global header "Finish later" button: if pressed while the plan step is not yet completed (no payment method
   captured), show a confirmation modal:

   > "Tu cuenta no se activará hasta que completes tu plan. ¿Pausar de todos modos?" — [Activar ahora] [Pausar de todos modos] "Pausar"
   > still lets them leave (we can't force a charge); it just makes the requirement explicit. This is the user-requested modal.

3. **Backend hard-gate (the real guarantee).** `completeV2Onboarding` rejects with `400` if
   `OnboardingProgress.v2SetupData.plan.paymentMethodId` is missing. Even if the frontend is bypassed, onboarding cannot complete without a
   card on file. This is the source of truth; the modal is only UX.

   **Note on the storage key:** the plan data is stored under a **stable semantic key `plan`** (i.e. `v2SetupData.plan`), NOT a positional
   `stepN` key. The existing wizard derives numeric keys from a step's visible position (`step{currentStep + 2}`), which shifts depending on
   which optional steps (`paymentProviders`, `buyTpv`) are flag-enabled. Keying the plan by position would make the backend gate brittle.
   The plan step persists via a dedicated call that writes `v2SetupData.plan = { paymentMethodId, acceptedAt }`, independent of where the
   step sits in the order.

---

## Billing mechanics

### Pricing matrix & plan options (Pro tier, Phase 1)

The plan step offers a **billing-interval toggle** and a **two-path choice**. Card is mandatory in all paths (captured up front).

| Interval    | Path A — "Empezar gratis"                                 | Path B — "Pagar hoy y ahorrar"                                                                |
| ----------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Mensual** | 30-day trial → then **$999 + IVA/mes**                    | No trial → **$599 + IVA/mes los primeros 3 meses**, luego $999/mes                            |
| **Anual**   | 30-day trial → then **$9,990 + IVA/año** (2 meses gratis) | No trial → **$9,990 + IVA/año** (el ahorro = 2 meses gratis; el cupón $599 NO aplica a anual) |

Stripe objects to seed (config, not architecture):

- `PLAN_PRO` Stripe Product with **two Prices**: `price_pro_monthly` (`interval: month`, MXN 999.00) and `price_pro_annual`
  (`interval: year`, MXN 9,990.00).
- One **Coupon** `INTRO_PRO_3M`: `amount_off: 40000` (MXN 400.00), `currency: mxn`, `duration: repeating`, `duration_in_months: 3`. Applied
  ONLY on the monthly pay-now path → $999 − $400 = $599/mo for 3 months, then reverts to $999 automatically. (With Stripe Tax, IVA applies
  to the discounted base: $599 + 16% = $694.84/mo during the promo.)

The exact numbers are seed values; the schema/code only needs to support "a tier has N prices + optional intro coupon." Future tiers
(Gratis/Premium) add their own prices the same way.

### Card capture (at the plan step)

The venue already exists by step 9 (`ensureVenueForOnboarding` creates it lazily at `status=ONBOARDING`). At the plan step:

1. Frontend requests a SetupIntent via a new endpoint `POST /onboarding/venues/:venueId/plan-setup-intent` →
   `getOrCreateStripeCustomer(venueId)` + `stripe.setupIntents.create({ customer, payment_method_types: ['card'], usage: 'off_session' })`.
   (Reuses the pattern of `createOnboardingSetupIntent`, but customer-scoped so the PM attaches to the venue's customer.)
2. Stripe Elements collects the card, confirms the SetupIntent client-side.
3. On success, the frontend persists the chosen plan into the wizard state under the stable `plan` key, independent of the step's numeric
   position: `v2SetupData.plan = { paymentMethodId, interval: 'monthly' | 'annual', payNow: boolean, acceptedAt }`.

### Subscription creation (at `completeSetup`)

The subscription is created at completion (not at the plan step) so the clock starts when onboarding completes and there are no orphan
subscriptions on abandoned wizards. The two paths differ only in trial + coupon:

```
// New helper: createPlanSubscription(opts) — a thin sibling of
// createTrialSubscriptions that supports interval + pay-now + coupon.
createPlanSubscription({
  venueId, customerId, paymentMethodId,
  tierCode: 'PLAN_PRO',
  interval,                 // 'monthly' | 'annual' → picks price_pro_monthly | price_pro_annual
  trialPeriodDays: payNow ? 0 : 30,
  coupon: (payNow && interval === 'monthly') ? 'INTRO_PRO_3M' : undefined,
  automaticTax: true,       // Stripe Tax → 16% IVA line
})
```

- **Path A (trial):** `trial_period_days: 30`, no coupon. Stripe auto-charges at day 30 at the interval's price.
- **Path B (pay-now):** `trial_period_days: 0` → first invoice charged immediately. Monthly adds the `INTRO_PRO_3M` coupon ($599×3); annual
  just charges $9,990 (already discounted).

**Stripe Tax** on every path: `automatic_tax: { enabled: true }`. The venue's Stripe customer needs a Mexican address
(`customer.address.country = 'MX'` + state/zip from the fiscal data captured in earlier wizard steps). Stripe computes 16% IVA: e.g. monthly
full = $999 + $159.84 = $1,158.84; monthly promo = $599 + $95.84 = $694.84.

`createTrialSubscriptions` stays as-is for premium add-ons. The new `createPlanSubscription` wraps the same Stripe-call core but adds the
interval/coupon/`automatic_tax` options — keeping add-on behavior untouched.

### Trial → paid

Day 30: Stripe auto-charges the card. Existing webhooks (`customer.subscription.updated`, `invoice.payment_succeeded`) already flip the
`VenueFeature` from trial to paid (`endDate` null, `active` true). No new code.

---

## Access model & non-payment enforcement → drop to basic

The access model is **binary** in Phase 1: an active paid base plan (or trial) unlocks ALL premium capabilities; without one, the venue
falls back to the **basic** capability set. There is NO dashboard write-lock and NO new venue flag — enforcement reuses the existing
`checkFeatureAccess` machinery.

### The basic / premium line already exists

"Basic" capabilities are the ones NOT gated by `checkFeatureAccess` today: orders, payments/charging, basic menu, basic reports, customers,
shifts, split, receipts, payment links. These **always work** (dashboard + TPV) — they are the floor and are never blocked. Critically,
**TPV "Cobrar" and "Órdenes" are basic and must NEVER be blocked** — cutting a merchant's ability to charge their own customers kills their
business, drives churn, and costs Avoqado its transaction revenue.

"Premium" capabilities are exactly the ones `checkFeatureAccess` already gates: AI chat, advanced inventory, advanced reports, loyalty,
reservations, commissions, reviews, etc. These are hidden/locked when the venue has no active paid plan.

### The one change to `checkFeatureAccess`

Add a **blanket grant**: a premium feature is accessible if

```
venue has an active paid base plan (PLAN_PRO active, or in trial)
  OR venue has an active à-la-carte VenueFeature for that specific feature  // today's behavior, backward-compat
  AND the feature is not flagged ALWAYS_ADDON                               // see below
```

So paying the base plan unlocks everything premium at once — no per-feature à-la-carte purchases needed (which is why "contratar solo
inventario queda cubierto con los planes"). À-la-carte `VenueFeature` rows keep working for venues that bought individual features, and for
custom/Enterprise sales.

### Always-add-on features (forward-compat)

Some features must be contracted separately **even on the most expensive plan** (e.g. a future high-cost vertical module, or extra AI
tokens). A `Feature.bundlingMode` enum (`TIER_INCLUDED` | `ALWAYS_ADDON`) expresses this. `ALWAYS_ADDON` features are excluded from the
blanket grant — they always require their own active `VenueFeature`, regardless of plan tier. **Phase 1 does not need to add this field
yet** (no feature is ALWAYS_ADDON at launch); it's a Phase-2 addition documented here so the resolver is designed to respect it from the
start.

### Webhook (no new state, just deactivate)

In `stripe.webhook.service.ts`, on a `PLAN_PRO` subscription:

- `past_due` / `unpaid` AND `gracePeriodEndsAt` passed → set the `PLAN_PRO` `VenueFeature.active = false` (same as any feature on terminal
  failure). Because `checkFeatureAccess`'s blanket grant keys on "PLAN_PRO active", this **automatically** drops the venue to basic —
  premium features lock with zero extra code.
- `active` (payment recovered) → `VenueFeature.active = true` → premium unlocks automatically.

Premium add-ons (Chatbot à-la-carte, etc.) behave exactly as today. The grace period (7 days) is unchanged — the drop to basic only happens
after grace.

### Frontend reflection

`use-access` already resolves feature access from the same source. When premium is locked:

- Premium nav items / pages are **hidden or shown locked** with an upsell ("Reactiva tu plan Avoqado para usar esta función") linking to
  billing.
- Basic features render and work normally — the merchant keeps operating.
- The TPV applies the same gating: premium TPV functions (e.g. courtesy/comp, advanced reports, remote commands) lock, but
  "Cobrar"/"Órdenes" stay on.

### Commission % is informational only

The plan UI may display a transactional commission rate (e.g. "3.2%") as a value-prop. It is **purely informational** — the real per-venue
rate is assigned by a superadmin (MCC/`giro`-driven via the existing `VenuePricingStructure`). The tier/plan system does NOT set, calculate,
or enforce commission.

---

## Failure / edge-case matrix

| Scenario                                                           | Behavior                                                                                                                                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card declined at SetupIntent (plan step)                           | Stripe Elements shows the error inline; step cannot advance; no subscription.                                                                                     |
| User clicks "Finish later" before plan                             | Confirmation modal; if they confirm, onboarding paused (not completed), no subscription, venue stays `ONBOARDING`.                                                |
| Frontend bypassed, `completeSetup` called w/o paymentMethodId      | Backend `400`, onboarding not completed.                                                                                                                          |
| Day-30 charge succeeds                                             | Webhook flips trial→paid; nothing else.                                                                                                                           |
| Day-30 charge fails                                                | Existing grace period (7 days). During grace, premium stays unlocked; dunning emails via existing flow.                                                           |
| Grace period expires unpaid                                        | Webhook sets `PLAN_PRO` `VenueFeature.active=false` → `checkFeatureAccess` drops venue to basic (premium locked). Basic + TPV charging unaffected.                |
| Venue pays after dropping to basic                                 | `invoice.payment_succeeded` → `VenueFeature.active=true` → premium unlocks automatically.                                                                         |
| Venue connected MP/Stripe (step 7) but skipped, no card            | Cannot happen — plan step (9) is after and mandatory.                                                                                                             |
| Premium add-on payment fails (e.g. Chatbot)                        | Unchanged — only that feature deactivates; base plan + dashboard untouched.                                                                                       |
| Venue already has a PLAN_PRO VenueFeature (re-run / double-submit) | `createPlanSubscription` reuses the existing subscription instead of creating a duplicate (same idempotency guard `createTrialSubscriptions` already implements). |

---

## Backend changes (summary)

| File                                                               | Change                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                             | Add `Venue.planTier` (nullable enum `GRATIS\|PRO\|PREMIUM\|ENTERPRISE` — Phase 1 sets `PRO` on new venues, existing stay `null`). Migration via `prisma migrate dev`. One field, no new model. (No `dashboardReadOnly` — enforcement is via `checkFeatureAccess`, not a flag.)                                                                                                                                                     |
| `scripts/sync-features-to-stripe.ts` (or a seed)                   | Add `PLAN_PRO` feature ($999) + create its Stripe product with **two prices** (`price_pro_monthly` $999/mo, `price_pro_annual` $9,990/yr) + the `INTRO_PRO_3M` coupon ($400 off, 3 months).                                                                                                                                                                                                                                        |
| `src/services/stripe.service.ts`                                   | Add `createPlanSubscription({ venueId, customerId, paymentMethodId, tierCode, interval, trialPeriodDays, coupon?, automaticTax })` — sibling of `createTrialSubscriptions` supporting interval (monthly/annual price), pay-now (`trialPeriodDays: 0`), intro coupon, and `automatic_tax: { enabled: true }`. `createTrialSubscriptions` unchanged for add-ons. Add `createPlanSetupIntent(venueId)` (customer-scoped SetupIntent). |
| `src/controllers/onboarding.controller.ts`                         | New `POST /onboarding/venues/:venueId/plan-setup-intent`. Hard-gate in `completeV2Onboarding`: reject if no `v2SetupData.plan.paymentMethodId`. Create the `PLAN_PRO` trial subscription on completion.                                                                                                                                                                                                                            |
| `src/routes/onboarding.routes.ts`                                  | Register the setup-intent route (env-gated by `ENABLE_VENUE_BASE_SUBSCRIPTION`).                                                                                                                                                                                                                                                                                                                                                   |
| `src/services/onboarding/onboardingProgress.service.ts`            | Type + parse helper for the stable `plan` key in `v2SetupData` (`paymentMethodId`, `interval`, `payNow`, `acceptedAt`).                                                                                                                                                                                                                                                                                                            |
| `src/services/stripe.webhook.service.ts`                           | On `PLAN_PRO` grace-expiry → deactivate its `VenueFeature` (drops to basic automatically); on recovery → reactivate. Premium add-ons unchanged.                                                                                                                                                                                                                                                                                    |
| `src/middlewares/checkFeatureAccess.middleware.ts` (+ its service) | Add the **blanket grant**: an active paid base plan (or trial) grants all premium features, except those flagged `ALWAYS_ADDON`. À-la-carte grants unchanged.                                                                                                                                                                                                                                                                      |

## Frontend changes (summary)

| File                                         | Change                                                                                                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/Setup/steps/PlanStep.tsx` (NEW)   | Plan step: **Mensual/Anual toggle** + **two CTAs** ("Empezar 30 días gratis" / "Pagar hoy y ahorrar"), Stripe Elements card capture via the new SetupIntent, no skip. Shows live price + IVA per selection.                       |
| `src/pages/Setup/SetupWizard.tsx`            | Append `plan` step LAST (env-gated). Modal on "Finish later" when plan incomplete.                                                                                                                                                |
| `src/pages/Setup/types.ts`                   | Add `plan?: { paymentMethodId?: string; interval?: 'monthly' \| 'annual'; payNow?: boolean; acceptedAt?: string }` to `SetupData`.                                                                                                |
| `src/services/setup.service.ts`              | `planSetupIntent(venueId)` method.                                                                                                                                                                                                |
| `use-access` / sidebar / billing banner      | When premium is locked (no active paid plan): hide or lock premium nav/pages with an upsell ("Reactiva tu plan") → billing. Basic features render normally. Same gating in TPV (premium TPV functions lock; Cobrar/Órdenes stay). |
| `src/locales/es/setup.json`, `en/setup.json` | Plan step + modal strings.                                                                                                                                                                                                        |

---

## Rollout

- Env flag `ENABLE_VENUE_BASE_SUBSCRIPTION` (backend) + `VITE_ENABLE_VENUE_BASE_SUBSCRIPTION` (frontend). When off: no plan step, no
  hard-gate, no plan step, no blanket premium grant — wizard behaves as today.
- **Ops prerequisites (one-time, before flipping on in prod):**
  1. Enable Stripe Tax in the Stripe dashboard + register MX tax settings.
  2. Run the seed to create the `PLAN_PRO` Stripe product, its two prices (monthly $999 / annual $9,990), and the `INTRO_PRO_3M` coupon.
- Existing venues (already onboarded) are **not** retroactively charged by this change — they have no `PLAN_PRO` VenueFeature and stay
  `planTier = null` (legacy/untiered, behaves as today). Their deliberate, consent-based migration is its own later phase — see
  "Existing-venue migration" below.

---

## Testing strategy

### Unit (backend)

- `createPlanSubscription` (mock Stripe): trial path → `trial_period_days: 30`, no coupon, monthly price. Pay-now monthly →
  `trial_period_days: 0` + `INTRO_PRO_3M` coupon + monthly price. Pay-now annual → no trial, annual price, NO coupon. All paths pass
  `automatic_tax: { enabled: true }`.
- `completeV2Onboarding` rejects with 400 when `v2SetupData.plan.paymentMethodId` missing; on success creates the right `PLAN_PRO` sub for
  the chosen `interval`/`payNow` combination.
- Webhook: `past_due` + grace expired on a `PLAN_PRO` sub → deactivates its `VenueFeature`; `active` → reactivates. A premium add-on failure
  deactivates only that add-on, NOT the base plan.
- `checkFeatureAccess` blanket grant: venue with active `PLAN_PRO` (or trial) → a premium feature (e.g. `INVENTORY`) resolves accessible
  WITHOUT an à-la-carte row; with `PLAN_PRO` inactive → same premium feature resolves locked, while a basic capability is unaffected; an
  `ALWAYS_ADDON` feature stays locked even with `PLAN_PRO` active unless it has its own `VenueFeature`.

### Integration / E2E

- Full wizard via API (the pattern proven in the payment-providers session), four variants: {monthly, annual} × {trial, pay-now}. Assert the
  resulting `PLAN_PRO` VenueFeature matches (trial path → `trialEndDate ≈ now + 30d`; pay-now → no trial, charged immediately; monthly
  pay-now → coupon applied).
- Complete without paymentMethodId → 400.
- Simulate `invoice.payment_failed` past grace (Stripe CLI / fixture) → assert the venue drops to basic: a premium endpoint (e.g. inventory)
  returns 403/locked, a basic endpoint (orders) still 200, and a TPV charge still 200.

### Manual QA (real Stripe test mode)

- Trial path: test card → complete → verify trialing subscription + tax line in Stripe ($999 + $159.84 monthly, or $9,990 + IVA annual).
- Pay-now monthly: verify immediate charge of $599 + $95.84 = $694.84, coupon shows "3 months remaining", reverts to $999 after.
- Use Stripe's "fail at renewal" test card to drive the failure path.

---

## Phasing & Roadmap

Phase 1 (this spec) is independently shippable. Later phases layer on top without re-architecting; each gets its own brainstorm → spec →
plan cycle.

| Phase                                                | Scope                                                                                                                                                                                                                                                                                                     | Depends on                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **1 (this spec)**                                    | Pro-tier trial onboarding: mandatory card → 30-day Pro trial → auto-charge $999+IVA. Non-payment drops to basic via `checkFeatureAccess`. `Venue.planTier` enum added (new venues = `PRO`).                                                                                                               | —                           |
| **1.5 — Cross-client enforcement (android/iOS/TPV)** | Per-app UX for the gate (see "Cross-client enforcement" below): hide locked premium features + upsell + graceful 403 handling; audit that premium endpoints those apps hit are `checkFeatureAccess`-gated. The backend gate from Phase 1 already blocks them at the API level; this is the client polish. | Phase 1                     |
| **2 — Gratis tier + tier mobility**                  | `PLAN_GRATIS` ($0, no Stripe sub), Gratis limits enforcement (≤5 staff, 10 payment-links/mo, 1 venue/terminal), downgrade Pro→Gratis (cancel Stripe sub, keep card on file) + upgrade. Tier→feature-code grouping + access resolver. Gratis exempt from any lock.                                         | Phase 1                     |
| **3 — Premium + Enterprise**                         | `PLAN_PREMIUM` (~$3,000: AI, analytics, serialized inventory, commission payout, multi-venue), Enterprise/white-label custom pricing via `VenuePricingStructure`.                                                                                                                                         | Phase 2                     |
| **4 — Add-on billing**                               | KDS extra device, kiosk, extra locations, AI-token overage (`TokenPurchase` exists). Billed on top of any tier (Square model).                                                                                                                                                                            | Phase 2                     |
| **Existing-venue migration**                         | Deliberately assign current venues to tiers (see below).                                                                                                                                                                                                                                                  | Phase 2 (Gratis must exist) |
| **Later — commission by tier**                       | Decreasing processing commission per tier. Undefined; MCC/`giro`-driven via `VenuePricingStructure`. Separate project.                                                                                                                                                                                    | Phases 1–3                  |

## Cross-client enforcement (the gate is client-agnostic)

**Enforcement lives in the backend `checkFeatureAccess` middleware, on the API.** All clients — web dashboard, `avoqado-android`,
`avoqado-ios`, `avoqado-tpv` — call `/api/v1/`, so a premium endpoint returns `403` to every client when the venue has no active base plan.
**This is the authoritative, single-point enforcement: a non-paying venue cannot use premium functions from ANY app**, because the API
rejects the call regardless of which client made it. Hiding a feature only in the web UI would let android bypass it — so the gate must stay
at the API.

**Basic stays on everywhere.** `avoqado-android`/`-ios`/`-tpv` are primarily basic POS (orders, menu, tables, charging) — all basic, never
blocked. Only their premium surfaces (e.g. advanced inventory, advanced reports) lock.

**Per-client UX is Phase 1.5** (own brainstorm → spec → plan per repo):

- Audit which premium endpoints each app calls; ensure each is wrapped with `checkFeatureAccess` so the blanket grant/drop-to-basic actually
  applies (a premium capability on an ungated endpoint would escape the gate).
- App-side: hide/lock the premium feature with an upsell ("Reactiva tu plan") instead of surfacing a raw 403.
- **`avoqado-android` caveat:** per `.claude/rules/permissions-policy.md`, android consumes role-string sets via `RoleManager`, NOT the
  feature/permission arrays. It needs new plumbing to read the venue's plan/feature-access state (e.g. a field on the login/venue payload)
  before it can hide premium UI. The API 403 protects it regardless; this is purely UX.

## Existing-venue migration (planned, not Phase 1)

There are already venues in production (some long-onboarded, some with à-la-carte `VenueFeature` subscriptions). They must be assigned to a
tier eventually — but with a hard constraint:

> **Existing venues are NEVER auto-charged.** They never consented to $999/mo. Any move to a paid tier requires explicit opt-in (add card +
> accept). Charging without consent = chargebacks + churn + reputational damage.

### Sequencing

This migration **depends on the Gratis tier existing (Phase 2)** — that's the only safe default destination. Until then, existing venues
stay `planTier = null` (legacy/untiered) and behave exactly as today; the tier system applies to NEW venues only. So the migration runs
**after Phase 2**, deliberately.

### Mechanism (to be specced in its own doc)

1. **Default grandfather → Gratis.** Bulk-assign all `planTier = null` venues to `GRATIS` (no charge, keep current capabilities or apply
   Gratis limits — TBD per the decisions below). No card, no surprise.
2. **Superadmin assignment tool.** A superadmin screen to view every venue (its current activity, à-la-carte features, volume) and
   assign/override a tier, or send a "upgrade to Pro/Premium" offer.
3. **Opt-in upgrade campaign.** In-app prompt + email inviting legacy venues to start a Pro trial (card capture) — same flow as new-venue
   onboarding, but post-hoc. Only those who accept get charged.

### Open decisions for that phase (resolve when we get there, NOT now)

- **Default tier for legacy venues:** `GRATIS` (apply Gratis limits — risks degrading venues currently using more) vs a new
  `LEGACY_GRANDFATHERED` status that keeps their current capabilities free indefinitely. Leaning grandfathered to avoid breaking anyone.
- **À-la-carte reconciliation:** a venue already paying for Chatbot via `VenueFeature` — if upgraded to a tier that bundles Chatbot, do we
  cancel the standalone sub (avoid double-charge) or keep both? Likely: cancel the bundled one, credit the difference.
- **Whether Gratis limits apply retroactively** to grandfathered venues or only to net-new Gratis signups.

---

## Open questions

None blocking for Phase 1. Deferred product follow-ups:

1. CFDI / formal Mexican invoice generation from the Stripe invoice.
2. Existing-venue migration decisions (captured above; resolved when that phase starts, after Phase 2).
3. Final tier prices/limits for Gratis/Premium (Phase 2/3 brainstorms).
