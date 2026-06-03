# Phase 1 — Pro-Tier Trial Onboarding — EXECUTION STATE (resume here)

> **Purpose:** survive any context loss. If you're picking this up fresh, read THIS file + the plan
> (`2026-06-02-venue-base-subscription-phase1.md`) + the spec (`../specs/2026-06-02-venue-base-subscription-design.md`), then resume at
> **Task 9**. Everything below is verified ground truth as of 2026-06-02.

## How to execute (unchanged constraints)

- Use **superpowers:subagent-driven-development** — one subagent per task, fresh context, plan text pasted into each (don't make subagents
  read the plan file).
- **NO GIT COMMITS, NO BRANCHES.** Stay on `develop`. Every task leaves changes uncommitted in the working tree. Other LLMs commit in
  parallel — never stage/commit/revert their files.
- **Tests: `npx jest <path> --runInBand`** (suite OOMs otherwise).
- Feature is **OFF by default** (`ENABLE_VENUE_BASE_SUBSCRIPTION` not `true`) → all backend changes are inert until the flag is set. Safe to
  leave uncommitted indefinitely.
- Repos: backend `/Users/amieva/Documents/Programming/Avoqado/avoqado-server`, frontend
  `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`.
- This is the **V2 wizard (`/setup`, `src/pages/Setup/`)** only. V1 (`/onboarding`, `src/pages/Onboarding/`) is NOT touched.

## ✅ DONE — Tasks 1–8 (backend billing + access core). 22 unit tests passing.

| #   | What landed                                                                                                                                                                                                                                                               | Files (all uncommitted on develop)                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `enum PlanTier { GRATIS PRO PREMIUM ENTERPRISE }` + `Venue.planTier PlanTier?` (nullable)                                                                                                                                                                                 | `prisma/schema.prisma` (+ migration `prisma/migrations/20260602221733_add_venue_plan_tier/`)                                                       |
| 2   | Seed: `PLAN_PRO` Feature row + Stripe product + prices (lookup_keys `plan_pro_monthly` $999/mo, `plan_pro_annual` $9,990/yr) + coupon `INTRO_PRO_3M` ($400 off, 3mo). **Ran live against Stripe test mode.**                                                              | `scripts/seed-plan-pro.ts`                                                                                                                         |
| 3   | `createPlanSubscription({venueId,customerId,paymentMethodId,tierCode:'PLAN_PRO',interval,trialPeriodDays,coupon?,venueName?,venueSlug?})` → returns subId; idempotent; upserts VenueFeature; `automatic_tax:{enabled:true}`                                               | `src/services/stripe.service.ts` + `tests/unit/services/stripe.createPlanSubscription.test.ts` (3)                                                 |
| 4   | `createPlanSetupIntent(venueId)` — customer-scoped SetupIntent, returns client_secret                                                                                                                                                                                     | `src/services/stripe.service.ts` + `tests/unit/services/stripe.createPlanSetupIntent.test.ts` (1)                                                  |
| 5   | `parseV2Plan(v2SetupData)` → `{paymentMethodId,interval,payNow,acceptedAt}\|null` (stable `plan` key)                                                                                                                                                                     | `src/services/onboarding/onboardingProgress.service.ts` + `tests/unit/services/onboarding/v2Plan.test.ts` (3)                                      |
| 6   | `POST /onboarding/venues/:venueId/plan-setup-intent` → `{success,clientSecret}`, env-gated; `planSetupIntent` controller handler                                                                                                                                          | `src/controllers/onboarding.controller.ts`, `src/routes/onboarding.routes.ts`                                                                      |
| 7   | In `completeV2Onboarding`: destructure now pulls `progress`; **hard-gate** throws `BadRequestError` if `planEnabled && !planData?.paymentMethodId`; after venue exists → `getOrCreateStripeCustomer` + `createPlanSubscription` + `planTier:'PRO'` (try/catch, non-fatal) | `src/controllers/onboarding.controller.ts` + `tests/unit/controllers/completeV2.planGate.test.ts` (2)                                              |
| 8   | `venueHasActiveBasePlan(venueId)` + `PAID_PLAN_TIER_CODES=['PLAN_PRO']`; **blanket grant** wired into `checkFeatureAccess` AND `hasFeatureAccess` (active base plan/trial → all premium except plan-tier codes)                                                           | `src/services/access/basePlan.service.ts` + `src/middlewares/checkFeatureAccess.middleware.ts` + `tests/unit/services/access/basePlan.test.ts` (5) |

