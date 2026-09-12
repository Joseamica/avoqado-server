# Task 2 — TPV durable admission/cancellation/result

Status: implementation complete; root-coordinated GREEN verification pending. No commits, branch changes, push, deployment, DB writes or hardware interaction.

## Files (avoqado-tpv)

- `app/src/main/java/com/jaac/avoqado_tpv/core/remotepayment/RemotePaymentCoordinator.kt`: removed UI cancellation bus and unconditional false cancellation persistence; cancellation delegates to atomic inbox decision.
- `.../remotepayment/RemotePaymentInbox.kt`: cancellation dispositions, received-only rejection, final-status guard, persisted-result replay and late real approval precedence.
- `.../remotepayment/RemotePaymentRequestDao.kt`: atomic RECEIVED-to-RESOLVED admission competing with claim; compare-and-set final-result upgrade. No entity/schema change, no migration required.
- `.../data/realtime/SocketManager.kt`: durable ACK even if navigation queue full; reject only unclaimed command; direct cancellation handler works before Home collector exists; additive `terminal:payment_cancel_disposition` and `terminalPaymentCancelDispositionVersion=1`; final result emission uses durable winner.
- `.../presentation/navigation/AppNavigation.kt`: readiness awaits before claim, then route/busy check and navigation without a suspension; removed remote cancellation navigation that could destroy SDK result owner; schedules unique ledger recovery on reconnect; persistent Home warning shows current-venue unresolved count and links to existing Support. Collection keyed by venue resets immediately on activation change.
- `.../presentation/viewmodels/HomeViewModel.kt`: cancellation now handled by SocketManager; legacy event type retained.
- Tests: `core/remotepayment/RemotePaymentInboxTest.kt`, `RemotePaymentCoordinatorTest.kt`, `RemotePaymentInboxRoomTest.kt`, `core/data/realtime/SocketManagerTest.kt`.
- `CHANGELOG.md`: documented fix.

## Contract

`ACCEPTED` only after Room CAS resolves RECEIVED before claim. PROCESSING (or unknown identity) => `ACTIVE` with no fabricated payment result and no UI navigation. RESOLVED => `ALREADY_RESOLVED` plus actual durable result, including success. Cancellation after claim is conservatively declined even before card insertion; the cashier cancels on terminal. Same-identity PROCESSING replay ACKs only, never opens SDK. Final success outranks historical false cancelled/failed data; later failure cannot overwrite success. Timeout/unknown are not financial finals and cannot resolve inbox.

No new execution-idle capability or release event is advertised. The original sale remains protected while uncertain. Server-side event authentication/state transitions are root-owned.

## RED evidence

- Prior valid RED: `/Users/amieva/.claude/avq-verify/run-avoqado-tpv.rNIFYD/out-local.txt`: coordinator false cancellation and queue-full ACK assertion failures. Its Room errors were Java23/Robolectric ASM setup errors, **not behavioral RED**.
- Valid resumed RED: `/Users/amieva/.claude/avq-verify/run-avoqado-tpv.kR4Kpp/out-local.txt`: ACTIVE disposition missing, ACCEPTED disposition/result missing, durable ACK false on full queue, and timeout incorrectly resolving inbox. These fail with assertions. Room tests successfully execute in this run.
- Java runtime fix: Gradle runs with required Java23; Test tasks run Java17 using `-I task-2-room-java17.gradle` (saved alongside this report; runtime path is local Mac). No dependency or repo build configuration changed.
- Room tests validate current real DAO/CAS behavior; no claim that the original Room setup failure was a behavioral RED. Additional actual disk close/reopen test added after resumed RED to verify restart identity preservation.

## Offline / concurrency

- Remote commands need network. A received command is persisted before ACK, and final/cancelled result is persisted before emission.
- Death between persist and emit: duplicate same request returns durable JSON; death in PROCESSING: ACK-only and no second authorization. Closed/reopened on-disk Room database test covers persistent identity.
- A cancellation cannot destroy a claimed UI/SDK execution; late real approval persists and replays. Queue rejection atomically competes against claim and never fails an already claimed command.
- Reconnect schedules the existing unique WorkManager recovery; root's money worker owns durable payment registration context and execution.
- Actual hardware network-off/kill QA remains root-owned; this task did not run it or claim it passed.

