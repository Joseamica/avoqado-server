**Initial Task5 verdict: changes required.** Read-only review of scoped WIP against `HEAD`; no edits, tests, builds, DB operations, network mutations, or agents.

1. **P1 — A refund before commission delivery leaves an unreversed commission.**  
   [commission-calculation.service.ts:1324](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/dashboard/commission/commission-calculation.service.ts:1324)  
   Trigger: payment commits a frozen $10 commission, then gets refunded before the worker runs. `createRefundCommission()` reads only existing calculations and returns when none exist ([line 361](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/dashboard/commission/commission-calculation.service.ts:361)). The worker subsequently inserts the positive $10; nothing schedules the missing reversal.  
   **Minimal safe fix:** make refunds durably record reversals against pending frozen plans, with idempotent application under the same order lock. Preserve the original snapshot.  
   **Classification:** existing consumer gap made routine by the new deferred delivery.

2. **P1 — A fully refunded order can subsequently earn referral rewards.**  
   [paymentEffects.service.ts:91](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/tpv/paymentEffects.service.ts:91)  
   Trigger: refund the qualifying order while its referral effect remains pending. The refund hook only reverses `QUALIFIED` referrals, so it leaves this `PENDING` referral untouched. TPV refunds preserve the order’s paid balance/status; the worker’s `paymentStatus: 'PAID'` check therefore passes and `onOrderPaid()` qualifies the referral and can issue rewards after the full refund.  
   **Minimal safe fix:** serialize qualification and reversal using the order lock, check full reversal during qualification, and durably void pending referrals when fully refunded.  
   **Classification:** introduced integration regression from delaying the formerly immediate hook.

3. **P2 — Earlier commission plans from the same payment are invisible to later goal-rate calculations.**  
   [commission-calculation.service.ts:1294](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/dashboard/commission/commission-calculation.service.ts:1294)  
   The sink only appends to an array; effects are inserted after every configuration finishes. Example: staff progress is $90 toward a $100 goal. The first category rule contributes $20, then a second rule uses the goal bonus. Previously, that second rule saw $110; now it still sees $90 and permanently freezes the lower rate. The implemented pending-progress query cannot see these in-memory plans.  
   **Minimal safe fix:** insert each plan within the existing savepoint before calculating subsequent rules, or include accumulated plans in their progress calculation.  
   **Classification:** introduced regression; distinct from the known pending-tier test involving separate payments.

4. **P2 — Legacy commission callers ignore TPV’s pending progress.**  
   [commission-tier.service.ts:475](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/dashboard/commission/commission-tier.service.ts:475)  
   Pending obligations count only when `db !== prisma`. Payment-link callers still invoke `createCommissionForPayment()` with the default client. A TPV payment that reaches the next tier but remains queued is therefore invisible to a subsequent attributed payment-link sale; that sale receives the lower rate. The goal-based branch has the same distinction through `options.sink`.  
   **Minimal safe fix:** use committed-plus-pending progress consistently for all commission producers, with shared serialization for rate decisions.  
   **Classification:** introduced compatibility regression affecting existing callers.

5. **P2 — Optional goal lookup brings unbounded, unused reporting work into the financial transaction.**  
   [goal-resolution.service.ts:173](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/dashboard/commission/goal-resolution.service.ts:173)  
   With goal-based commissions and no staff-specific goal, the resolver enriches every active venue/org goal. Each enrichment performs another timezone lookup and sales aggregate inside the payment transaction, although the caller only consumes one goal threshold. Work grows with the number of goals while financial locks remain held. If it exhausts the interactive transaction deadline, the savepoint cannot rescue the payment commit.  
   **Minimal safe fix:** add a policy-only lookup for the required threshold; avoid report enrichment and reuse the already calculated progress.  
   **Classification:** preexisting query fan-out newly moved into the financial boundary. Latency was not measured.

The tests provide useful checks for committed producer rows, review rollback, stale-token rejection, receipt concurrency, pagination, and frozen rates. Their limits matter:

- Boundary tests inject an exception after commit; they do not terminate/restart a process. They use cash and itemless orders, so they do not establish card or tracked-inventory coverage.
- Referral coverage exercises a **no-referral** order, not qualification, reward issuance, or refund ordering.
- Snapshot-failure coverage injects a JavaScript rejection; it does not demonstrate recovery from a PostgreSQL statement error inside the savepoint.
- Neither mixed-channel tiers nor multiple goal-sensitive rules within one payment are covered.

I excluded Task4 findings and did not count the known cursor-status or sanitized manual-review-reason failures as new findings. Supplied GREEN results retain their stated scope; pending validation remains pending. `8bG5zj` is inconclusive, not test evidence.

The durable boundary is substantially implemented, but deferred rewards can still disagree with refunds and earned rates. These findings need fixes and focused PostgreSQL regressions before Task5 passes. Nothing is needed from you for this review; this is not a broader system or hardware readiness verdict.