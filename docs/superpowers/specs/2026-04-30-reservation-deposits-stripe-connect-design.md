# Reservation Deposits via Stripe Connect — Design Spec

**Status:** DRAFT v2.4 — incorporates Stripe Accounts v2 dashboard/liability constraint
**Author:** Jose Antonio Amieva (with Claude Code)
**Date:** 2026-04-30
**Repos affected:** `avoqado-server` (90%), `avoqado-web-dashboard` (10%)
**Out of scope (deferred):** `avoqado-android`, `avoqado-ios`

---

## Changelog

**v2.4 (2026-05-01) — Accounts v2 liability constraint:**
- ✅ **Express Dashboard rejected for this liability model:** Stripe Accounts v2 requires `dashboard=express` to use `losses_collector=application` and `fees_collector=application`. That would leave Avoqado responsible for connected-account negative balances. To preserve the original risk requirement, this spec now targets `dashboard=full`, `losses_collector=stripe`, and `fees_collector=stripe`.
- ✅ **Product tradeoff made explicit:** Avoqado can have lower platform liability or Express Dashboard UX, but not both in this configuration. v2.4 prioritizes liability/risk correctness over seamless Express UX.

**v2.3 (2026-04-30) — round 3 review fixes:**
- ✅ **Stripe Connect account model updated:** new connected accounts use **Accounts v2 / controller properties** with Full Dashboard access, not legacy `accounts.create({ type: 'express' })`. Stripe's Accounts v2 restrictions do not allow `dashboard=express` with `losses_collector=stripe`; Full Dashboard is required if Avoqado wants Stripe/connected account negative-balance responsibility.
- ✅ **Slot availability race fixed in spec:** availability pre-check remains a fast rejection, but the authoritative slot conflict check/lock must happen inside DB Tx1 with the reservation INSERT. No paid double-bookings from racing public reservations.
- ✅ **Money unit mismatch fixed:** min/max charge validation compares Stripe centavos to Stripe centavos only (`toStripeAmount(depositAmount)` vs `STRIPE_*_CHARGE_MXN_CENTS`).
- ✅ **`depositPaymentWindow` unit fixed:** migrate existing DB semantics from hours to minutes; backfill old values with `oldHours * 60`; update schema comment and UI validation to `[30, 1440]` minutes.
- ✅ **MoneyAnomaly idempotency fixed:** divergent webhook states commit `ProcessedStripeEvent + MoneyAnomaly` in the same transaction, with unique anomaly key, so Stripe retries do not spam alerts.
- ✅ **Chargeback/application-fee caveat added:** app-fee reversal on disputes is not assumed; it must be verified in Stripe test/live config via balance transactions and documented before production.
- ✅ **Account Links clarified:** generated on demand; stored URL is audit/debug only because account links are short-lived and single-use.
- ✅ **§9 aligned with §8.2:** paid-after-expiry/cancel is a `MoneyAnomaly` with immediate page, not a benign audit-only case.

**v2.2 (2026-04-30) — round 2 review fixes:**
- ✅ **P0 fix — poison events:** `INSERT ProcessedStripeEvent` + UPDATE Reservation now share **a single DB transaction**; rollback on any failure ensures Stripe retries see a clean slate. Previously, partial commits could leave a duplicate event row that silently no-op'd retries — payment captured, reservation never confirmed.
- ✅ **Zero-rows-updated semantics (§8.2):** explicit table classifying which divergent states (PAID + CANCELLED, FORFEITED + paid event, etc.) escalate to `MoneyAnomaly` with on-call alert vs. close as benign replays. New `MoneyAnomaly` table for paid-after-cancel / expired-after-paid anomalies.
- ✅ **P1 fix — pre-check merchant before reservation INSERT (§5 Phase 2):** if no active Connect account, return 422 immediately. No orphan PENDING rows blocking slots due to misconfiguration.
- ✅ **P1 fix — refund lifecycle separated (§7):** removed phantom `PENDING-REFUND` from `DepositStatus`. New fields on `Reservation`: `refundStatus`, `refundRequestedAt`, `refundProcessorRef`, `refundFailedReason`, `refundRetryCount`. New `RefundStatus` enum.
- ✅ **P1 — Express liability nuance (§3.1, §4.4, §12):** softened "Avoqado is not responsible" to "direct charges mitigate the primary chargeback balance path." Express `controller.losses.payments` configuration gate added as production prerequisite.
- ✅ **Adjustments:**
  - Webhook handler now verifies `session.payment_status === 'paid'` before confirming (defense even on card-only)
  - `expires_at` clamped to [30min, 24h] (Stripe rejects below 30min); settings UI rejects out-of-range
  - Reserves softened from "API-guaranteed" to "opt-in pending Stripe verification"; payout delay moved to an implementation-gated mitigation in v2.3
  - Apple Pay / Google Pay no longer described as automatic; treated as nice-to-have
  - Min/max charge env vars (`STRIPE_MIN_CHARGE_MXN_CENTS` pending verification, `STRIPE_MAX_CHARGE_MXN_CENTS` default $50k); production gate to confirm minimum value with Stripe MX

