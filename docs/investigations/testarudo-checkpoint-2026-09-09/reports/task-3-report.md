# Task 3 — POS unknown-result recovery (Android / iOS)

Status: implementation in progress; RED tests written, queued with root. No production changes yet.

## Confirmed existing defects
- Explicit charge-again override clears the durable unresolved request on both platforms.
- Service entry points can overwrite the pending request and POST a second authorization.
- Android direct 404/422 branches bypass cancellation reconciliation. Generic 409 is classified as definitive failure on both platforms.
- Recovery and success clear the single pending slot without matching its request identity.
- Legacy CANCELLED can originate from a watchdog; only ACCEPTED cancellation is sufficient to release protection.
- Existing durable key does not retain original venue / money / terminal context.

## Constraints retained
330-second payment ceiling; 3 bounded status probes with 500ms / 2s spacing; previous-sale result cannot pay a different sale; late approved result must remain recoverable; root owns cross-device server protection and physical sandbox tests.

## Verification
Pending coordinated avq-verify RED, GREEN module tests, Android compilation and iOS build.

## Offline acceptance
Target: visible unresolved state, durable identity/context before POST, no automatic authorization replay, bounded read-only recovery when connectivity returns. Physical offline testing is delegated to root and not claimed here.


## Resume implementation (2026-09-09)

Android valid initial RED: `/Users/amieva/.claude/avq-verify/run-avoqado-android.mr1Wpn/out-local.txt`, 96 tests / 6 failing behaviors.
iOS initial RED: `/Users/amieva/.claude/avq-verify/run-avoqado-ios.8rAkRp/out-local.txt`, 43 tests / 13 assertions, 1 unexpected (noVenue). Valid independent pure RED proves legacy CANCELLED and HTTP404/409/422 classification, override tests prove bypass. Existing durable-key tests also reported nil fixture keys; this is NOT claimed as valid product bug proof until checked Keychain status distinguishes unsigned-simulator failures.

Implemented on both: optional cancelDisposition, ACTIVE remains uncertain with terminal confirmation copy, CANCELLED requires ACCEPTED, POST404/409/422 reconciles, new authorization cannot overwrite unresolved identity, old recovery cannot clear newer identity, explicit override disabled and charge-again UI removed. Payment journal persists identity, original venue, terminal, order where available and amount/tip before POST. Android uses checked synchronous commit; iOS payment-only checked SecItemUpdate/Add (generic storage untouched). Legacy request key is honored. Venue switching recovers against original venue.

Files owned:
- Android `core/data/local/SecureStorage.kt`, `payment/domain/CardChargeOutcome.kt`, `payment/data/TerminalPaymentService.kt`, `payment/presentation/PaymentFlowViewModel.kt`, `payment/presentation/PaymentResultScreen.kt`; payment tests `CardChargeDecisionTest`, `TerminalPaymentServiceHttpTest`, `PaymentFlowViewModelTest`.
- iOS `Services/SecureStorage.swift`, `Services/TerminalPaymentService.swift`, `Payment/CardChargeOutcome.swift`, `Payment/PaymentFlowViewModel.swift`, `Payment/PaymentResultViews.swift`; tests `CardChargeDecisionTests`, `PaymentFlowUndeterminedTests`. Existing fixture cleanup in `MesaProvisionalOfflineTests` / `SplitMostradorContinuidadTests` now explicitly clears test identity because production forget no longer clears financial protection. Prior unrelated edits retained.

Follow-up RED queued by root: HTTP200 with unknown body must not become charged (both platforms). Response-status guard deliberately awaits observed failure. iOS transport seam ensures payment tests cannot authorize a real card.

Not complete until module GREEN, Android compilation and iOS build. Root owns heavy queue and physical offline tests. No commits/push/deploy/physical charges performed here.

Android follow-up evidence: `run-avoqado-android.uqmwXJ/out-local.txt`: 100 tests, 2 failures. Valid new RED: HTTP200 unknown body falsely became success. Fixed by requiring explicit success status and matching request identity (absent identity accepted for legacy Android responses); otherwise status recovery. Other failure was old copy assertion, updated to the approved warning text (both platforms). Generic400 compatibility test was not in that snapshot, so no RED claimed yet. iOS next run uses simulator ad-hoc signing to permit real Keychain tests.

Signed iOS follow-up: `run-avoqado-ios.jhiybu/out-local.txt`, 47 tests / 4 assertions. Valid RED: generic400 and HTTP200 unknown payload. Other 2 failures were stale copy expectations already fixed. Real Keychain durable journal, no-second-authorization and original venue tests passed under simulator ad-hoc signing; initial nil fixture failures were unsigned simulator behavior. Implemented iOS400/status guard after this RED. Root requested extra precedence: COMPLETED with paymentId beats stale ACTIVE; COMPLETED without paymentId remains unknown. Regression tests added on both platforms, production awaits their RED. Android400 still awaiting captured RED.

