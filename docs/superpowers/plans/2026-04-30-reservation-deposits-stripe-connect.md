# Reservation Deposits via Stripe Connect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans` when available.
> Implement task-by-task. Do not skip verification steps. This feature moves real money.

**Spec:** `docs/superpowers/specs/2026-04-30-reservation-deposits-stripe-connect-design.md` v2.4.

**Goal:** Let venues require online reservation deposits/prepayment through Stripe Connect direct charges. The PaymentIntent lives on the connected account, Avoqado collects an application fee, reservations are confirmed only after paid webhook processing, and refunds/forfeits/offboarding are operationally safe.

**Architecture:** Add a provider abstraction around existing ecommerce payments, onboard venues to Stripe Connect through Accounts v2/controller properties, create Stripe Checkout Sessions as direct charges with `{ stripeAccount: connectAccountId }`, process Connect webhooks through a dedicated endpoint, and use idempotent DB transactions plus reconciliation jobs to handle retries/races.

**Non-negotiables:**
- Use latest Stripe SDK/API possible; target API version `2026-02-25.clover` or newer.
- Do not silently use legacy `accounts.create({ type: 'express' })`; any v1 fallback needs a code comment and re-review.
- Do not configure `dashboard=express` if the account is expected to use `losses_collector=stripe`; Stripe requires Full Dashboard for that responsibility split.
- Do not call Stripe inside DB transactions.
- Do not mark a reservation `CONFIRMED` until `checkout.session.completed` with `payment_status === 'paid'`.
- All money uses `Prisma.Decimal` internally; convert to Stripe centavos only at provider boundary.
- Webhook event insert and reservation mutation must commit in the same transaction, except anomaly path which commits `ProcessedStripeEvent + MoneyAnomaly`.
- Every query must remain venue-scoped unless processing a Stripe webhook by globally unique Stripe IDs.

**External production gates:** These block live charges, but not implementation in test mode.
- Confirm `controller.losses.payments` / Accounts v2 `losses_collector=stripe` connected-account responsibility with Stripe.
- Confirm Stripe MX minimum charge and set `STRIPE_MIN_CHARGE_MXN_CENTS`.
- Verify dispute/application-fee ledger behavior with a test direct-charge dispute.
- Accountant signoff on manual CFDI process for application fees.
- Legal signoff on venue ToS chargeback-liability clause.

---

## File Structure

### Backend (`avoqado-server`)

| Action | File | Responsibility |
|---|---|---|
| Modify | `prisma/schema.prisma` | Add Connect provider fields, reservation checkout/refund fields, event/anomaly tables, minute-based deposit window comment |
| Create | `prisma/migrations/*reservation_deposits_stripe_connect*/migration.sql` | Schema migration and `depositPaymentWindow` hours-to-minutes backfill |
| Create | `src/services/payments/providers/provider.interface.ts` | Provider-agnostic ecommerce contract |
| Create | `src/services/payments/providers/money.ts` | Decimal/centavo conversion helpers |
| Create | `src/services/payments/providers/blumon.provider.ts` | Wrapper around current Blumon ecommerce SDK |
| Create | `src/services/payments/providers/stripe-connect.provider.ts` | Stripe Connect onboarding, Checkout, status, refund, webhook verification |
| Create | `src/services/payments/provider-registry.ts` | Resolve provider by `PaymentProvider.code` |
| Modify | `src/services/dashboard/paymentLink.service.ts` | Route existing payment-link flow through provider abstraction |
| Create | `src/controllers/dashboard/stripeConnect.controller.ts` | Dashboard onboarding/status endpoints |
| Create | `src/routes/dashboard/stripeConnect.routes.ts` | Dashboard routes with existing permission/auth pattern |
| Modify | `src/routes/dashboard.routes.ts` | Mount Stripe Connect dashboard routes |
| Create | `src/controllers/webhooks/stripePlatformWebhook.controller.ts` | Platform billing webhook endpoint |
| Create | `src/controllers/webhooks/stripeConnectWebhook.controller.ts` | Connect webhook endpoint |
| Modify | `src/controllers/webhook.controller.ts` | Preserve/alias existing platform webhook behavior during migration |
| Create | `src/services/webhooks/stripe-connect-webhook.service.ts` | Connect event handlers, idempotency, anomaly handling |
| Modify | `src/services/public/reservation.public.service.ts` or relevant controller/service | Two-phase reservation+checkout flow |
| Modify | `src/controllers/public/reservation.public.controller.ts` | Return checkout URL and enforce provider/min/max prechecks |
| Create | `src/jobs/reservation-deposit-reconciliation.job.ts` | Expiry/orphan reconciliation |
| Create | `src/jobs/connect-account-graduation.job.ts` | Payout-delay graduation after 90 days clean |
| Create | `src/jobs/refund-retry.job.ts` | Retry pending reservation refunds |
| Modify | `src/server.ts` or job bootstrap | Register new jobs |
| Create | `docs/runbooks/stripe-connect-liability.md` | Losses, disputes, app-fee ledger behavior |
| Create | `docs/runbooks/connect-account-offboarding.md` | Offboarding procedure |
| Create/Modify | `tests/**` | Unit/API tests listed below |