**v2 (2026-04-30):**
- ✅ **P0 fix:** Switched from destination charges to **direct charges**. Destination charges leave the platform exposed to refunds/chargebacks even with `on_behalf_of`. Direct charges put the PaymentIntent on the connected account, making the venue the merchant of record at the API level. v2.3 supersedes the earlier overstatement that this eliminates all Avoqado liability.
- ✅ Refund flow: explicit `refund_application_fee: true` (Stripe does NOT auto-refund app fees on direct charges).
- ✅ Webhook routing: `event.account` from verified payload, not inbound headers. Two logical webhook endpoints with separate signing secrets (platform vs Connect).
- ✅ State: derived `PAYMENT_PENDING` (no new enum value on `Reservation.status`); existing `status=PENDING + confirmedAt=null + depositStatus=PENDING` is the canonical state.
- ✅ Idempotency + two-phase pattern: Stripe API calls outside DB transactions; reconciliation cron catches orphans.
- ✅ Payout delay + reserves moved to Phase 1 (was deferred).
- ✅ Offboarding moved to Phase 3 (was deferred).
- ✅ Restricted MVP to `payment_method_types: ['card']`. OXXO/SPEI deferred.
- ✅ `depositExpiresAt` snapshot (don't recompute from settings).
- ✅ Schema corrections: `FORFEITED` already exists (don't add). Add `EXPIRED`, `DISPUTED`. Add `Reservation.depositExpiresAt`, `idempotencyKey`. `requirementsDue String[] @default([])`.
- ✅ Provider abstraction: `connectAccountId` lives in `providerCredentials` JSON; shadow column `providerMerchantId` indexed `@@unique([providerId, providerMerchantId])` for fast webhook routing.
- ✅ **Money math (§8.4):** bidirectional helper (`toStripeAmount` / `fromStripeAmount`) is the single boundary between Avoqado's `Decimal(10,2)` and Stripe's integer centavos. DB and business logic stay in Decimal; Stripe-shape is hidden behind helpers. `ROUND_HALF_UP` (SAT-aligned), application fee computed on cents (no float drift). New field `EcommerceMerchant.platformFeeBps` (basis points, default 100 = 1%).

---

## 1. Goal

Enable venues on Avoqado to require online payment (full prepayment or partial deposit) when a customer reserves through the public booking page. Payments must:

1. Land in the venue's **connected Stripe balance** (not Avoqado's platform balance) and pay out to the venue's bank account per the connected account payout schedule, with Avoqado collecting a configurable platform fee per transaction.
2. Put the venue on the **primary refund/chargeback balance path at the Stripe API level**. Avoqado remains exposed to negative-balance edge cases depending on `controller.losses.payments`; this must be verified before production. This is achieved via Stripe Connect **direct charges**, where the PaymentIntent and Charge live on the connected account.
3. Use Stripe-hosted onboarding launched from the Avoqado dashboard. Because the liability requirement takes priority, connected accounts use Stripe Full Dashboard access instead of Express Dashboard; venues may interact with Stripe directly for disputes, account settings, and compliance.
4. Be testable phase-by-phase without breaking existing flows (POS terminals, SaaS subscriptions, credit packs, payment links).

The feature is the missing piece between today's `ReservationSettings.depositMode` (already configurable in dashboard) and a working customer payment flow that actually charges money.

---

## 2. Context

### 2.1 What exists today

| Layer | Status |
|---|---|
| `Reservation.depositAmount`, `depositStatus`, `depositProcessorRef`, `depositPaidAt`, `depositRefundedAt` | ✅ Schema fields present |
| `DepositStatus` enum: `PENDING, CARD_HOLD, PAID, REFUNDED, FORFEITED` | ✅ Defined at `prisma/schema.prisma:7644-7650` |
| `ReservationSettings.depositMode/depositFixedAmount/depositPercentage/depositPartySizeGte/depositPaymentWindow` | ✅ Schema + dashboard UI |
| `calculateDepositAmount()` server-side function | ✅ Used in `reservation.public.controller.ts:225-229` |
| Public booking creates reservation with `depositStatus: 'PENDING'` | ✅ Works (but no payment is created) |
| Dashboard `ReservationSettings.tsx` configures all 4 modes (`none / card_hold / deposit / prepaid`) | ✅ Works |
| Existing webhook controller (`src/controllers/webhook.controller.ts`) | ⚠️ Always returns 200 even on processing errors (line 89-91). Breaks Stripe retry semantics for money flows. Must be fixed before MVP. |
| `EcommerceMerchant` model + Blumon ecommerce SDK + payment links | ⚠️ Implemented but UNTESTED in production. Zero rows in prod. Refactoring blast radius is near-zero. |

### 2.2 What is missing (the gap this spec fills)

1. **No PaymentIntent creation** for reservation deposits. `reservation.public.controller.ts` returns `depositRequired: true` but never creates a Stripe charge. Customer cannot pay.
2. **No Connect onboarding** for venues. Zero references to `stripe.accounts.*`, `accountLinks`, `application_fee` in repo.
3. **No webhook handler** for Connect events. Existing webhook controller only handles platform events (subscriptions, invoices).
4. **No expiry mechanism.** `depositPaymentWindow` exists in schema but is never consumed.
5. **No payment UI** in `PublicBookingPage.tsx` / `BookingConfirmation.tsx`.
6. **No forfeit / no-show fee logic.** `forfeitDeposit` and `noShowFeePercent` are configurable but no code reads them.
7. **No offboarding runbook.** When a venue churns from Avoqado, no documented process for handling pending refunds/disputes/payouts.

### 2.3 Adjacent systems (do NOT touch)

| System | Lives in | Why isolated from this spec |
|---|---|---|
| **POS terminal payments (Blumon TPV)** | `payment.tpv.service.ts`, `blumon-tpv.service.ts`, `VenuePaymentConfig` | Different model. Card-present, EMV chip, hardware terminals. Money already routes per venue via Blumon merchant ID. |
| **SaaS subscriptions** (venue pays Avoqado) | `stripe.service.ts`, `Venue.stripeCustomerId`, `STRIPE_SECRET_KEY` global env | Avoqado IS the merchant here. Direct Stripe Customer + Subscription, no Connect. Different webhook endpoint (see §10). |
| **Credit packs (public)** | `creditPack.public.service.ts:223` uses `stripe.checkout.sessions.create` (no `on_behalf_of`) | Currently routes to Avoqado's account. Has the SAME problem this spec solves but is OUT OF SCOPE — separate migration ticket. |
| **Payment links (Blumon ecommerce)** | `paymentLink.service.ts`, `blumon-ecommerce.service.ts` | Untested in production. Will be **refactored** in Phase 0 to use the new `IEcommerceProvider` abstraction, but functionality preserved. Regression tests required. |

### 2.4 Critical context: zero ecommerce data in production

**No venue has activated `EcommerceMerchant` in production.** Schema migrations are safe (no data to migrate). Refactoring `EcommerceMerchant` provider abstraction has near-zero blast radius. The Blumon-coupled code in `paymentLink.service.ts` can be safely refactored to provider-agnostic without breaking real users.

---

## 3. Architectural decisions

### 3.1 Q1 — Funds architecture (THE foundational decision)

**Decision:** Extend existing `EcommerceMerchant` model with **Stripe Connect** as a new provider. Create connected accounts with **Accounts v2 / explicit controller properties** and give venues Full Dashboard access. Use **direct charges** so the PaymentIntent and Charge live on the connected account.

**Hard tradeoff:** Stripe Accounts v2 requires `dashboard=express` accounts to use `defaults.responsibilities.losses_collector=application` and `fees_collector=application`. That means Express Dashboard makes Avoqado responsible for connected-account negative balances, which violates the original liability requirement. Therefore this spec chooses `dashboard=full`, `losses_collector=stripe`, and `fees_collector=stripe`. If product insists on Express Dashboard UX, the architecture must be re-reviewed as an Avoqado-liable risk model.

#### Why direct charges (not destination charges)

| Aspect | Direct charges | Destination charges (rejected) |
|---|---|---|
| Where PaymentIntent lives | **Connected account** | Platform account |
| Merchant of record at API level | **Connected account** | Platform |
| Refund debited from | **Connected account balance** | Platform balance (must use `reverse_transfer` to recover from venue) |
| Chargeback debited from | **Connected account balance** | Platform balance (platform must recover) |
| Stripe processing fees | Charged to connected account | Charged to platform |
| Application fee | Routed to platform via `application_fee_amount` | Same |
| API call style | `stripe.X.create({...}, { stripeAccount: acctId })` | `stripe.X.create({..., on_behalf_of, transfer_data})` (no header) |
| Webhook routing | Event delivered with `event.account` set to connected account | Event delivered with `event.account` empty |

For this product, direct charges are the **only correct option for the primary chargeback balance path**: refunds and chargebacks debit the venue's balance natively, and the venue is the merchant of record at the API level.

**Important nuance — direct charges do not eliminate ALL platform liability.** Stripe Connect gives the platform configurable but non-zero exposure to negative-balance scenarios on connected accounts. In Accounts v2, `defaults.responsibilities.losses_collector` maps to the legacy `controller.losses.payments` concept. This spec targets `losses_collector=stripe`, but Avoqado must still verify the actual account configuration before live charges and remains liable for negative balances on its own platform account.

What direct charges DO solve: they ensure Stripe always tries the **connected account first** for refunds and disputes, eliminating the destination-charges anti-pattern where the platform is debited as the primary path. In the destination-charges model, every refund goes through Avoqado first and we need `reverse_transfer` to recover. With direct charges, only the rare insufficient-funds edge case touches the platform.

**Production gate:** before first live charge, confirm with the Stripe account manager / Dashboard the actual `controller.losses.payments` configuration for the platform. Document the result in `docs/runbooks/stripe-connect-liability.md`. Do not ship to production with unknowns on this setting.

#### Accounts v2 / controller-property account shape

New accounts must be configured around explicit responsibility settings instead of opaque legacy account types:

```ts
// Pseudocode. Final exact SDK shape depends on the installed Stripe SDK
// version and Accounts v2 TypeScript support.
const account = await stripe.v2.core.accounts.create({
  country: 'MX',
  contact_email: merchant.contactEmail,
  business_type: onboardingInput.businessType, // 'company' | 'individual'
  controller: {
    dashboard: 'full',                          // required with losses/fees = stripe
    losses: { payments: 'stripe' },             // target: Stripe/connected account absorbs payment losses
    fees: { payer: 'stripe' },                  // target: Stripe collects fees from connected account
  },
  capabilities: {
    card_payments: { requested: true },
    transfers: { requested: true },
  },
  metadata: { venueId: merchant.venueId, channelName: merchant.channelName },
})
```

If the current `stripe` Node SDK lacks stable Accounts v2 support in this repo, implementation must either upgrade to the latest Stripe SDK/API version or document a deliberate v1 fallback. A fallback to `accounts.create({ type: 'express' })` is not allowed silently; it requires an explicit implementation note and re-review because it weakens control over `controller.losses.payments`.

**Alternatives considered and rejected:**
- ❌ Destination charges with `on_behalf_of` → makes the platform the **primary** path for refunds and chargebacks, requiring `reverse_transfer` for every recovery. Strictly worse than direct charges (this was the v1 spec's mistake).
- ❌ Single Avoqado account + manual payouts → legally Avoqado becomes "merchant of record" for venue services; CFDI/IVA complications with SAT.
- ❌ Per-venue Stripe credentials in `providerCredentials.stripeSecretKey` (no Connect) → requires venue to create Stripe account separately, no centralized onboarding UX, no `application_fee_amount` mechanism.


### 3.2 Q2 — MVP deposit modes

**Decision:** MVP supports `prepaid` (full payment) + `deposit` (partial). Defer `card_hold` to Phase 4+.

`prepaid` and `deposit` are the same code path with different `amount`. `card_hold` requires capture flow at check-in time AND Visa auths expire after 7 days, Amex after 31. Reservations made >7 days out break the auth model.

### 3.3 Q3 — Payment UI: Stripe Checkout (hosted), card-only in MVP

**Decision:** **Stripe Checkout (hosted)**, restricted to `payment_method_types: ['card']` in MVP.

Rationale:
- Native Connect support
- 3D Secure / SCA built-in
- Spanish localization automatic
- PCI scope stays out of Avoqado entirely
- **Wallets (Apple Pay / Google Pay):** Checkout hosted may show wallet buttons when the connected account, region, browser/device, and Stripe configuration align. **MVP does not depend on wallets**; card entry works for all customers even when wallets don't appear. Treat wallet visibility as a nice-to-have, not a guarantee.
- **Card-only in MVP** because OXXO/SPEI are async — they require `checkout.session.async_payment_succeeded/failed` handling and can settle days later, complicating reservation slot management. Defer async to Phase 4+.

### 3.4 Q4 — Expiry mechanism

**Decision:** Dual mechanism — Stripe `checkout.session.expired` webhook + cron job hourly safety net. `depositPaymentWindow` is stored in **minutes** and clamped to **30 min – 24h** in MVP (Stripe rejects `expires_at` values outside this range).

**Required migration:** current schema comment says `depositPaymentWindow Int? // hours to complete payment`. Phase 2 must change the semantic to minutes and backfill existing values:

```sql
-- Existing production data is assumed low/zero, but keep migration explicit.
UPDATE "ReservationSettings"
SET "depositPaymentWindow" = "depositPaymentWindow" * 60
WHERE "depositPaymentWindow" IS NOT NULL
  AND "depositPaymentWindow" BETWEEN 1 AND 24;
```

Then update the Prisma comment / app copy to `// minutes to complete payment`. Do not silently interpret old "2 hours" values as "2 minutes".

Effective expiry computation:
```ts
const STRIPE_EXPIRES_AT_MIN_SECONDS = 30 * 60      // 30 min — Stripe minimum
const STRIPE_EXPIRES_AT_MAX_SECONDS = 24 * 60 * 60 // 24h — Stripe maximum
const requestedSeconds = settings.depositPaymentWindow * 60 // depositPaymentWindow is minutes after migration
const effectiveSeconds = Math.min(
  Math.max(requestedSeconds, STRIPE_EXPIRES_AT_MIN_SECONDS),
  STRIPE_EXPIRES_AT_MAX_SECONDS,
)
const expiresAt = new Date(Date.now() + effectiveSeconds * 1000)
```

**Settings UI validation:** `ReservationSettings.depositPaymentWindow` must be in range [30, 1440] minutes. Reject persistence below or above. Display helper text: "Minimo 30 min, maximo 24 hrs (limites de Stripe)."

When customer abandons, `checkout.session.expired` fires → server cancels reservation → slot freed. Cron hourly catches webhook delivery failures.

`Reservation.depositExpiresAt` is **snapshotted** at creation time — never recomputed from current `ReservationSettings` (which may change between create and expiry).

### 3.5 Q5 — Provider selection UX

**Decision:** **(C) Hybrid.** Stripe self-service from venue dashboard; Blumon activation is superadmin-only. See §5 Phase 1 for UI states.

### 3.6 Reservation state model (refined per review)

**Decision:** **No new enum value on `Reservation.status`.** Use existing `status=PENDING + confirmedAt=null + depositStatus=PENDING` as the canonical pre-payment state. Expose `PAYMENT_PENDING` as a **derived state** in API responses and dashboard views.

Rationale: adding a new enum value would cascade through every overlap check, calendar query, slot conflict resolver, dashboard filter, metrics aggregation, and notification trigger. The reviewer flagged this risk explicitly. The canonical state is fully expressible with existing fields:

| Stage | `status` | `confirmedAt` | `depositStatus` | API/UI shows as |
|---|---|---|---|---|
| Reserved, awaiting payment | `PENDING` | `null` | `PENDING` | "PAYMENT_PENDING" |
| Reserved, no deposit required | `CONFIRMED` | not null | (NULL) | "CONFIRMED" |
| Deposit paid | `CONFIRMED` | not null | `PAID` | "CONFIRMED — deposit paid" |
| Deposit expired | `CANCELLED` | null | `EXPIRED` | "CANCELLED — payment expired" |
| Deposit refunded after cancel | `CANCELLED` | irrelevant | `REFUNDED` | "CANCELLED — refunded" |
| Forfeited (late cancel) | `CANCELLED` | irrelevant | `FORFEITED` | "CANCELLED — deposit forfeited" |

**Transition rules:**
- Reservation created with deposit required → `(PENDING, null, PENDING)`
- Webhook `checkout.session.completed` → `(CONFIRMED, now, PAID)`
- Webhook `checkout.session.expired` OR cron expiry → `(CANCELLED, null, EXPIRED)`
- Cancel within window with `forfeitDeposit=false` → refund → `(CANCELLED, _, REFUNDED)`
- Cancel outside window with `forfeitDeposit=true` → `(CANCELLED, _, FORFEITED)`

---

## 4. Money flow

### 4.1 Happy path (direct charges)

```
Customer pays $1,000 MXN deposit
        │
        ▼
stripe.checkout.sessions.create(
  {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [...],
    payment_intent_data: {
      application_fee_amount: 1000,    // ⭐ Avoqado's 1% (configurable)
      metadata: { reservationId, venueId, type: 'reservation_deposit' },
    },
    customer_email,
    success_url, cancel_url,
    expires_at: depositExpiresAt,
    metadata: { reservationId, venueId },
  },
  {
    stripeAccount: 'acct_venue_xyz',   // ⭐ outbound API option →
                                       //   PaymentIntent + Charge live on venue account
    idempotencyKey: 'reservation:RSV_xxx:deposit:v1',
  },
)
        │
        ▼
Stripe processes on connected account:
  ├─ $39.00 → Stripe (3.6% + $3 MXN, charged to venue's connected account)
  ├─ $10.00 → Avoqado platform account (application_fee, auto-collected)
  └─ $951.00 → Venue connected account balance (paid out per schedule)
        │
        ▼
Webhook checkout.session.completed delivered to /api/v1/webhooks/stripe/connect
  ├─ Verified with STRIPE_CONNECT_WEBHOOK_SECRET
  └─ event.account = 'acct_venue_xyz'   ⭐ source of truth for tenant routing
        │
        ▼
Server idempotently:
  ├─ Look up Reservation by checkoutSessionId
  ├─ Update: status = CONFIRMED, confirmedAt = now,
  │          depositStatus = PAID, depositPaidAt = now,
  │          depositProcessorRef = paymentIntentId
  └─ Record event.id in ProcessedStripeEvent (UNIQUE) for replay safety
```

### 4.2 Chargeback flow (corrected)

In direct charges, **chargebacks debit the connected account directly**, not the platform.

```
Customer disputes charge (60-120 days post-charge)
        │
        ▼
Stripe debits venue's connected account:
  ├─ Original amount: -$1,000 MXN
  ├─ Chargeback fee:  -$15 USD
  └─ application_fee: behavior MUST be verified in Stripe test/live config
        │
        ▼
Webhook charge.dispute.created delivered to /api/v1/webhooks/stripe/connect
  └─ event.account = 'acct_venue_xyz'
        │
        ▼
Server: Reservation.depositStatus = DISPUTED
        Dashboard alerts venue with link to Stripe dashboard for evidence upload
        (MVP: manual via Stripe; Phase 4+: in-app evidence UI)
```

**Avoqado's exposure** is limited to the case where the venue's connected account has insufficient balance at chargeback time (e.g., already paid out). Stripe will then debit the platform's balance to cover the chargeback, and the platform must recover from the venue contractually.

**Application fee on disputes is a production gate.** Do not assume the application fee is automatically reversed for every dispute outcome. Before go-live, run a Stripe test-mode dispute on a direct charge with `application_fee_amount`, inspect the resulting `balance_transaction`, `application_fee`, and any `application_fee.refunded` / adjustment events, then document the exact ledger behavior in `docs/runbooks/stripe-connect-liability.md`.

### 4.3 Refund flow (cancellation, Phase 3)

For direct charges, **application fees are NOT auto-refunded.** The platform must explicitly request the application fee refund:

```ts
// Cancel within window with forfeitDeposit=false:
await stripe.refunds.create(
  {
    payment_intent: reservation.depositProcessorRef, // pi_xxx
    refund_application_fee: true,                    // ⭐ explicit — required for direct charges
    reason: 'requested_by_customer',
    metadata: { reservationId, venueId, type: 'reservation_cancellation' },
  },
  {
    stripeAccount: merchant.connectAccountId,        // ⭐ refund executed on venue's account
    idempotencyKey: `refund:${reservationId}:v1`,
  },
)
```

Effects:
- Customer receives full refund (gross amount; Stripe processing fees are NOT refunded back to venue per Stripe MX policy — venue eats those fees)
- Venue's connected account balance: -$1,000 MXN (refund) + $39 (kept by Stripe as fee penalty for refund) = -$1,039 net
- Platform balance: -$10 (application fee reversed)
- Reservation: `(CANCELLED, _, REFUNDED)`, `depositRefundedAt = now`

When `forfeitDeposit=true` and cancellation is past `minHoursBeforeCancel`:
- No refund issued
- Venue keeps the deposit (minus Stripe fees that were already taken)
- Avoqado keeps the application fee
- Reservation: `(CANCELLED, _, FORFEITED)` + audit log entry

### 4.4 Risk mitigations (Phase 1, not deferred)

These mitigations are part of MVP scope, not Phase 4+:

1. **Payout schedule delay (implementation-gated).** New connected accounts target a 7-day payout delay for first 90 days. With Accounts v2, configure this through the supported balance/payout settings API for the account; if the installed SDK/API only exposes this through legacy account settings, document the fallback and re-review. Reduces "negative balance" risk during the chargeback retraction window. After 90 days of clean history, a daily job attempts to lift to T+2. Handle Stripe API refusal as a provisioning error and block live payments for that merchant until resolved.
2. **Balance reserve (depends on Connect risk controls).** Programmatic reserves on connected accounts are not uniformly available across all Connect configurations and account types. Treat as **opt-in mitigation pending verification**: Phase 1 creates the schema field (`merchant.reserveBps`) and superadmin UI to set a reserve percentage, but the actual enforcement mechanism (balance reserve, payout pause, etc.) must be confirmed with Stripe account manager. If unavailable, fall back to longer payout delay for high-risk venues.
3. **Contractual liability clause.** Venue's Avoqado ToS includes a clause making them responsible for chargebacks; if Stripe debits Avoqado's platform balance due to insufficient venue funds, Avoqado has the right to recover from the venue (deduct from POS settlements, invoice, etc.). Required before first live charge.
4. **Per-charge cap.** In MVP, hard cap deposit `amount` at `STRIPE_MAX_CHARGE_MXN_CENTS` (default `5000000` = $50,000 MXN). Prevents fraud-spike scenarios. Rejected at controller boundary before reservation INSERT.
5. **Per-charge minimum (configurable).** Stripe MX has a minimum charge amount per transaction. Rather than hardcode a value that may be wrong or change, expose as env: `STRIPE_MIN_CHARGE_MXN_CENTS` with default `1000` (= $10 MXN) **pending verification with Stripe MX**. **Production gate:** confirm current minimum from Stripe Dashboard or account manager and update env. Rejected at controller boundary before reservation INSERT with explicit error: `deposit_below_minimum_charge`.

---

## 5. Phased plan

### Phase 0 — Provider abstraction (1-2 days)

**Goal:** Introduce `IEcommerceProvider` interface; existing Blumon code becomes one implementation; Stripe Connect provider is a stub. Zero behavior change for customers.

**Deliverables:**
- `src/services/payments/providers/provider.interface.ts` — `IEcommerceProvider` contract (see §6)
- `src/services/payments/providers/blumon.provider.ts` — wraps existing `blumon-ecommerce.service.ts`
- `src/services/payments/providers/stripe-connect.provider.ts` — stub implementation, throws `NotImplementedError` for unimplemented methods
- `src/services/payments/provider-registry.ts` — `getProvider(merchant): IEcommerceProvider` based on `merchant.provider.code`
- Refactor `paymentLink.service.ts` to call `provider.X(...)` instead of `getBlumonEcommerceService(...)` directly
- Regression tests on existing payment link flow (Blumon-backed)

**Schema migration:** None.

**Risk:** Low. Blumon ecommerce is untested in production.

### Phase 1 — Stripe Connect onboarding + risk controls (3-4 days)

**Goal:** Venue activates Stripe payments from dashboard via seamless hosted flow. Onboarding-only — no money flow yet. Risk mitigations (payout delay, reserves) wired from day one.

**Deliverables:**

**Server schema:**
```prisma
model EcommerceMerchant {
  // ... existing fields ...

  // Generic provider-agnostic shadow column for fast webhook routing
  providerMerchantId String?

  // Onboarding state (provider-agnostic)
  onboardingStatus     OnboardingStatus @default(NOT_STARTED)
  chargesEnabled       Boolean @default(false)
  payoutsEnabled       Boolean @default(false)
  requirementsDue      String[] @default([])
  onboardingLinkUrl    String?
  onboardingLinkExpiry DateTime?

  // Provider-specific data continues to live in providerCredentials JSON
  // (e.g., for Stripe Connect: { connectAccountId, ... })

  @@unique([providerId, providerMerchantId])
}

enum OnboardingStatus {
  NOT_STARTED
  IN_PROGRESS
  COMPLETED
  RESTRICTED
}
```

**Schema for Stripe webhook routing & idempotency:**
```prisma
model ProcessedStripeEvent {
  id          String   @id @default(cuid())
  stripeEventId String                 // Stripe's event.id
  endpoint    String                 // 'platform' | 'connect'
  eventType   String
  account     String?                // event.account for Connect events
  processedAt DateTime @default(now())
  payload     Json                   // archived for audit / debugging

  @@unique([endpoint, stripeEventId])
  @@index([eventType, processedAt])
}
```

**Seed data:**
```sql
INSERT INTO "PaymentProvider" (id, code, name, "supportsHostedCheckout", active)
VALUES ('<cuid>', 'STRIPE_CONNECT', 'Stripe', true, true);
```

**Stripe Connect provider — onboarding methods:**
```ts
// stripe-connect.provider.ts
async createOnboardingLink(merchant: EcommerceMerchant): Promise<OnboardingLink> {
  const credentials = merchant.providerCredentials as { connectAccountId?: string }
  let connectAccountId = credentials.connectAccountId

  if (!connectAccountId) {
    // Accounts v2 / controller-property shape. Use the latest Stripe SDK/API.
    // If SDK support requires a raw request wrapper, isolate it inside this provider.
    const account = await stripe.v2.core.accounts.create({
      country: 'MX',
      business_type: onboardingInput.businessType, // 'company' | 'individual' from pre-onboarding wizard
      contact_email: merchant.contactEmail,
      controller: {
        dashboard: 'full',
        losses: { payments: 'stripe' }, // production gate verifies actual platform setting
        fees: { payer: 'stripe' },
      },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: { venueId: merchant.venueId, channelName: merchant.channelName },
    })
    connectAccountId = account.id

    await configureInitialPayoutDelay(connectAccountId, { delayDays: 7 }) // provider-private helper; fail closed

    await prisma.ecommerceMerchant.update({
      where: { id: merchant.id },
      data: {
        providerCredentials: { ...credentials, connectAccountId },
        providerMerchantId: connectAccountId,                // ⭐ shadow column for webhook routing
      },
    })
  }

  // Account Links are short-lived and single-use. Generate a fresh link for every dashboard click
  // unless a not-yet-opened link is known to be valid. Stored URL is audit/debug only.
  const link = await stripe.accountLinks.create({
    account: connectAccountId,
    return_url: `${PUBLIC_DASHBOARD_URL}/venues/${merchant.venueId}/settings/payments?status=success`,
    refresh_url: `${PUBLIC_DASHBOARD_URL}/venues/${merchant.venueId}/settings/payments?status=retry`,
    type: 'account_onboarding',
  })

  await prisma.ecommerceMerchant.update({
    where: { id: merchant.id },
    data: { onboardingLinkUrl: link.url, onboardingLinkExpiry: new Date(link.expires_at * 1000) },
  })

  return { url: link.url, expiresAt: new Date(link.expires_at * 1000) }
}
```

**Onboarding status sync (called from webhook + polling endpoint):**
```ts
async getOnboardingStatus(merchant): Promise<OnboardingStatus> {
  const acctId = (merchant.providerCredentials as any).connectAccountId
  const account = await retrieveConnectedAccount(acctId) // Accounts v2 wrapper inside provider
  return {
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    requirementsDue: account.requirements?.currently_due ?? [],
    status: deriveStatus(account),  // NOT_STARTED | IN_PROGRESS | COMPLETED | RESTRICTED
  }
}
```

**Server endpoints:**
- `POST /api/v1/dashboard/venues/:venueId/ecommerce-merchants/stripe-onboard` — create or refresh onboarding link
- `GET /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/onboarding-status` — polled by dashboard after return from Stripe

**Webhook handlers (Connect endpoint):**
- `account.updated` (event.account matches a known `providerMerchantId`) → sync `chargesEnabled`, `payoutsEnabled`, `requirementsDue`, `onboardingStatus`

**Reserve / payout schedule reset job:**
- `src/jobs/connect-account-graduation.job.ts` runs daily
- Finds connected accounts where `account.created + 90 days < now` AND clean dispute history
- Calls provider-private payout settings helper to request T+2; if Stripe refuses, leave T+7 and create ops task

**Dashboard:**
- New section in venue settings: "Pagos online"
- States to handle: `NOT_STARTED`, `IN_PROGRESS`, `RESTRICTED`, `COMPLETED` (see v1 spec)
- Return URL handler polls `getOnboardingStatus` every 2s for 30s after callback

**Tests:**
- Stripe test mode: full E2E onboarding with test data
- Webhook handler unit tests with fixture `account.updated` events

### Phase 2 — Reservation deposit payment flow (4-6 days)

**Goal:** Reservation creation with `depositMode != 'none'` produces a Stripe Checkout URL on the venue's connected account. Money lands in venue's account. Webhooks update reservation state idempotently.

**Schema additions:**
```prisma
model Reservation {
  // ... existing fields ...
  checkoutSessionId String?  // Stripe Checkout Session ID (cs_xxx)
  depositExpiresAt  DateTime? // ⭐ snapshotted at create; not recomputed from settings
  idempotencyKey    String?  @unique  // for retry-safe Stripe creation
}

enum DepositStatus {
  // existing: PENDING, CARD_HOLD, PAID, REFUNDED, FORFEITED
  EXPIRED   // ⭐ new — payment window closed
  DISPUTED  // ⭐ new — chargeback in flight
}
```

**Two-phase reservation + payment flow (with merchant pre-check):**

```
1. POST /public/.../reservations

   Pre-checks (BEFORE any DB INSERT; fast rejects only):
   ├─ Validate slot availability as a non-authoritative fast check
   ├─ Compute depositAmount, depositExpiresAt = now + clamp(window, 30min, 24h)
   ├─ If deposit required:
   │   ├─ stripeAmountCents = toStripeAmount(depositAmount)
   │   ├─ stripeAmountCents < STRIPE_MIN_CHARGE_MXN_CENTS → 422 deposit_below_minimum_charge
   │   ├─ stripeAmountCents > STRIPE_MAX_CHARGE_MXN_CENTS → 422 deposit_above_maximum_charge
   │   └─ Resolve active EcommerceMerchant
   │      (provider.code='STRIPE_CONNECT' AND chargesEnabled=true AND merchant.active=true)
   │       └─ Not found → 422 payment_provider_not_configured
   │          (NO reservation INSERT — slot remains free; user sees actionable error)
   │
   ├─ Generate idempotencyKey = `reservation:${cuid}:deposit:v1`
   ├─ DB Tx1:
   │   ├─ Re-run authoritative slot availability / conflict check under the same locking
   │   │   semantics as existing reservation creation (e.g. row lock, serializable tx,
   │   │   exclusion/unique constraint, or existing local conflict guard)
   │   ├─ If conflict now exists → ROLLBACK + 409 slot_unavailable
   │   └─ INSERT Reservation (status=PENDING, confirmedAt=null,
   │            depositStatus=PENDING, depositAmount, depositExpiresAt,
   │            idempotencyKey, merchantId)
   ├─ COMMIT Tx1
   │
   ├─ Call StripeConnectProvider.createCheckoutSession(merchant, params)
   │   with idempotencyKey  ← OUTSIDE DB transaction
   │
   ├─ DB Tx2: UPDATE Reservation SET checkoutSessionId = cs_xxx
   │            WHERE id = ... AND checkoutSessionId IS NULL
   ├─ COMMIT Tx2
   │
   └─ Return 200 { reservationId, checkoutUrl }

   If Stripe call fails between Tx1 and Tx2:
     - Reservation row exists with idempotencyKey but no checkoutSessionId
     - Reconciliation cron retries the Stripe call with same key
     - User can refresh and see retry button (or auto-redirect after retry)

2. Customer pays at Stripe Checkout
   └─ Stripe sends checkout.session.completed → /api/v1/webhooks/stripe/connect
        ├─ Signature verified with STRIPE_CONNECT_WEBHOOK_SECRET
        ├─ Defense check: session.payment_status === 'paid' (else 200 + log warning, no state change)
        ├─ Look up Reservation by checkoutSessionId
        ├─ BEGIN TRANSACTION (single tx — see §8.2 for poison-event–safe semantics):
        │   ├─ INSERT ProcessedStripeEvent(stripeEventId) UNIQUE
        │   │   └─ on conflict: ROLLBACK + return 200 (true replay)
        │   ├─ UPDATE Reservation
        │   │     SET status=CONFIRMED, confirmedAt=now, depositStatus=PAID,
        │   │         depositPaidAt=now, depositProcessorRef=payment_intent
        │   │     WHERE id=... AND depositStatus='PENDING'
        │   │     ├─ rows = 1: success
        │   │     ├─ rows = 0 AND current depositStatus = 'PAID': COMMIT (out-of-order replay)
        │   │     └─ rows = 0 AND current depositStatus IN ('EXPIRED','FORFEITED','REFUNDED'):
        │   │         INSERT MoneyAnomaly in same tx + COMMIT event+anomaly
        │   │         return 200 + page on-call
        │   └─ COMMIT
        └─ Return 200

3. Customer abandons
   └─ Stripe sends checkout.session.expired → similar tx structure → CANCELLED + EXPIRED
      (zero-rows cases handled symmetrically — see §8.2 table)
```

**Idempotency contract:**
- Stripe API call uses `idempotencyKey` so retries are safe (and reconciliation can retry the same call key without double-creating sessions)
- Webhook handler inserts `ProcessedStripeEvent` and mutates reservation in **same DB transaction** — rollback on any failure prevents poison-event scenario (see §8.2)
- Reservation update is conditional (`WHERE depositStatus = 'PENDING'`) to prevent state regression
- Zero-rows-updated outcomes are categorized: forward-state replays close as success; divergent states (PAID + CANCELLED, etc.) commit `ProcessedStripeEvent + MoneyAnomaly` and page on-call exactly once per event/category

**Reconciliation cron** (`src/jobs/reservation-deposit-reconciliation.job.ts`, hourly):
- Find reservations where `depositStatus=PENDING` AND `depositExpiresAt < now`
- For each: call `stripe.checkout.sessions.retrieve(checkoutSessionId, { stripeAccount: ... })`
- If Stripe says `complete` → defensive: process as if webhook arrived (idempotent)
- If Stripe says `expired` or session not found → cancel reservation: `(CANCELLED, _, EXPIRED)`
- Find reservations with `idempotencyKey` but no `checkoutSessionId` (orphans from interrupted creation) → recreate session using same idempotencyKey

**Public booking page:**
- After successful POST, if response includes `checkoutUrl`, `window.location = checkoutUrl`
- New page `BookingPaymentReturn.tsx` for `success_url` and `cancel_url` callbacks
- Persist booking session metadata in `localStorage` keyed by `checkoutSessionId` for UX continuity (NOT for state correctness — server is source of truth)

**Tests:**
- Stripe test mode E2E: reserve → checkout → pay with `4242` → webhook → CONFIRMED+PAID
- Test expiry path: reserve → don't pay → webhook expired → CANCELLED+EXPIRED
- Test cron expiry path: reserve → don't pay + drop webhook → cron cancels
- Test webhook replay: same `event.id` twice → second attempt is no-op
- Test orphan recovery: reservation created but Stripe call timed out → reconciliation re-creates session
- Test concurrent cancel + payment: webhook PAID arrives during cancel → conditional UPDATE prevents state corruption
- Manual: real iPhone / Android booking with payment

### Phase 3 — Forfeit + offboarding (2-3 days)

**Goal:** Honor `forfeitDeposit` and `noShowFeePercent` settings. Document offboarding runbook with operational endpoints.

**Forfeit + refund:**
- Modify `cancelReservation` to compute hours-until-start, choose refund-vs-forfeit per settings, call `stripe.refunds.create({ refund_application_fee: true }, { stripeAccount })`, transition state.
- Modify `markNoShow`: if `depositStatus=PAID`, retain (deposit IS the no-show fee). Audit log entry for accounting.

**Offboarding runbook + tooling:**
- Superadmin endpoint `POST /api/v1/superadmin/venues/:venueId/offboard-payments`:
  1. Mark `EcommerceMerchant.active = false` and `chargesEnabled = false` (cuts new reservations)
  2. Block new reservation deposit creation server-side (controller checks `merchant.active`)
  3. Persist `offboardingInitiatedAt` timestamp
  4. Lists pending state: open disputes, refunds in flight, unsettled balance, scheduled payouts
- Documentation `docs/runbooks/connect-account-offboarding.md`:
  - How to quiesce: disable new charges, allow refunds for next 90 days
  - When to retain `connectAccountId`: at least 180 days post-final-payout (chargeback window)
  - Final balance settlement: how to verify zero balance + no pending disputes
  - Stripe account deletion: NOT done by Avoqado — venue must do it themselves in Stripe Dashboard
  - What to communicate to venue: ToS clause about ongoing chargeback liability
- Dashboard banner on offboarded venue: "Pagos online desactivados. Disputas pendientes: N. Última liquidación: $X"

**Tests:**
- E2E: pay deposit → cancel within window → refund issued → application fee reversed
- E2E: pay deposit → cancel outside window with forfeitDeposit → no refund, FORFEITED
- E2E: pay deposit → no-show → status remains PAID, audit log entry
- E2E: superadmin offboard flow → existing reservations honor refunds, new reservations blocked

### Phase 4+ (out of MVP scope, but documented for context)

- `card_hold` mode (auth without capture)
- Stripe Elements embedded payment
- Async payment methods (OXXO, SPEI) with `checkout.session.async_payment_succeeded/failed`
- Customer evidence upload UI for chargebacks (in-app)
- Migration of credit packs to Connect
- Custom payout schedule per-venue (UI configurable)
- Multi-currency support
- Refund partial amounts
- Reservation reschedule with new deposit
- Tax (IVA) automated CFDI emission for application fee (currently manual / accountant-assisted; see §11)

---

## 6. Provider abstraction interface

```typescript
// src/services/payments/providers/provider.interface.ts

export interface OnboardingLink {
  url: string
  expiresAt: Date
}

export interface OnboardingStatus {
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'RESTRICTED'
  chargesEnabled: boolean
  payoutsEnabled: boolean
  requirementsDue: string[]
}

export interface CreateCheckoutParams {
  amount: number              // Smallest currency unit
  currency: string            // 'mxn'
  applicationFeeAmount: number
  successUrl: string
  cancelUrl: string
  expiresAt: Date
  customerEmail?: string
  metadata: Record<string, string>
  description: string
  statementDescriptorSuffix?: string  // 5-22 chars sanitized; e.g. "RESERVA"
  idempotencyKey: string
  paymentMethodTypes: string[]        // MVP: ['card']
}

export interface CheckoutSession {
  id: string
  url: string
  expiresAt: Date
}

export interface PaymentStatus {
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED' | 'REFUNDED' | 'DISPUTED'
  paidAt?: Date
  paymentIntentId?: string
  amountPaid?: number
  applicationFeeAmount?: number
}

export interface RefundParams {
  paymentIntentId: string
  amount?: number  // partial refund (Phase 4+); MVP only supports full
  refundApplicationFee: boolean
  reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent'
  idempotencyKey: string
  metadata: Record<string, string>
}

export interface RefundResult {
  refundId: string
  amount: number
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED'
}

export interface VerifiedWebhookEvent {
  id: string                  // event.id (for idempotency)
  type: string                // e.g. 'checkout.session.completed'
  account?: string            // event.account (Connect tenant)
  data: any                   // event.data.object
  livemode: boolean
}

export interface IEcommerceProvider {
  // Onboarding
  createOnboardingLink(merchant: EcommerceMerchant): Promise<OnboardingLink>
  getOnboardingStatus(merchant: EcommerceMerchant): Promise<OnboardingStatus>

  // Payments
  createCheckoutSession(merchant: EcommerceMerchant, params: CreateCheckoutParams): Promise<CheckoutSession>
  getPaymentStatus(merchant: EcommerceMerchant, sessionId: string): Promise<PaymentStatus>
  refund(merchant: EcommerceMerchant, params: RefundParams): Promise<RefundResult>

  // Webhook signature verification — returns parsed event with account for routing
  verifyWebhookSignature(payload: string | Buffer, signature: string, endpoint: 'platform' | 'connect'): Promise<VerifiedWebhookEvent>
}
```

**Adapter implementations:**
- `BlumonProvider` — wraps existing `blumon-ecommerce.service.ts`. May throw `NotImplementedError` for capabilities Blumon doesn't expose.
- `StripeConnectProvider` — full implementation. All methods route through `{ stripeAccount: connectAccountId }` per the direct charges model. `verifyWebhookSignature` chooses platform or connect secret based on `endpoint` param.

---

## 7. Schema changes summary

### `EcommerceMerchant` (additions, all backwards-compatible)

```prisma
model EcommerceMerchant {
  // ... existing fields ...

  providerMerchantId   String?  // generic shadow column (e.g. Stripe acct_xxx)

  onboardingStatus     OnboardingStatus @default(NOT_STARTED)
  chargesEnabled       Boolean @default(false)
  payoutsEnabled       Boolean @default(false)
  requirementsDue      String[] @default([])  // ⭐ default fixed
  onboardingLinkUrl    String?
  onboardingLinkExpiry DateTime?

  platformFeeBps       Int @default(100)  // ⭐ basis points (100 = 1%); range 0-3000

  offboardingInitiatedAt DateTime?  // Phase 3

  @@unique([providerId, providerMerchantId])  // fast webhook routing
  @@index([onboardingStatus])
}

enum OnboardingStatus {
  NOT_STARTED
  IN_PROGRESS
  COMPLETED
  RESTRICTED
}
```

### `Reservation` (additions)

```prisma
model Reservation {
  // ... existing fields ...
  checkoutSessionId String?
  depositExpiresAt  DateTime?           // snapshot at create
  idempotencyKey    String? @unique     // retry-safe Stripe call key

  // Refund lifecycle (separate from depositStatus — orthogonal concerns)
  refundStatus       RefundStatus?
  refundRequestedAt  DateTime?
  refundProcessorRef String?            // re_xxx
  refundFailedReason String?            // last failure message (operational)
  refundRetryCount   Int @default(0)

  @@index([depositStatus, depositExpiresAt])  // for cron reconciliation
  @@index([refundStatus, refundRequestedAt])  // for refund retry job
}
```

### `ReservationSettings` (semantic migration)

```prisma
model ReservationSettings {
  // ... existing fields ...
  depositPaymentWindow Int? // minutes to complete payment (MIGRATED from hours in Phase 2)
}
```

Migration must multiply existing non-null values by 60 before the app starts treating the field as minutes. Dashboard validation after migration: `[30, 1440]`.

### `DepositStatus` enum (additions only — existing values preserved)

```prisma
enum DepositStatus {
  PENDING
  CARD_HOLD
  PAID
  REFUNDED
  FORFEITED
  EXPIRED   // ⭐ new
  DISPUTED  // ⭐ new
}

// ⭐ new: refund lifecycle is independent of deposit lifecycle
enum RefundStatus {
  PENDING    // refund requested, Stripe call in flight or queued
  SUCCEEDED  // Stripe acknowledged refund
  FAILED     // Stripe refused or transient failure exhausted retries — operator intervention
}
```

**Why separate:** a deposit can be `PAID` while a refund is `PENDING` (during cancellation processing). Embedding refund states in `DepositStatus` (e.g. a phantom `PENDING-REFUND`) conflates two orthogonal lifecycles and invents enum values not actually persisted in DB. Refund tracking lives in its own fields and enum.

### New table — `ProcessedStripeEvent`

```prisma
model ProcessedStripeEvent {
  id            String   @id @default(cuid())
  stripeEventId String
  endpoint      String   // 'platform' | 'connect'
  eventType     String
  account       String?  // event.account, when present
  processedAt   DateTime @default(now())
  payload       Json

  @@unique([endpoint, stripeEventId])
  @@index([eventType, processedAt])
  @@index([account])
}
```

### New table — `MoneyAnomaly`

```prisma
model MoneyAnomaly {
  id              String   @id @default(cuid())
  detectedAt      DateTime @default(now())
  category        String   // 'PAID_AFTER_CANCEL', 'EXPIRED_AFTER_PAID', etc.
  reservationId   String?
  stripeEventId   String?
  expectedState   Json
  observedState   Json
  resolution      String?  // free-form notes after manual review
  resolvedAt      DateTime?
  resolvedBy      String?  // staffId

  @@unique([stripeEventId, category])
  @@index([category, resolvedAt])
}
```

### `PaymentProvider` (seed data)

```sql
INSERT INTO "PaymentProvider" (id, code, name, "supportsHostedCheckout", active)
VALUES ('<cuid>', 'STRIPE_CONNECT', 'Stripe', true, true);
```

---

## 8. Idempotency, retries, and webhook semantics

### 8.1 Two-phase reservation creation (no Stripe inside DB transaction)

```
Tx1 (DB only):
  INSERT Reservation (status=PENDING, depositStatus=PENDING, idempotencyKey=K, ...)
  COMMIT

External call:
  stripe.checkout.sessions.create(..., { stripeAccount, idempotencyKey: K })

Tx2 (DB only):
  UPDATE Reservation SET checkoutSessionId = cs_xxx
  WHERE id = ... AND checkoutSessionId IS NULL
  COMMIT
```

If the process crashes between Tx1 and the Stripe call, the reservation has `idempotencyKey` but no `checkoutSessionId`. The reconciliation cron detects orphans and re-runs the Stripe call with the same `idempotencyKey` — Stripe returns the cached response if the call was already made, or processes it fresh otherwise.

### 8.2 Webhook idempotency (poison-event–safe)

**The poison-event problem v2 introduced and v2.2 fixes:** if `INSERT ProcessedStripeEvent` succeeds first and a *separate* subsequent `UPDATE` fails with a transient DB error, Stripe receives a 5xx and retries — but the next attempt sees the duplicate `stripeEventId` and short-circuits as "already processed." Result: payment captured, reservation never confirmed. **Fix:** insert the event row and mutate the reservation in the **same DB transaction**; rollback both on failure so retries see a clean slate.

```
Receive event:
  1. Verify signature (per-endpoint secret) → reject 400 on failure
  2. Parse event; resolve tenant resource (Reservation by checkoutSessionId, Merchant by providerMerchantId)
  3. Pre-checks:
     ├─ Tenant resource not found        → 200 + log warning (orphan event)
     ├─ checkout.session.completed AND
     │   session.payment_status !== 'paid' → 200 + log warning (defense even on card-only)
     └─ Otherwise proceed

  4. BEGIN TRANSACTION
     ├─ INSERT ProcessedStripeEvent (endpoint, stripeEventId=event.id) UNIQUE
     │     │
     │     └─ ON CONFLICT (event.id already exists, ignoring isolation):
     │           ROLLBACK; return 200 (true replay — already processed)
     │
     ├─ UPDATE <tenant resource>
     │     SET <new state>
     │     WHERE id = X AND <expected pre-state predicate>
     │     ├─ rows = 1: success path
     │     └─ rows = 0: see "Zero-rows-updated semantics" below
     │
     └─ COMMIT
        return 200

  5. ANY exception inside the transaction (incl. UPDATE failure due to DB transient) → ROLLBACK, return 500. Stripe retries with backoff. The ProcessedStripeEvent row is rolled back too, so the next retry processes cleanly.
```

#### Zero-rows-updated semantics (CRITICAL — distinguishes success no-ops from anomalies)

A `WHERE depositStatus = 'PENDING'` predicate that matches zero rows is **not always a benign no-op**. The current state determines whether to close as success or escalate:

| Webhook event | Expected pre-state | Current state observed | Treatment |
|---|---|---|---|
| `checkout.session.completed` | `(PENDING, PENDING)` | `(CONFIRMED, PAID)` | ✅ True replay or out-of-order delivery — **COMMIT (event recorded), return 200** |
| `checkout.session.completed` | `(PENDING, PENDING)` | `(CANCELLED, EXPIRED)` | ⚠️ **Money may have arrived after slot freed.** INSERT `MoneyAnomaly` in same tx; **COMMIT event+anomaly**; return 200; **PAGE on-call**; manual reconciliation required |
| `checkout.session.completed` | `(PENDING, PENDING)` | `(CANCELLED, FORFEITED)` | ⚠️ Same as above — paid-after-cancel anomaly |
| `checkout.session.expired` | `(PENDING, PENDING)` | `(CONFIRMED, PAID)` | ✅ Out-of-order — **COMMIT (event recorded), return 200**; payment won the race |
| `charge.dispute.created` | any | `(_, REFUNDED)` | Update `depositStatus = DISPUTED` regardless; refund + dispute can coexist |
| `charge.refunded` | refund pending | already `(_, REFUNDED)` | True replay → COMMIT, return 200 |

**Rule of thumb:** zero-rows is a benign no-op only when the current state is **forward** of the expected state along the happy path. When current state is **divergent** (PAID + CANCELLED, FORFEITED + paid event, etc.) the handler must NOT silently close — it must persist an anomaly record and alert.

A `MoneyAnomaly` table (Phase 2 schema):
```prisma
model MoneyAnomaly {
  id              String   @id @default(cuid())
  detectedAt      DateTime @default(now())
  category        String   // 'PAID_AFTER_CANCEL', 'EXPIRED_AFTER_PAID', etc.
  reservationId   String?
  stripeEventId   String?
  expectedState   Json
  observedState   Json
  resolution      String?  // free-form notes after manual review
  resolvedAt      DateTime?
  resolvedBy      String?  // staffId

  @@unique([stripeEventId, category])
  @@index([category, resolvedAt])
}
```

PagerDuty/Slack alert on every new `MoneyAnomaly` insertion. For `PAID_AFTER_CANCEL` / `PAID_AFTER_EXPIRED`, page immediately and require human triage within 1 hour during operating hours (next operating block if overnight). Other lower-impact anomalies can use next-business-day triage.

### 8.3 Webhook response policy (corrects current bug)

The existing `webhook.controller.ts:89-91` returns 200 even on processing errors. **This must be fixed before MVP.** Correct semantics:

| Outcome | HTTP code | Stripe behavior |
|---|---|---|
| Signature invalid / malformed payload | 400 | No retry (correct — bad request) |
| Already processed (replay) | 200 | No retry (correct — idempotent no-op) |
| Tenant resource not found (Reservation deleted, etc.) | 200 | No retry (orphan event, log warning) |
| Tenant resource found, state mismatch | 200 | No retry (already in desired state) |
| Transient DB error / external call error | 500 | Stripe retries with exponential backoff for 3 days |
| Unhandled exception | 500 | Stripe retries |

Fix is scoped to the new Connect endpoint; the existing platform endpoint can be fixed separately if business decides.

### 8.4 Money math: Decimal ↔ Stripe centavos (bidirectional helper)

Avoqado uses `Decimal(10,2)` for monetary amounts in DB (e.g. `depositAmount = 1000.00`). Stripe API requires the smallest currency unit as integer (e.g. `100000` for $1,000 MXN). **Conversion happens only at the Stripe adapter boundary, never earlier or in business logic.** The DB schema and all upstream code stay in Decimal — Stripe-shape is hidden behind helpers.

#### Helper module — single source of truth

```ts
// src/services/payments/providers/money.ts
import { Prisma } from '@prisma/client'

/**
 * Decimal → Stripe centavos (outbound: create charges, refunds, application fees)
 * Used in: createCheckoutSession, refund, any other Stripe API call with `amount`
 */
export function toStripeAmount(decimal: Prisma.Decimal): number {
  const cents = decimal.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber()
  if (!Number.isInteger(cents) || cents < 0 || cents > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid Stripe amount conversion: ${decimal.toString()} → ${cents}`)
  }
  return cents
}