**Integration verified:** `npx jest <all 6 phase-1 backend test files> --runInBand` → **22/22 pass**. `npx tsc --noEmit` → MY files clean.

## Deviations / notes NOT in the plan (important, don't re-discover)

- **Task 2 seed:** original plan used `stripe.products.search` for idempotency, which is eventually-consistent and created a duplicate
  product on rapid re-run. The on-disk script was FIXED to anchor product resolution on the strongly-consistent monthly-price `lookup_key`.
  An orphan duplicate product was deactivated. Script is idempotent now.
- **Task 3 `createPlanSubscription`:** intentionally does NOT set `payment_behavior:'default_incomplete'` (which the older
  `createTrialSubscriptions` uses). Correct here because the card is pre-authenticated via the SetupIntent (`usage:'off_session'`), so the
  sub can charge off-session. Don't "fix" this.
- **Task 8:** existing `checkFeatureAccess.middleware.test.ts` (8 tests) still pass because they use `mockResolvedValueOnce` — the grant's
  second `findFirst` (inside `venueHasActiveBasePlan`) is unmocked → returns falsy → deny path preserved. `checkAnyFeatureAccess` was
  intentionally NOT modified (out of scope).
- **Stripe SDK:** `stripe@19.1.0`, instantiated with NO explicit apiVersion (`new Stripe(process.env.STRIPE_SECRET_KEY)`).
  `discounts:[{coupon}]` is the supported shape. Don't pin apiVersion.
- **Not mine:** a parallel LLM is building `terminal-migration.service` / `tpv-venue-migration` / `admin-mcp` / `sim-registration`. A TS
  error `terminal-migration.service has no exported member 'migrateStatus'` in `npx tsc --noEmit` is THEIRS, in-progress — ignore it; it's
  not in any Phase-1 file.

## ✅ DONE — Tasks 9, 10, 10b, 11 (added after the table above)

- **9 (webhook):** existing `handleSubscriptionUpdated` already deactivates the `PLAN_PRO` VenueFeature on terminal failure
  (`unpaid`/`canceled`) → drop-to-basic is automatic. NO production change. Regression test
  `tests/unit/services/stripe.webhook.planPro.test.ts` (4). Nuance: `past_due` does NOT deactivate (Stripe escalates to `unpaid` after its
  own retry window) — correct.
- **10 (/me/access):** grant applied in `getVenueFeatureMetadataForVenue` — actually `getFeatureMetadataForVenue` in
  `src/services/access/feature-metadata.service.ts` (the function feeding `/me/access` featureMetadata). Premium feature whose own state
  isn't already granting → upgraded to `ACTIVE` when base plan active. Test `tests/unit/services/access/access.basePlanGrant.test.ts` (3).
  White-label untouched.
- **10b (dashboard features endpoint — GAP found in Task 10):** the paywall UI reads `GET /dashboard/venues/:venueId/features` →
  `venueFeature.dashboard.service.ts:getVenueFeatureStatus` (NOT `/me/access`, NOT `features.service.ts`). Grant applied there:
  base-plan-granted premium features are synthesized into `activeFeatures` (with an additive `grantedByBasePlan: true` flag), removed from
  `availableFeatures`. Test `tests/unit/services/dashboard/features.basePlanGrant.test.ts` (4). **27 combined access tests pass.**
- **11 (env doc):** `ENABLE_VENUE_BASE_SUBSCRIPTION=false` documented in `.env.example`.