### Frontend (`avoqado-web-dashboard`)

| Action | File | Responsibility |
|---|---|---|
| Modify/Create | venue settings payments area | Stripe onboarding CTA/status/errors |
| Modify | reservation settings UI | `depositPaymentWindow` minutes validation `[30, 1440]` |
| Modify | public booking flow | Redirect to Stripe Checkout when `checkoutUrl` exists |
| Create | `BookingPaymentReturn` page | Success/cancel UX that polls server state |
| Modify | dashboard reservation views | Derived `PAYMENT_PENDING`, paid/refunded/forfeited/disputed badges |
| Modify/Create | services/hooks | Dashboard API calls for onboarding/status |

---

## Phase 0 — Provider Abstraction

**Exit criteria:** existing Blumon payment-link behavior still works through `IEcommerceProvider`; Stripe provider exists but only onboarding helpers are functional or stubbed safely.

- [ ] Read existing ecommerce code paths:
  - `src/services/dashboard/paymentLink.service.ts`
  - `src/services/sdk/blumon-ecommerce.service.ts`
  - `src/services/sdk/blumon-ecommerce.interface.ts`
  - `prisma/schema.prisma` `EcommerceMerchant`, `PaymentProvider`, `CheckoutSession`, `PaymentLink`

- [ ] Create `src/services/payments/providers/provider.interface.ts` matching spec §6.

- [ ] Create `src/services/payments/providers/money.ts`.
  - Implement `toStripeAmount(decimal: Prisma.Decimal): number`.
  - Implement `fromStripeAmount(cents: number): Prisma.Decimal`.
  - Implement `calculateApplicationFee(stripeAmountCents: number, feeBps: number): number`.
  - Reject negative/unsafe/non-integer values.

- [ ] Add tests for `money.ts`.
  - Round-trip all two-decimal values in `[0, 50000.00]`.
  - Edge: `0.005 -> 1`, `0.004 -> 0`.
  - App fee: `calculateApplicationFee(100000, 100) === 1000`.
  - Negative amount throws.

- [ ] Create `BlumonProvider`.
  - Wrap current `blumon-ecommerce.service.ts`.
  - Preserve existing payment-link API semantics.
  - Throw typed `NotImplementedError` for unsupported Connect-only methods.

- [ ] Create `StripeConnectProvider` shell.
  - Constructor initializes Stripe with pinned API version.
  - Methods not implemented in Phase 0 throw typed `NotImplementedError`.
  - Do not import Stripe directly outside this provider except existing SaaS billing service.