/**
 * Stripe centavos → Decimal (inbound: webhook payloads, session retrieve, refund retrieve)
 * Used in: checkout.session.completed handler, payment_intent.succeeded, charge.refunded, etc.
 */
export function fromStripeAmount(cents: number): Prisma.Decimal {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`Invalid Stripe cents value: ${cents}`)
  }
  return new Prisma.Decimal(cents).div(100)
}

/**
 * Compute application fee in Stripe centavos.
 * Calculated on the cents value (not on the decimal) to guarantee fee + net = gross with no off-by-one centavo drift.
 */
export function calculateApplicationFee(stripeAmountCents: number, feeBps: number): number {
  // bps = basis points; 100 bps = 1%
  return Math.round((stripeAmountCents * feeBps) / 10000)
}
```

#### Rules

1. **Decimal arithmetic only.** All math on monetary values uses `Prisma.Decimal` (or `Decimal.js`) — NEVER native JS `number` arithmetic. Floats lose precision (`0.1 + 0.2 !== 0.3`).
2. **Single boundary crossing.** `toStripeAmount` is the ONLY place that converts decimal → cents. Adapter calls it; nothing else. Symmetric for `fromStripeAmount`.
3. **Rounding:** `ROUND_HALF_UP` (SAT-preferred for CFDI receipt totals; rejects banker's rounding to match Mexican accounting expectations).
4. **Application fee on cents, not decimal.** Computing `feePercent * decimal` then rounding can drift by 1 centavo vs `feePercent * cents` then rounding. Always compute on cents.
5. **Webhook payload conversion.** Every `event.data.object.amount` / `amount_received` / `amount_refunded` field is in cents — convert via `fromStripeAmount` before persisting back to a `Decimal` column.
6. **Persisted amounts stay decimal.** `Reservation.depositAmount`, `applicationFeeAmount` (if added), refund amounts — all stored in `Decimal(10,2)` matching existing convention.

#### `platformFeeBps` schema addition

To make application fee per-venue configurable (vs hardcoded 1%):

```prisma
model EcommerceMerchant {
  // ... existing + Phase 1 additions ...
  platformFeeBps Int @default(100)  // basis points; 100 bps = 1%; range 0-3000
}
```

Default = 100 bps (1%). Superadmin-editable per merchant. Validated 0-3000 (0%-30%) at controller boundary.

#### `depositPercentage` calculation example

When `ReservationSettings.depositMode = 'deposit'` with `depositPercentage = 15` and a service price of $1,234.56:

```ts
// 1. Math in Decimal domain
const servicePrice = new Prisma.Decimal('1234.56')
const percentage = new Prisma.Decimal(settings.depositPercentage)  // 15
const depositDecimal = servicePrice.mul(percentage).div(100)  // 185.184 (3 decimals)

