# Task 5 — round-one correction plan

Status: read-only proposal; production implementation paused by root. No schema change proposed. Root owns verification and the implementation window.

## Evidence

`/Users/amieva/.claude/avq-verify/run-avoqado-server.dpgwaJ/out-local.txt` contains nine review cases: seven behavioral failures and two passing controls. Failures are commission net 10 instead of 0 after refund; same-payment goal rate 0.1 instead of 0.2; mixed legacy/TPV tier 1 instead of 2; 13 unused Payment SUM queries; fully refunded referral QUALIFIED instead of VOID; one grant minted while a refund held the Order lock; and zero refund-commit obligations instead of COMMISSION plus REFERRAL. The race reached an observed PostgreSQL lock wait: merely adding a later lock is insufficient; eligibility must be read after acquiring the Order lock.

The genuine PostgreSQL `SELECT 1 / 0` savepoint recovery and delivered referral reward revocation/replay controls passed. Original outbox15, boundary7 (including synthetic card/tracked stock), timezone2, job2 and loyalty5 passed. These results establish their tested scope, not final module approval. Root's unrelated Task4 failures are outside this correction.

## 1. Persist refund obligations against original commission policy

Add a transaction-aware refund-effect producer in `paymentEffects.service.ts`, invoked after the completed refund Payment and financial tracking rows exist, before returning from the financial transaction in `refund.tpv.service.ts`. Use exact `processorData.originalPaymentId`, with same venue/order validation. Add the same narrow hook in `refund.dashboard.service.ts`: its linked refund can also precede delivery of a TPV commission. The mobile refund creates a new placeholder order without original-payment linkage; do not infer linkage there.

In `commission-calculation.service.ts`, factor the existing reversal-data calculation into a shared helper. Read original committed calculations and undelivered frozen commission plans for the exact original payment, deduplicated by original configuration and recipient. Preserve the original rate, recipient, tier and all existing reversal arithmetic: absolute refunded amount plus tip, divided by original base; proportional original tip/discount/tax/gross/net. Do not introduce a cap or a new partial-refund policy. A delivered original calculation wins over its corresponding snapshot representation; status transitions are protected by the Order lock.

Persist negative frozen COMMISSION obligations using a refund-payment/configuration/recipient versioned dedupe key. Positive and negative plans may execute in either order; their eventual net and each original policy remain intact. Existing application lookup by payment/configuration/recipient prevents repeated materialization. Keep `createRefundCommission` compatible for current callers by sharing this source resolution and reversal helper under a transaction; its replay cannot duplicate a pending or delivered reversal. Do not discard a positive captured plan to hide the refund.

If an original snapshot is already a manual-review policy error, persist a corresponding sanitized review obligation rather than guessing its rate or silently dropping reversal work. Retain the existing bounded worker and public error-code visibility. No new financial policy lookup belongs in the refund commit.

Validation: existing net-zero/replay and financial-commit RED cases; add dashboard commit-gap coverage and pending/manual-review source coverage before those additional branches are implemented.

## 2. Serialize referral eligibility and reversal, with durable refund reconciliation

Extract the existing full-reversal predicate into a small shared referral reader accepting a transaction client; avoid the current qualification/refund import cycle. Preserve its exact policy: cancelled/deleted/refunded orders, or completed refund merchandise amounts covering order total excluding tip within existing tolerance. Partial refunds retain rewards.

Acquire the tenant-scoped Order lock at the start of qualification, before reading PAID state or refunds. Under that lock, a fully reversed order voids its pending referral with ORDER_REFUNDED and cannot qualify or mint rewards. If qualification commits first, the existing qualified-referral reversal path handles the later refund.

Refactor the existing qualified-referral reversal transaction into a reusable throwing internal operation, with Order acquired before referral/customer/grant writes. The public hooks retain their existing logging/error contract. The worker uses the throwing operation so a swallowed error cannot acknowledge DONE. Reuse the existing reward revocation implementation: used/redeemed rewards, fulfilled manual rewards and lifetime unlocks retain their current behavior.