- [ ] Create `provider-registry.ts`.
  - `getProvider(merchantWithProvider): IEcommerceProvider`.
  - Switch on `merchant.provider.code`.
  - Known codes: existing Blumon code, `STRIPE_CONNECT`.

- [ ] Refactor `paymentLink.service.ts` to use provider registry.
  - Keep request/response behavior stable.
  - No Stripe deposit behavior in this phase.

- [ ] Verify Phase 0.
  - Run unit tests for provider/money.
  - Run existing payment-link tests if present.
  - Smoke compile TypeScript.

---

## Phase 1 — Stripe Connect Onboarding + Risk Controls

**Exit criteria:** dashboard can create/refresh a Stripe onboarding link, status sync persists `chargesEnabled/payoutsEnabled/requirementsDue`, and no money flow exists yet.

- [ ] Prisma migration: `EcommerceMerchant` additions.
  - `providerMerchantId String?`
  - `onboardingStatus OnboardingStatus @default(NOT_STARTED)`
  - `chargesEnabled Boolean @default(false)`
  - `payoutsEnabled Boolean @default(false)`
  - `requirementsDue String[] @default([])`
  - `onboardingLinkUrl String?`
  - `onboardingLinkExpiry DateTime?`
  - `platformFeeBps Int @default(100)`
  - `reserveBps Int?`
  - `offboardingInitiatedAt DateTime?`
  - `@@unique([providerId, providerMerchantId])`

- [ ] Prisma migration: add `OnboardingStatus` enum.
  - `NOT_STARTED`, `IN_PROGRESS`, `COMPLETED`, `RESTRICTED`

- [ ] Seed `PaymentProvider` row for `STRIPE_CONNECT`.
  - Use idempotent seed script or migration-safe SQL.

- [ ] Implement Accounts v2 creation inside `StripeConnectProvider`.
  - Inputs: venue/merchant, `businessType` from dashboard wizard.
  - Set country `MX`.
  - Configure controller properties per spec.
  - Use `dashboard=full`, `losses_collector=stripe`, and `fees_collector=stripe`; do not use Express Dashboard for this liability model.
  - Request card payments + transfers.
  - Store `connectAccountId` in `providerCredentials`.
  - Store same ID in `providerMerchantId`.
  - Fail closed if Accounts v2 is unavailable; do not silently downgrade.

- [ ] Implement payout-delay helper.
  - Target T+7 for first 90 days.
  - If Stripe refuses the setting, mark merchant `RESTRICTED` or leave onboarding incomplete and create ops log.

- [ ] Implement fresh Account Link creation.
  - Generate on every dashboard click unless a known-unused valid link exists.
  - Store URL/expiry for debugging only.
  - Never rely on cached links for correctness.

- [ ] Implement onboarding status retrieval/sync.
  - Retrieve connected account.
  - Persist `chargesEnabled`, `payoutsEnabled`, `requirementsDue`, `onboardingStatus`.
  - Derive `COMPLETED` only when charges and payouts are both enabled and no blocking requirements exist.

- [ ] Add dashboard endpoints.
  - `POST /api/v1/dashboard/venues/:venueId/ecommerce-merchants/stripe-onboard`
  - `GET /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/onboarding-status`
  - Use existing auth/permission middleware pattern.

- [ ] Add Connect webhook endpoint shell.
  - `POST /api/v1/webhooks/stripe/connect`
  - Verify with `STRIPE_CONNECT_WEBHOOK_SECRET`.
  - Handle `account.updated` by providerMerchantId.

- [ ] Add platform webhook endpoint split.
  - Existing SaaS billing events go to `/api/v1/webhooks/stripe/platform`.
  - Keep old route alias for one release if needed.
  - Stop swallowing transient processing errors for new endpoint.

- [ ] Frontend dashboard.
  - Add "Pagos online" section.
  - States: not started, in progress, restricted, completed.
  - Business type selector: persona fisica/moral.
  - Poll onboarding status for 30s after return.