// 2. Round to DB precision (2 decimals) using same ROUND_HALF_UP
const depositForDb = depositDecimal.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)  // 185.18

// 3. At Stripe boundary, convert (185.18 → 18518 cents)
const stripeAmount = toStripeAmount(depositForDb)  // 18518
```

`Reservation.depositAmount` stores `185.18`. Stripe sees `18518`. Webhook `amount_received` = `18518` → `fromStripeAmount(18518)` = `185.18` matches DB exactly.

#### Validation at controller boundary

Reject reservation creation when:
- `depositAmount > 50000.00` (per-card cap, §4.4)
- `depositAmount` not exactly 2 decimal places (defensive — should never happen with `Decimal(10,2)`)
- `depositAmount * 100` not integer after Decimal math (defensive)
- `platformFeeBps < 0 || > 3000`

#### Where conversions happen

| Direction | Helper | Call sites |
|---|---|---|
| Avoqado → Stripe (outbound) | `toStripeAmount` + `calculateApplicationFee` | `StripeConnectProvider.createCheckoutSession` (line_items, application_fee_amount); `StripeConnectProvider.refund` (amount, if partial in Phase 4+) |
| Stripe → Avoqado (inbound) | `fromStripeAmount` | Webhook handlers: `checkout.session.completed` (amount_total, amount_subtotal); `charge.refunded` (amount_refunded); `charge.dispute.created` (amount); session retrieve in reconciliation cron |

Tests for `money.ts` are mandatory before Phase 2 ships:
- Property-based: `fromStripeAmount(toStripeAmount(d))` ≡ `d` for all `d` ∈ [0, 50000.00] with 2 decimals
- Edge: `toStripeAmount(new Decimal('0.005'))` rounds to `1` cent (HALF_UP)
- Edge: `toStripeAmount(new Decimal('0.004'))` rounds to `0` cents (HALF_UP)
- Edge: `calculateApplicationFee(100000, 100)` = `1000` (no float drift)
- Validation: `toStripeAmount(-1.00)` throws

---

### 8.5 Reconciliation guarantees

- **Hourly cron** for `reservation-deposit-reconciliation.job.ts`: catches expired-but-not-cancelled reservations.
- **Hourly cron** for orphan recovery: reservations with `idempotencyKey` but no `checkoutSessionId` older than 5 min → re-create Stripe session.
- **Daily cron** for `connect-account-graduation.job.ts`: lifts payout delay from T+7 to T+2 after 90 days clean.

---

## 9. Error handling

| Scenario | Behavior |
|---|---|
| Venue has no active Connect account, customer tries to reserve with deposit | API returns 422 `payment_provider_not_configured`. Reservation not created. |
| Stripe API call fails (timeout) during checkout creation | Reservation row exists with `idempotencyKey` but no `checkoutSessionId`. Reconciliation cron re-tries with same key. Customer sees "estamos procesando, intenta de nuevo". |
| Webhook signature invalid | 400, log warning. |
| Webhook for unknown `checkoutSessionId` | 200 + log warning (orphan event). |
| Webhook arrives twice | Composite UNIQUE on `(endpoint, stripeEventId)` blocks duplicate. 200 on conflict. |
| Customer pays after local expiry/cancel released the slot | Stripe `completed` and `expired` should be mutually exclusive for one Checkout Session, but local cron/manual cancellation can still race near expiry. If `completed` arrives after the app has cancelled/released the slot, handler commits `ProcessedStripeEvent + MoneyAnomaly`, returns 200, pages on-call, and requires manual customer/venue reconciliation. |
| Stripe outage during refund | Refund job re-tries with same `idempotencyKey`. Mark refund as `pending` in DB. Alert superadmin if stuck >1h. |
| Connected account becomes RESTRICTED mid-flow | New reservations refused (controller checks `chargesEnabled`). Existing PAID deposits unaffected. Refunds may queue until restriction lifted. Dashboard banner. |
| Application fee can't be collected (insufficient funds in connected account) | Stripe holds the app fee on the platform balance until funds available. No customer-facing error. |
| Chargeback while application fee already paid out to Avoqado | Stripe reverses the application fee from Avoqado's platform balance. Avoqado loses the fee for that transaction. |
| Customer disputes after offboarding | Connected account retained 180+ days post-offboarding (per runbook). Dispute handled normally. Avoqado team manually assists venue with evidence. |
| Reservation cancelled within window with `forfeitDeposit=false` but Stripe refund fails | `refundStatus=PENDING` set when refund attempted; on Stripe failure, retry job re-attempts with exponential backoff. After max retries (e.g., 5 attempts over 24h), `refundStatus=FAILED` + `refundFailedReason` populated + alert superadmin. Reservation `depositStatus` stays `PAID` until refund succeeds (orthogonal lifecycle); only `(CANCELLED, _, PAID, refundStatus=PENDING)` is the transient state. Once refund succeeds: `(CANCELLED, _, REFUNDED, refundStatus=SUCCEEDED)`. |
| Tax (IVA) calculation conflict on application fee | See §11 Q1. MVP: treat fee as gross; accountant emits CFDI manually. Phase 4+: automated CFDI per fee. |

---

## 10. Aislamiento guarantees + dual webhook endpoints

### 10.1 The "do not break" matrix

| Existing system | Affected? | Mitigation |
|---|---|---|
| **POS Blumon TPV** | No | Different model (`VenuePaymentConfig`). Different controllers (`tpv/*`). Spec's Phase 0 refactor explicitly does not touch `tpv/*`. |
| **SaaS subscriptions** | No, but webhook routing changes | Continues using `STRIPE_SECRET_KEY` global + `Venue.stripeCustomerId`. Webhook endpoint **explicitly separated** from Connect (see §10.2). Existing handlers in current `webhook.controller.ts` for subscriptions/invoices remain on platform endpoint, untouched. |
| **Credit packs** | No (in MVP) | Out of scope. Future ticket migrates to Connect. |
| **Payment links (Blumon)** | YES — refactored Phase 0 | Behavior preserved end-to-end. Regression tests required before merge. Production blast radius zero. |
| **EcommerceMerchant CRUD** | YES — adds new endpoints Phase 1 | Existing endpoints unchanged. New endpoints are additive. |

### 10.2 Two webhook endpoints, two secrets

Per reviewer requirement, isolate platform events from Connect events at the routing layer:

| Endpoint | URL | Stripe Dashboard config | Secret env var | Events handled |
|---|---|---|---|---|
| Platform | `POST /api/v1/webhooks/stripe/platform` | "Endpoints listening to events on your account" | `STRIPE_PLATFORM_WEBHOOK_SECRET` (existing `STRIPE_WEBHOOK_SECRET` renamed) | `customer.subscription.*`, `invoice.*`, `customer.*`, `payment_method.*`, etc. — Avoqado SaaS billing |
| Connect | `POST /api/v1/webhooks/stripe/connect` | "Endpoints listening to events on Connected accounts" | `STRIPE_CONNECT_WEBHOOK_SECRET` (new) | `account.updated`, `checkout.session.completed`, `checkout.session.expired`, `payment_intent.*`, `charge.dispute.*`, `charge.refunded` — venue ecommerce |

Each endpoint:
- Loads only its own secret
- Verifies signature with that secret only
- Routes events to handlers scoped to that endpoint's domain
- Internally can share `ProcessedStripeEvent` table for idempotency; `endpoint` column distinguishes origin

This prevents:
- Confused-deputy attacks (a Connect event accepted as a platform event)
- Cross-contamination of subscription handlers with deposit events
- Signature verification mistakes when rotating one secret without the other

### 10.3 Existing webhook controller cleanup

`src/controllers/webhook.controller.ts` becomes the platform endpoint. Two changes required for MVP:

1. **Path change:** mount existing handler at `/webhooks/stripe/platform` (keep old path as alias for backward compat during deploy, remove after a release cycle)
2. **Error semantics fix:** stop returning 200 on processing errors. Use the response policy in §8.3. Required for the new Connect endpoint regardless; applying to platform too is recommended but optional for MVP.

---

## 11. Open questions / TODOs (for reviewer round 3)

1. **Application fee tax (IVA) in MX.** Avoqado collects ~1% application fee per transaction. Under MX tax law, this is a service Avoqado provides to the venue and requires a CFDI invoice (factura). MVP plan: **manual** monthly CFDI emission by accountant from `ProcessedStripeEvent` aggregations. Phase 4+: automated CFDI per fee. **Gate before production:** accountant signoff on the manual process. Reviewer: acceptable as MVP gate?

2. **Credit pack migration.** Out of scope for MVP. Open question for separate ticket: do we migrate existing credit pack flow to Connect, or accept the platform-as-merchant model for that product line specifically (since credit packs are Avoqado's product, not venue services)?

3. **`business_type`:** ask venue during pre-onboarding wizard ("Persona fisica o moral?") and pass the corresponding value (`'individual' | 'company'`) to Accounts v2 account creation. No hardcoded default in production.

4. **Statement descriptor:** suffix capped 5-22 chars, sanitized (Latin only, alphanumeric + spaces, uppercased). MVP value: literal `"RESERVA"`. Connected account's prefix configured at onboarding (defaults to truncated `Venue.name`). Customer sees `"RESTAURANTE FOO RESERVA"` style.

5. **Offboarding:** **In MVP** as Phase 3. Runbook documented. Reviewer requested it not be deferred.

6. **localStorage for booking continuity:** server is source of truth. localStorage is UX-only (no PII beyond cart contents already submitted). Reviewer confirmed acceptable.

7. **Test mode toggle:** env-driven only (`STRIPE_LIVE_MODE=true|false`). No per-merchant override in MVP. Cross-mode mixing rejected with explicit error. Reviewer confirmed.

8. **Cron job library:** confirmed using existing `cron` library (`CronJob` class), pattern from `src/jobs/abandoned-orders-cleanup.job.ts`. Hourly = `'0 * * * *'`. Daily = `'0 4 * * *'` (4 AM CDMX, after midnight Stripe daily settlement).

9. **ToS clause for venue chargeback liability.** Required before first production charge. Legal team to draft. Reviewer: how to gate this in the rollout (feature flag tied to legal acceptance? superadmin approval?)?

10. **Deposit amount cap.** MVP cap: $50,000 MXN (`STRIPE_MAX_CHARGE_MXN_CENTS = 5000000`). Reviewer: too aggressive / too lax?

11. **Stripe MX minimum charge.** `STRIPE_MIN_CHARGE_MXN_CENTS` defaults to `1000` (= $10 MXN) **pending verification**. **Production gate:** confirm current minimum vigent in Stripe Dashboard or with account manager and update env. Below-minimum reservations rejected at controller boundary with `deposit_below_minimum_charge`.

12. **`controller.losses.payments` / `losses_collector` gate.** Direct charges mitigate the primary chargeback path, but the connected account configuration determines negative-balance responsibility. **Production gate:** confirm with Stripe account manager / Dashboard that the Accounts v2 `losses_collector` equivalent is `stripe` for the created connected accounts. Document in `docs/runbooks/stripe-connect-liability.md` before first live charge.

13. **`MoneyAnomaly` triage SLO.** `PAID_AFTER_CANCEL` / `PAID_AFTER_EXPIRED` page immediately and require human triage within 1 hour during operating hours (next operating block if overnight). Lower-impact money anomalies can use next-business-day triage.

---

## 12. Risk register (reordered: charge type is primary mitigation)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **PRIMARY:** Avoqado bears chargeback liability for the chargeback balance path | (was P0 in v1) | (was Critical) | **MITIGATED by direct charges:** PaymentIntent lives on connected account. Stripe debits venue's balance first for refunds and disputes. Platform exposure is now confined to the negative-balance edge case (rare, with mitigations). |
| Negative balance on connected account → Stripe debits Avoqado per `controller.losses.payments` config | Low-Medium (depends on account config) | Medium-High | (1) T+7 payout delay first 90 days if supported by the configured account/settings API; fail closed if not. (2) Optional reserve hold pending Stripe risk-control verification. (3) ToS clause for venue contractual recovery. (4) Per-charge min/max caps. (5) **Pre-prod gate:** confirm `controller.losses.payments` setting with Stripe account manager and document. |
| Webhook delivery failure → stuck PENDING reservations | Low | Medium | Hourly reconciliation cron. Stripe retries 3 days. Non-2xx response on transient errors. |
| Stripe API call hangs after DB commit (orphan reservation) | Medium | Low | Reconciliation cron detects orphans (idempotencyKey but no checkoutSessionId), retries. |
| Race: payment + cancel hit at same time | Low | Medium | Conditional UPDATE `WHERE depositStatus='PENDING'`. Webhook idempotency table. |
| Customer churn mid-checkout | Medium | Low | Stripe Checkout `expires_at`. Cron cancels reservation. Slot freed. |
| Stripe API breaking change | Low | High | Use latest Stripe SDK available at implementation time and pin API version in client init to `2026-02-25.clover` or newer. If the repo cannot upgrade safely, document exact installed SDK/API version and re-review Accounts v2 support. |
| `application_fee_amount` exceeds amount (config error) | Low | High | Server-side validation: fee ≤ 30% of amount. Reject with explicit error. |
| Currency mismatch | Medium | High | Hardcode `'mxn'` in MVP. Validate `Venue.country = 'MX'` before allowing Connect activation. |
| Platform secret rotation breaks Connect endpoint (or vice versa) | Low | Medium | Two separate env vars + endpoints. Rotate independently. Health check verifies both. |
| Reservation confirmed before payment (state machine bug) | Was a v1 risk | High | Mitigated: derived `PAYMENT_PENDING` UI state; canonical state is `(PENDING, null, PENDING)` until webhook flips to `(CONFIRMED, now, PAID)`. |
| Async payment method (OXXO/SPEI) selected accidentally | Low | High | Hardcode `payment_method_types: ['card']` in MVP. Defer async. |
| Tax (IVA) mishandling on application fee | Medium | High (legal) | Manual CFDI emission process gated by accountant signoff before production. Phase 4+ automation. |
| Venue offboards with pending disputes | Medium | Medium | Offboarding runbook keeps `connectAccountId` 180+ days. Avoqado support assists with evidence. ToS covers post-offboarding obligations. |

---

## 13. Out of scope (explicit) — MVP

- ❌ `card_hold` deposit mode (Phase 4+)
- ❌ Stripe Elements / embedded UI (Phase 4+)
- ❌ Multi-currency (MX-only MVP)
- ❌ Async payment methods OXXO/SPEI (Phase 4+)
- ❌ Migration of credit packs to Connect (separate ticket)
- ❌ Avoqado-side dispute evidence UI (Stripe Dashboard manual for MVP)
- ❌ Custom payout schedule per-venue UI (defaults: T+7 first 90 days, T+2 after)
- ❌ Refund partial amounts (Phase 4+; MVP only refunds full)
- ❌ Apple Pay / Google Pay as a guaranteed feature (Checkout may show wallets when conditions align; not a blocker if absent)
- ❌ Android POS deposit display actions (read-only in v2.3.x)
- ❌ Reservation reschedule with new deposit (Phase 4+)
- ❌ Automated CFDI emission for application fee (manual in MVP, see §11 Q1)

**Now in scope (moved from v1's "deferred"):**
- ✅ Payout delay (Phase 1, implementation-gated; fail closed if Stripe rejects settings)
- ✅ Reserve hold framework (Phase 1, pending Stripe verification of mechanism)
- ✅ Offboarding runbook + tooling (Phase 3)
- ✅ Webhook controller error semantics fix (Phase 1+2)
- ✅ ToS clause for venue chargeback liability (Phase 2 gate)
- ✅ `MoneyAnomaly` table + on-call alerts (Phase 2)
- ✅ Pre-check merchant before Reservation INSERT (Phase 2)
- ✅ Refund lifecycle as separate fields + enum (Phase 3 schema)

**Production gates (not deferred — must complete before first live charge):**
- 🔒 Confirm `controller.losses.payments` connected-account setting with Stripe account manager
- 🔒 Confirm current Stripe MX minimum charge value, set `STRIPE_MIN_CHARGE_MXN_CENTS`
- 🔒 Verify dispute/application-fee ledger behavior with a direct-charge test dispute
- 🔒 Accountant signoff on manual CFDI process for application fees
- 🔒 Legal signoff on ToS clause for venue chargeback liability
- 🔒 Document liability runbook (`docs/runbooks/stripe-connect-liability.md`)

---

## 14. References

### Stripe documentation
- [Connect charge types](https://docs.stripe.com/connect/charges) — direct vs destination decision
- [Direct charges](https://docs.stripe.com/connect/direct-charges) — the model used in this spec
- [Accounts v2](https://docs.stripe.com/connect/accounts-v2) — connected account creation model for new platforms
- [Connected account configuration](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration) — controller properties / responsibilities
- [Refunds for Connect](https://docs.stripe.com/connect/direct-charges#issue-refunds) — explicit `refund_application_fee` for direct charges
- [Connect webhooks](https://docs.stripe.com/connect/webhooks) — Connect endpoint vs platform endpoint, `event.account` semantics
- [Idempotency](https://docs.stripe.com/api/idempotent_requests)
- [Checkout expiration](https://docs.stripe.com/payments/checkout/abandoned-carts)
- [Statement descriptors](https://docs.stripe.com/get-started/account/statement-descriptors)
- [Account links](https://docs.stripe.com/api/account_links)
- [Payout schedule configuration](https://docs.stripe.com/payouts#payout-schedule)

### Existing code references
- `prisma/schema.prisma:3118-3175` — `EcommerceMerchant` model
- `prisma/schema.prisma:7644-7650` — `DepositStatus` enum (existing values include `FORFEITED`)
- `prisma/schema.prisma:7699-7703` — `Reservation` deposit fields
- `prisma/schema.prisma:7845-7849` — `ReservationSettings` deposit config
- `src/controllers/webhook.controller.ts:25,52,89-91` — current webhook handler (signature verification + bug at L89)
- `src/services/sdk/blumon-ecommerce.service.ts` — existing Blumon implementation (wrapped in Phase 0)
- `src/services/sdk/blumon-ecommerce.interface.ts` — Blumon-specific interface (subordinated to `IEcommerceProvider`)
- `src/services/dashboard/paymentLink.service.ts:83-100` — existing `EcommerceMerchant` lookup pattern
- `src/services/dashboard/creditPack.public.service.ts:223` — existing platform `stripe.checkout.sessions.create`
- `src/controllers/public/reservation.public.controller.ts:222-229` — `calculateDepositAmount` integration point
- `src/services/stripe.webhook.service.ts` — webhook handlers (becomes platform-endpoint specific)
- `src/services/dashboard/reservation.dashboard.service.ts` — reschedule handler
- `src/jobs/abandoned-orders-cleanup.job.ts` — reference pattern for new cron jobs

### Industry references for charge type validation
- Resy (American Express) — venue/service-provider direct-charge style marketplace
- Tock (Squarespace) — venue/service-provider direct-charge style marketplace
- Mindbody — direct charges
- Calendly Premium — direct charges

---

## 15. Approval criteria for reviewer (round 4 / implementation planning gate)

This spec is ready to move to implementation planning when the reviewer confirms:

**Already approved in round 2:**
- ✅ Architecture (§3.1, §4) — direct charges, with explicit liability nuance for `controller.losses.payments`
- ✅ Webhook routing (§10.2) — two endpoints, two secrets, `event.account` is source of truth (not inbound headers)
- ✅ Reservation state model (§3.6) — derived `PAYMENT_PENDING`, no new enum value, transitions explicit
- ✅ Provider abstraction (§6) — `connectAccountId` in `providerCredentials` JSON, shadow column for routing
- ✅ Out of scope (§13) — list accepted as-is

**Round 3 fixes now incorporated in v2.3:**
- ✅ Accounts v2 / controller properties (§3.1, §5 Phase 1) — `dashboard=full` with `losses_collector=stripe`; no silent legacy `type: 'express'` account creation for new accounts
- ✅ Idempotency contracts (§8.2) — **poison-event–safe single-transaction** pattern; divergent states commit `ProcessedStripeEvent + MoneyAnomaly` exactly once
- ✅ Pre-check merchant flow (§5 Phase 2) — no Reservation INSERT until `chargesEnabled` confirmed; authoritative slot conflict check still runs inside DB Tx1
- ✅ Refund lifecycle separation (§7) — `refundStatus` + `refundProcessorRef` + `refundRequestedAt` + `refundFailedReason` fields; `RefundStatus` enum (PENDING/SUCCEEDED/FAILED); no phantom states in `DepositStatus`
- ✅ Webhook payment_status defense (§5 Phase 2) — verify `session.payment_status === 'paid'` before confirming, even card-only
- ✅ `expires_at` clamp (§3.4 + §5 Phase 2) — migrate `depositPaymentWindow` to minutes; clamp `[30min, 24h]`; settings UI rejects out-of-range
- ✅ Min/max charge env vars (§4.4 + §5 Phase 2 + §11 Q11) — compare cents-to-cents after `toStripeAmount`
- ✅ Schema migrations (§7) — `RefundStatus` enum + 5 new fields on `Reservation` + `MoneyAnomaly` table with unique event/category
- ✅ Production gates list (§13) — hard gates documented; none can be skipped before first live charge

**Still needs external/business confirmation before production, not before implementation planning:**
- [ ] `controller.losses.payments` actual account behavior confirmed with Stripe
- [ ] Stripe MX minimum charge confirmed and env set
- [ ] Dispute/application-fee ledger behavior verified with a direct-charge test dispute
- [ ] Accountant signoff on manual CFDI process
- [ ] Legal signoff on venue chargeback-liability ToS clause

If approved, next step is to invoke `superpowers:writing-plans` skill to break Phases 0-3 into bite-sized tasks for subagent execution.