The refund financial producer also writes one REFERRAL reconciliation obligation, deduped by refund payment, with an explicit refund operation in its payload. The handler dispatches this operation before the ordinary PAID qualification check; no second reward loop. On replay it reconciles pending or qualified referrals under the same Order lock and existing idempotent state transitions. Success then uses the existing claim-token completion fence.

Validation: pending full refund, actual coupon issuance/revocation/replay, observed refund-lock race and commit-gap tests. Add a forced reconciliation error/retry check before changing the worker acknowledgement behavior.

## 3. Make earlier plans visible within one payment

Allow `freezePaymentCommissionInTx` to deliver each frozen plan through an awaited callback. `enqueuePaymentCommissionInTx` supplies a callback that persists each obligation immediately within the existing savepoint. Subsequent configuration calculations then see earlier plans through the combined progress query, matching prior synchronous ordering. Preserve deterministic configuration ordering, frozen JSON, dedupe and all-or-nothing rollback of optional snapshot work on a SQL statement error.

Keep the existing returned-array interface only where tests or other callers require it; the financial producer must use incremental persistence. Do not insert the plans a second time after the loop.

Validation: same-payment category/goal RED, existing cross-payment pending tiers, category reservation, policy-error savepoint and replay tests.

## 4. Share progress and serialization across commission producers

Make the public synchronous `createCommissionForPayment` enter a transaction when no client is supplied, then call its internal implementation with that client. Acquire the Order lock, then sorted recipient StaffVenue locks before calculating any rate. Snapshot callers already inside the financial transaction reuse their client and the same lock ordering; no nested transaction.

Use the single committed-plus-pending aggregate for producer tier/goal decisions and pending category-base reservations. Remove client-identity or sink-presence as a proxy for whether pending earned progress matters. Preserve dashboard reporting APIs separately from producer policy reads.

The split producer intentionally skips TIERED rates; retain that rule. Audit it for pending category-base reservation and shared recipient serialization, and add a focused mixed pending/split regression before modifying that branch. Do not add new tier behavior under the guise of parity.

Worker application keeps Order before effect locks. An Order lock protects representation transitions for that order; the single MVCC aggregate prevents double/missing progress while another order's pending plan becomes a calculation. Financial refund writers retain their existing Order-before-Payment order; no helper may acquire Order after first taking a Payment lock.

Validation: mixed legacy/TPV RED plus focused mixed goal and split reservation controls; existing immutable rate/recipient and replay tests.

## 5. Read only the goal policy needed for the rate

Add policy-only readers in the approved goal services. Resolve the same staff-specific threshold first, then the same effective venue-versus-organization monthly fallback used today. Venue active-goal precedence must remain intact even when no venue monthly goal exists. Read existing module configuration without creating it. Select only needed organization policy fields with a bounded lookup; avoid loading/enriching every organization goal.

Do not call `enrichGoal`, `calculateCurrentSales`, repeated venue-timezone readers or Payment sales aggregates from financial policy resolution. Reuse the commission progress already computed for the rate. Keep existing dashboard/reporting enrichment functions unchanged.

Validation: zero unused report SUM queries RED, staff/venue/org precedence and missing-module controls. Preserve negative-control behavior for no active commission configuration.

## Integration and verification order

After root opens the window: implement incremental plans, producer parity and policy-only reads; implement shared refund snapshot handling and durable producers; implement referral locking/reconciliation. Keep production edits within the approved services. Root-owned terminal-payment/socket/MCP files and schema remain untouched.

Before broadening dashboard, split or failure-policy branches, prepare their focused RED cases for root. Root then runs the review suite and all existing Task5 controls, affected commission/refund/referral module tests and project typecheck through avq-verify. Update stale mocks only after inspecting failures. No final approval is implied by this plan or by individual GREEN cases.