- [ ] Verify Phase 1.
  - Unit tests for status derivation.
  - Webhook fixture test for `account.updated`.
  - Manual Stripe test onboarding.
  - Confirm no reservation/payment-link behavior changed.

---

## Phase 2 — Reservation Deposit Checkout

**Exit criteria:** reservation with required deposit creates a Stripe Checkout Session on the connected account; webhook confirms the reservation; expiry/orphan reconciliation works.

- [ ] Prisma migration: `Reservation` additions.
  - `checkoutSessionId String?`
  - `depositExpiresAt DateTime?`
  - `idempotencyKey String? @unique`
  - `refundStatus RefundStatus?`
  - `refundRequestedAt DateTime?`
  - `refundProcessorRef String?`
  - `refundFailedReason String?`
  - `refundRetryCount Int @default(0)`
  - indexes from spec.

- [ ] Prisma migration: `DepositStatus` additions.
  - Add only `EXPIRED`, `DISPUTED`.
  - Do not add `FORFEITED`; it already exists.

- [ ] Prisma migration: `RefundStatus` enum.
  - `PENDING`, `SUCCEEDED`, `FAILED`

- [ ] Prisma migration: `ProcessedStripeEvent`.
  - `@@unique([endpoint, stripeEventId])`.
  - Store payload for audit.

- [ ] Prisma migration: `MoneyAnomaly`.
  - `@@unique([stripeEventId, category])`.

- [ ] Prisma migration: `ReservationSettings.depositPaymentWindow` semantic change.
  - Backfill existing hour values to minutes.
  - Update schema comment to `minutes to complete payment`.

- [ ] Implement `StripeConnectProvider.createCheckoutSession`.
  - Use Checkout Sessions `mode: 'payment'`.
  - Direct charge via request option `{ stripeAccount: connectAccountId }`.
  - MVP: `payment_method_types: ['card']`.
  - `payment_intent_data.application_fee_amount`.
  - Metadata: reservationId, venueId, merchantId, type.
  - `expires_at = depositExpiresAt`.
  - Idempotency key from reservation.

- [ ] Implement public reservation prechecks.
  - If deposit not required, preserve existing flow.
  - If deposit required, resolve active Stripe Connect merchant before INSERT.
  - If missing/disabled/restricted, return 422 `payment_provider_not_configured`.
  - Convert deposit amount to cents and compare against min/max env vars.
  - Validate venue country/currency is MX/MXN.

- [ ] Implement two-phase reservation creation.
  - Fast precheck availability before tx.
  - Authoritative slot conflict check inside Tx1.
  - Insert `(status=PENDING, confirmedAt=null, depositStatus=PENDING)`.
  - Commit.
  - Call Stripe outside transaction.
  - Tx2 persists `checkoutSessionId`.
  - Return `{ reservationId, checkoutUrl }`.

- [ ] Implement Connect webhook handlers.
  - `checkout.session.completed`: require `payment_status === 'paid'`.
  - `checkout.session.expired`: cancel pending reservation and mark `EXPIRED`.
  - `charge.dispute.created`: mark `DISPUTED`, alert dashboard/support.
  - `charge.refunded`: update refund/deposit status idempotently.

- [ ] Implement webhook idempotency transaction.
  - Insert `ProcessedStripeEvent` and mutate reservation in one transaction.
  - Duplicate event returns 200.
  - Transient DB error returns 500.
  - Divergent state commits `ProcessedStripeEvent + MoneyAnomaly`, returns 200, pages on-call.

- [ ] Implement reconciliation job.
  - Pending + expired sessions: retrieve Checkout Session on connected account.
  - Complete session: run same idempotent paid handler.
  - Expired/not found: cancel reservation and mark `EXPIRED`.
  - Orphan reservations with idempotencyKey but no checkoutSessionId older than 5 min: retry create session with same key.