**Backend is COMPLETE. ~31 Phase-1 unit tests pass. `tsc` clean for all Phase-1 files** (the `terminal-migration`/`migrateStatus` TS error
is a parallel LLM's, not ours).

### Frontend follow-up surfaced by Task 10b (do in Task 14 or a polish task)

`avoqado-web-dashboard/src/pages/Settings/Billing/Subscriptions.tsx` (~line 628) shows a **Cancel** button on every `activeFeatures` card
gated only on `feature.active`. A base-plan-granted entry has `active:true` but NO `VenueFeature` row → clicking Cancel calls
`removeVenueFeature` → backend 404 (error toast, no corruption). Fix: hide Cancel (and ideally show an "Incluido en tu plan" badge) when
`feature.grantedByBasePlan === true`.

### Pre-existing latent issue (NOT ours, do not fix in Phase 1)

`GET /venues/:venueId/features` is registered TWICE in `src/routes/dashboard.routes.ts` (lines ~2235 reachable, ~2485 dead/shadowed).
Flagged for separate cleanup.

## ✅ DONE — Tasks 12–17 (frontend + verify). ALL PHASE-1 IMPLEMENTATION COMPLETE.

- **12 (FE plumbing):** `setupService.planSetupIntent(venueId)` + `SetupData.plan?:{paymentMethodId?,interval?,payNow?,acceptedAt?}`.
  `avoqado-web-dashboard/src/services/setup.service.ts`, `src/pages/Setup/types.ts`.
- **13 (PlanStep):** `src/pages/Setup/steps/PlanStep.tsx` — Mensual/Anual toggle + 2 CTAs (trial / pay-now) + Stripe Elements
  (`@stripe/react-stripe-js@5`, key `VITE_STRIPE_PUBLISHABLE_KEY`) against the SetupIntent; `onNext({plan:{...}})`. **Reads
  `res.data.data.clientSecret`** (nested envelope — codebase convention, matches `StripePaymentMethod.tsx`).
- **Backend fix (from Task 13):** `planSetupIntent` controller changed to return `{ success:true, data:{ clientSecret } }` (was flat) to
  match the codebase's nested setup-intent convention. `src/controllers/onboarding.controller.ts`.
- **14 (wizard):** `SetupWizard.tsx` — plan step appended LAST, **gated on `VITE_ENABLE_VENUE_BASE_SUBSCRIPTION==='true'`** (mandatory step
  MUST gate or users strand when backend off); props `venueId`(=`provisionalVenueId`)+`organizationId`; venue ensured for `'plan'`; "Finish
  later" `window.confirm` guard when `!data.plan?.paymentMethodId`. Frontend env var added to
  `.env.example`(false)+`.env`/`.env.local`(true).
- **14E (polish, from Task 10b):** `Subscriptions.tsx` hides "Cancel" + shows "Incluido en tu plan" badge when `feature.grantedByBasePlan`;
  `grantedByBasePlan?:boolean` added to `features.service.ts` type.
- **15 (i18n):** `plan.*` block in `locales/{es,en}/setup.json`.
- **16 (verify):** 33/33 Phase-1 backend tests pass (`--runInBand`); backend Phase-1 files `tsc` clean; frontend `tsc --noEmit` → 0 errors.

## ⚠️ ACTIVATION + remaining MANUAL QA (Task 17)

**To activate locally you MUST RESTART the backend dev server** — `tsx watch` does not reload `.env`, and the `/plan-setup-intent` route +
hard-gate register at startup under `process.env.ENABLE_VENUE_BASE_SUBSCRIPTION`. Both flags are already set to `true` locally (backend
`.env`, frontend `.env`+`.env.local`). Before restart, the route returns 404 (expected). After restart it returns 401 (auth-required =
registered).

**Manual browser QA (needs a human — Stripe Elements is an iframe + Stripe dashboard check):**

1. Restart backend dev server. Frontend (vite) picks up env on restart too.
2. `/signup` → new email → verify `000000` → walk the V2 wizard. Confirm a final **"Tu plan Avoqado"** step appears (Mensual/Anual toggle +
   card form + 2 CTAs, no skip).
3. Trial path: pick Mensual, enter Stripe test card `4242 4242 4242 4242`, "Empezar 30 días gratis" → completes → DB:
   `Venue.planTier='PRO'` + a `PLAN_PRO` VenueFeature with `endDate ≈ now+30d`. Stripe dashboard: `trialing` sub + tax line.
4. Pay-now monthly: "Pagar hoy y ahorrar" → Stripe charges $599+IVA=$694.84, coupon `INTRO_PRO_3M` "3 months remaining".
5. Annual: $9,990 sub.
6. Hard-gate: try to `/v2/complete` without the plan (e.g. via API) → 400.
7. Drop-to-basic: set the PLAN_PRO VenueFeature `active=false`/`suspendedAt` via psql → a premium dashboard feature locks, basic + TPV keep
   working.

## Ops prereqs before PROD (do NOT enable prod flag until done)

1. Enable Stripe Tax in the Stripe dashboard (MX) on the PROD Stripe account.
2. Run `scripts/seed-plan-pro.ts` against PROD Stripe (creates product/prices/coupon there).
3. Set `ENABLE_VENUE_BASE_SUBSCRIPTION=true` (backend) + `VITE_ENABLE_VENUE_BASE_SUBSCRIPTION=true` (frontend) together; deploy backend
   first.

## (historical map of the remaining tasks — now all done)

- **Task 9 (backend):** Verify the existing Stripe webhook deactivates the `PLAN_PRO` VenueFeature on terminal failure past grace (→
  drop-to-basic is automatic via Task 8's grant). Add a regression test `tests/unit/services/stripe.webhook.planPro.test.ts`. If the handler
  doesn't deactivate, add a minimal branch (set `active:false`/`suspendedAt`). NO venue flag.
- **Task 10 (backend):** Apply the blanket grant to the `/me/access` payload builder (likely `src/services/access/access.service.ts`) so the
  dashboard UI hides/shows premium consistently with the middleware. Use `venueHasActiveBasePlan` + `PAID_PLAN_TIER_CODES`.
- **Task 11 (backend, trivial):** Document `ENABLE_VENUE_BASE_SUBSCRIPTION=false` in `.env.example`. (Local `.env` may already have it
  `true` for QA.)
- **Task 12 (frontend):** `setup.service.ts` add `planSetupIntent(venueId)`; `Setup/types.ts` add
  `plan?:{paymentMethodId?,interval?:'monthly'|'annual',payNow?,acceptedAt?}` to `SetupData`.
- **Task 13 (frontend):** Create `src/pages/Setup/steps/PlanStep.tsx` — Mensual/Anual toggle + 2 CTAs ("Empezar 30 días gratis" / "Pagar hoy
  y ahorrar") + Stripe Elements (`@stripe/react-stripe-js`) against the SetupIntent; on confirm
  `onNext({ plan:{ paymentMethodId, interval, payNow, acceptedAt }})`. Verify Stripe Elements dep + `VITE_STRIPE_PUBLISHABLE_KEY` exist
  first.
- **Task 14 (frontend):** `SetupWizard.tsx` — append `{ id:'plan', component:PlanStep }` LAST in the steps builder; pass
  `venueId`/`organizationId` props (and add `'plan'` to the ensureVenue step-id check); "Finish later" modal guard when
  `!data.plan?.paymentMethodId`.
- **Task 15 (frontend):** `plan` i18n block in `locales/es/setup.json` + `en/setup.json`.
- **Task 16 (verify):** backend jest (the 6 phase-1 files + a new webhook test) `--runInBand`; backend + frontend `tsc --noEmit`; prettier
  the touched files.
- **Task 17 (verify):** E2E via the in-browser fetch pattern (signup → verify 000000 → save mandatory steps → planSetupIntent → confirm test
  card → saveStep plan → complete), 4 variants {monthly,annual}×{trial,payNow}; assert DB `planTier=PRO`+VenueFeature; hard-gate 400 without
  plan; drop-to-basic (premium 403, basic+TPV ok); Stripe dashboard QA (tax line, $599×3 coupon, $9,990 annual).

## Resume command for a fresh session

"Resume executing docs/superpowers/plans/2026-06-02-venue-base-subscription-phase1.md from Task 9, per the RESUME doc. Subagent-driven, on
develop, NO commits, tests --runInBand."