## Restart visibility

Root approved persistent Home warning as part of recovery scope. It consumes `RemotePaymentCoordinator.observePendingObligationCount(venueId)` without direct DAO access. The combined aggregate includes orphaned PROCESSING inbox obligations and unresolved ledger rows, deduplicated by saved request identity; matched terminal outcomes are excluded. It displays the count, no-repeat instruction, and existing Support access; does not bypass the TOTP-protected processor browser. No new Compose test dependencies; count behavior gets Room tests, projection awaits final compilation and root-owned hardware verification.

## Verification pending

Root runs all Gradle through `scripts/avq-verify.sh`; do not run parallel builds. Target classes: `*RemotePayment*`, `*SocketManagerTest*`, plus money module suites. Use Java23 for Gradle and Java17 test init. Sandbox compiled during valid RED; final GREEN and production/Nexgo compilation remain root-coordinated.

## Independent review follow-up — implemented, GREEN pending

`task-2-review.md` identified a P2 visibility gap: death after inbox PROCESSING commit but before ledger insert leaves no ledger row for the Home count. Accepted: add one SQL aggregate over unresolved ledger attempts plus PROCESSING inbox rows without a matching same-venue ledger attempt. Match the exact Gson `terminalPaymentRequestId` key/string with `instr`, not wildcard LIKE or SQLite JSON1. No rows are loaded into navigation and no ambiguous orphan is retried or auto-resolved.

Additional inherited venue gap accepted for correction: queued request for venue A must not authorize under newly activated venue B. Ruling: match the durable row's venue atomically in claim; recheck current activation after the suspending claim. If no claim, never launch. If this collector owns the claim but activation changed before any SDK launch, record a safe pre-SDK failure. Do not infer absence of charge from an orphan created by a previous process.

Tests written and observed RED before implementation: on-disk restart count for claim/no-attempt, same-request mapping dedup and venue isolation, cancel during deferred readiness, wrong active venue, activation changed during claim, exactly-once admission of a ready matching request, and concurrent Room claim/cancel XOR winner. Root controls the RED/GREEN verification queue. Actual local busy-state changes during claim remain statically checked after claim in AppNavigation; no claim of Compose/hardware proof for that interleaving.


Follow-up RED confirmed in `/Users/amieva/.claude/avq-verify/run-avoqado-tpv.TOizsF/out-local.txt`: 157 tests, 10 failures overall, including the six intended Task2 failures (orphan visibility/reopen, projection dedup, wrong venue, activation during claim, ready exactly-once admission, cancellation during readiness). Concurrent Room claim/cancel test passed. Production stubs replaced after this evidence. Final combined GREEN remains root-owned.

The Home flow now comes from the coordinator's combined inbox/ledger scalar query, replacing the first ledger-only projection. A mapped PREPARANDO row still leaves the claimed remote obligation visible; mapped unresolved attempts count once, and mapped terminal ledger outcomes are excluded. DAO claim binds both requestId and current venue in its predicate. The coordinator rechecks activation after Room suspends; AppNavigation emits a pre-SDK failure only for its own claim when readiness failed or venue changed. An unclaimed wrong-venue request remains RECEIVED and never launches.

Scoped static review: sole production admission caller is AppNavigation and uses the new readiness+venue seam. Busy/route checks remain after the suspending admission and before navigation, with no intervening suspension. Scoped `git diff --check` is clean. No schema migration or unbounded record fetch was introduced.

Legacy caveat: older AngelPay ledger snapshots did not contain terminalPaymentRequestId. Exact identity dedup is possible for the new typed contexts and existing mapped contexts; historical unmapped obligations cannot safely be merged by amount/order heuristics. They remain visible rather than being silently discarded. Root notified to decide wording for any ambiguous legacy count.