- [ ] Frontend public booking.
  - Redirect to `checkoutUrl` when present.
  - Add payment return page.
  - Poll server state; do not trust localStorage for correctness.

- [ ] Frontend dashboard reservation state.
  - Derived `PAYMENT_PENDING`.
  - Badges for PAID, REFUNDED, FORFEITED, DISPUTED, EXPIRED.

- [ ] Verify Phase 2.
  - E2E test mode: reserve -> Checkout -> card `4242` -> webhook -> CONFIRMED+PAID.
  - Expiry webhook test.
  - Reconciliation expiry test.
  - Orphan retry test.
  - Duplicate webhook test.
  - Paid-after-cancel anomaly test.
  - Concurrent slot reservation test.

---

## Phase 3 — Refund, Forfeit, Offboarding

**Exit criteria:** cancellations/refunds/forfeits behave correctly, offboarding disables new charges while preserving existing obligations, and runbooks exist.

- [ ] Implement refund job/service.
  - Full refunds only in MVP.
  - `stripe.refunds.create({ payment_intent, refund_application_fee: true }, { stripeAccount, idempotencyKey })`.
  - Deterministic idempotency key: `refund:${reservationId}:v1`.
  - Store `refundStatus`, `refundRequestedAt`, `refundProcessorRef`, `refundFailedReason`, `refundRetryCount`.

- [ ] Modify cancellation flow.
  - If no paid deposit, preserve current cancellation behavior.
  - If `forfeitDeposit=false` and within cancellation window: enqueue/perform refund.
  - Reservation can be `(CANCELLED, depositStatus=PAID, refundStatus=PENDING)` while refund is in flight.
  - On refund success: `depositStatus=REFUNDED`, `refundStatus=SUCCEEDED`.
  - On retry exhaustion: `refundStatus=FAILED`, alert superadmin.

- [ ] Implement forfeit/no-show logic.
  - Late cancel with `forfeitDeposit=true`: no refund; `depositStatus=FORFEITED`.
  - No-show with paid deposit: retain deposit; audit log.
  - Do not invent new `DepositStatus` values.

- [ ] Implement offboarding endpoint.
  - `POST /api/v1/superadmin/venues/:venueId/offboard-payments`.
  - Disable new charges (`EcommerceMerchant.active=false`, `chargesEnabled=false`).
  - Preserve `connectAccountId/providerMerchantId`.
  - Return open disputes, pending refunds, unsettled balances/payouts if available.

- [ ] Write runbooks.
  - `docs/runbooks/connect-account-offboarding.md`.
  - `docs/runbooks/stripe-connect-liability.md`.
  - Include production gates and manual dispute/refund procedures.

- [ ] Verify Phase 3.
  - Pay deposit -> cancel in window -> refund + app fee refund.
  - Pay deposit -> late cancel -> forfeited.
  - Pay deposit -> no-show -> stays PAID with audit log.
  - Offboard venue -> new deposit reservations blocked; existing refund/dispute workflows still possible.

---

## Implementation Order

1. Phase 0 backend provider/money abstraction.
2. Phase 1 backend schema + Stripe onboarding.
3. Phase 1 dashboard onboarding UI.
4. Phase 2 backend reservation checkout + webhooks.
5. Phase 2 public booking UI.
6. Phase 2 reconciliation/anomaly tests.
7. Phase 3 refund/forfeit/offboarding.
8. Runbooks + production gate checklist.

Do not start Phase 2 before Phase 1 can prove `chargesEnabled=true` on a test connected account.

---

## Verification Commands

Run from `avoqado-server` unless noted:

```bash
npx prisma validate
npx prisma generate
npm test -- --runInBand
npm run typecheck
```

Run from `avoqado-web-dashboard` after frontend changes:

```bash
npm run typecheck
npm test
npm run build
```

If these scripts differ in the repo, inspect `package.json` and use the local equivalents. Do not invent new scripts just for this feature.