### Offline behavior / boundaries
- No connectivity after POST: pending journal remains; operator sees “Estamos confirmando el cobro. No vuelvas a pasar la tarjeta.” Recovery only reads status, never replays authorization.
- Process death between touch and POST: checked journal write precedes network; next payment entry discovers original identity. Android legacy key remains honored; iOS stores one atomic context journal and honors legacy key.
- Ordering: no second card authorization while pending. Confirmed server Payment releases only matching identity; stale result cannot consume newer pending slot. Resolved journal context is retained for late-result rearming.
- Reconnect: existing explicit recovery can query original venue, max 3 probes per cycle with .5s/2s spacing, existing 35s recovery ceiling. No background authorization replay added.
- Physical disconnected-device validation and cross-device server guard remain root-owned. No physical offline test claimed by this worker.
- Current single-slot policy conservatively protects all new card charges until resolution. It does not add a multi-sale pending registry or processor query API to POS; processor/affiliation/TPV-attempt correlation belongs to server/TPV.

Precedence RED: iOS `run-avoqado-ios.Yr33eu/out-local.txt`, 49 tests / 2 expected precedence failures; all 11 ViewModel tests passed. Android `run-avoqado-android.xyMciK/out-local.txt`, 102 tests / 3 expected failures (2 precedence, generic400). Implemented both: COMPLETED plus nonblank paymentId wins stale ACTIVE; COMPLETED lacking payment evidence stays unknown. Android now reconciles generic400 (legacy lost ACK compatibility) after captured RED. New iOS narrow transport regression awaits capture: HTTP200 failed cannot bypass authoritative CANCELLED/ACTIVE uncertainty.

Final narrow iOS RED: `run-avoqado-ios.oG0BPG/out-local.txt`, 50 tests / 1 expected failure: HTTP200 failed bypassed authoritative financial status. All 38 decision tests green. Removed the shortcut; all non-success200 responses now resolve authoritative status on both platforms. Definitive durable FAILED still permits deliberate retry. Both repos stable for final module GREEN/build and root review.

## Final module GREEN
Root recovered final verification: Android `run-avoqado-android.XecBfA/out-local.txt`: 102 tests, exit 0. iOS signed simulator `run-avoqado-ios.hFxxfN/out-local.txt`: 50 tests, exit 0. Both module runs compile their affected app/test targets. Physical offline validation remains root-owned; no hardware validation claimed here.

## Independent review round 1 — incomplete pending fixes
The prior module GREEN does not cover five accepted review findings (task-3-review.md): retained ownership, stale recovery continuation, success HTTP200 without Payment evidence, cancellation original venue, and ACTIVE actionable copy. Added five behavioral regression cases on each platform; awaiting root-run RED before behavioral changes. Task5 is paused with its three prepared PG tests intact.

Test preparation exception explicitly adjudicated by root: iOS cancel now uses the existing paymentRequest wrapper to allow the same in-memory paymentTransport used by send/status. Existing URL/body/catch behavior is retained, and timeout 60 preserves URLRequest default. This is only a safe test seam, not the venue fix and not RED evidence. Tests never call a real cancellation API.

Round 1 observed RED: Android uFMbh3 107 tests / 5 expected failures. iOS dzqxaM 55 tests / 8 assertions / 0 unexpected failures; all five new methods failed (ownership three assertions; stale recovery two; missing Payment evidence, cancel venue and ACTIVE message one each). No already-green new finding was claimed as RED.

Implemented after RED: new checkout/cancel invalidates recovery generation and drops local ownership; inherited lookup never adopts the pending request. Stale recovery preserves financial identity without applying UI success or offering terminal selection. ACTIVE message survives display. Successful POST requires a nonblank Payment ID (iOS now decodes that additive field). Cancellation freezes original venue together with active request/terminal. Updated Android happy cancellation fixture to include definite Payment evidence. Awaiting root module GREEN; no hardware run or completion claimed.

## Round 2 — awaiting RED
Root-reported round1 GREEN: Android 3OBID1 107 tests; iOS 1zIKve 55 tests. Scoped rereview still requests changes for blocked-send inheritance, concurrent recovery, and old POST clearing new cancellation metadata. Prepared five additional tests per platform: real service guard mapped by VM, duplicate VM callback budget, duplicate service cycle budget, resolved A followed by late UNKNOWN, and resolved A/B send/late A/cancel B. Existing test APIs only, no behavior edits before RED.

Round2 RED inspected: RFkRbQ Android 112 / 5 expected failures; iOS 6fieqf 60 / 9 assertions / 0 unexpected, all five new methods failed. Implemented explicit inherited metadata on guard-blocked outcomes, VM one-current-recovery guard plus service single-flight per request, lifetime-only authoritative winner retention while POST/recovery exists, and identity-checked cancellation metadata cleanup. Late original success from an already recovered request is marked internal-only and cannot rearm or apply success again. No durable tombstones or new background loop. iOS internal alreadyRecovered is excluded from Codable wire keys. Android blocked-guard test now also mirrors the mock service durable key once the actual guard reports it; no assertion weakened. Awaiting root GREEN.

Round3 RED: Android6vCb6O 113/1, iOSoObVDj61/1, both exact fullVM joined-recovery rearming. Narrow fix gives each shared recovery cycle lifetime-only consumer metadata. POST continuations mark shared confirmed success alreadyRecovered whenever the cycle has a UI recovery consumer (including join in either order), while UI recovery receives the ordinary result. Metadata is retained only by the active cycle/awaiters, not stored durably. Existing per-request bounded task and cleanup unchanged. Awaiting GREEN.
