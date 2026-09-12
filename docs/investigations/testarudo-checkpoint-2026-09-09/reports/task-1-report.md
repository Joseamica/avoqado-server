# Task 1 — TPV financial correctness (in progress)

No commits, pushes, deployment, hardware charges or independent Gradle jobs. Verification is coordinated by root through avq-verify. Existing shared WIP is preserved.

## RED evidence

- Prior run `~/.claude/avq-verify/run-avoqado-tpv.rNIFYD/out-local.txt`: ledger OFF durability/disk/CAS failure, unsafe empty/other-attempt/DECLINED-with-auth/wrong-terminal history, PAX SDK exception retry. Original 64 tests, 14 failures included Task2 Room setup failures.
- Recovery compiling stub: `~/.claude/avq-verify/run-avoqado-tpv.kR4Kpp/out-local.txt`: `LedgerApprovalRecoveryTest` restart-registration and failed-registration tests failed as expected (36 total,6 failed including Task2). Stub subsequently replaced with recovery implementation.
- `WNWs64` was test-compilation failure from missing PaymentContext/BigDecimal imports, not behavioral RED. Imports fixed.
- Full typed producer snapshots, mandatory affiliation check and Room pending-count/order guard await current coordinated RED run.

## Implementation underway

- Mandatory ledger durability independent of shadow mode; failed pre-SDK insertion/CAS refuses authorization.
- PAX unknown outcome guard for SDK failures/exceptions, retry/reset/cancel suppression, original identity retained, no false failed socket emission. Explicit issuer rejection can retry with a new attempt key.
- Saved approval recovery uses original typed context, direct FastPaymentRecorder/OrderPaymentRecorder (one network request per run), persisted bounded lease/backoff, same idempotency key, no SDK authorization dependency. Startup/reconnect uses existing LedgerSweepScheduler through Task2 AppNavigation wiring. Recovery runs even with shadow mode OFF. Queue-owned rows are excluded.
- AngelPay history absence never proves no charge; approval requires exact identity and actual operation status.

## Known boundaries

- Older SHADOW rows persisted only RetryContext/partial hand-built JSON. Recovery must not invent staff, venue, merchant, split or order from the current session: these remain reconciliation evidence.
- Blumon TPV has TransactionDetails(operationID), but an operationID obtained only after a lost response is not a pre-loss correlation key. Existing history adapter is unimplemented. No automatic GenericFailure resolution is promised. Per-cut amount/time/masked-card matches must not be attributed automatically.
- App-to-app manual v1.2 (local Socios/AngelPay PDF, pp18–19) separates transaction and call results; absence of a transaction object does not establish financial finality. SDK history slices expose no completeness/finality guarantee.
- Physical execution completion is separate from financial UNKNOWN. No slot-release event is emitted merely from watchdog/time/heartbeat, nor without verified SDK cleanup and durable evidence.

Final GREEN evidence and exact changed files will be appended after root verification.


## Resumed after tool-hook outage

`TOizsF/out-local.txt`: 157 tests /10 failures. Four valid money RED cases: exact startup UNKNOWN positive lookup, exact history filter, unrecognized catalogue code, app-to-app G505. Six other failures belonged to Task2. Subsequent tool-hook outage (`claude-mem worker unreachable`) interrupted work, not a code failure. User requested retry; tools recovered.

All four GREEN implementations are now present:
- `LedgerUnknownRecovery` performs one bounded query per durable lease using original attempt/terminal/affiliation/date, never authorizes or treats absence as decline. Worker executes UNKNOWN lookup before approval replay. Host response resets lookup leases so a fifth successful lookup cannot prevent registration.
- Adapter passes `integratorReference` supported by current vendored AngelPay SDK1.0.18 (verified `javap`, local manual p39).
- Codes outside the explicitly inspected vendor catalogue remain unknown.
- App-to-app G505 uses the same unknown-query path and cannot mark DESCARTADA or emit failed.

Code is ready for coordinated GREEN verification. No claim of release readiness: hardware and physical execution-finished proof remain separate.

### Resumed audit 2026-09-09 13:15 — physical execution and remaining negative results

Financial GREEN implementation for TOizsF's four valid RED cases is stable; parent is running the combined suite. Added explicit `GenericFailure` chip regression (no second SDK call after retry, INDETERMINADO, no hostfalse). New RED batch pending: missing/malformed app-to-app callback, status-only DECLINED/CANCELLED, unknown gateway code, and known errors without no-charge proof. No production changes for this new batch before parent observes RED.

**Physical release cannot yet be certified by the current integration.** Read-only `javap -p -c` of vendored `blumon_sdk-1.6.1.2-sandbox.aar` shows `TransProcessRepositoryImpl.resetFlowsProcessTrans` only calls private `resetFlows`, which resets Kotlin state flows (PIN/dialog/application state); it is not native kernel/PED cleanup. `completeEmvTrans` invokes `EmvProcess.completeTransProcess(IssuerRspData)` and returns a TransResult. This is the normal issuer-response completion API, not a documented safe abort for missing issuer response. Chip GenericFailure exits before normal completeEmvTrans; stopDetectCard stops polling but does not attest completion of chip/PED state. Do not synthesize issuer decline or reversal just to terminate EMV. `SaleIccUseCase.run` return proves service call returned, not hardware readiness.

Read-only bytecode of vendored `angelpaySDK-v1.0.18-fat-release.aar`: `PaymentActivity.finishWith` serializes result, calls `Activity.setResult`, then `Activity.finish`. `onDestroy` cancels its CoroutineScope and invokes `n.a.Y` hardware wrapper `c.a.a` -> `u.c0.h()`. That helper calls `CardReader.stopSearch` and `CardReader.close` on active/all slots, catches/logs individual failures and returns void. The public AngelPaySDK surface has no checked cleanup-completed/idle callback; its cancelTransaction is a financial post-operation, not execution abort. `AngelPayPaymentScreen.kt:157,169` receives ActivityResult then calls the VM, but does not receive success/failure of cleanup. Therefore ActivityResult alone is insufficient to emit durable physical execution-finished under the proposed proof contract. No release event implemented. Bytecode extracts in `/tmp/tpv-pax-trans-bytecode.txt`, `/tmp/tpv-angel-activity-bytecode.txt`, `/tmp/tpv-nexgo-cleanup-bytecode.txt` are reproducible from those vendored AARs.

**Negative emitter audit:** PAX Error socket collector suppresses unknown (`PaymentViewModel.kt:1464`), preflight/reset cancellation is guarded; exact GenericFailure coverage added. AngelPay preflight failures (invalid money, venue/staff, shift, merchant) occur before SDK. However `AngelPayResultParser.kt:83` currently maps absent OR malformed tx/call to Cancelled; VM1891 marks hostfalse/emits cancelled. Existing classifier's fallback also incorrectly treats every known catalogue code except five, arbitrary gateway codes, and status-only DECLINED/CANCELLED as final. Specifically vendor `G501` means repeated by idempotency, `I901` serialization, `I902` financial SDK error, printing errors and interrupted-back do not prove no charge. Tests are being tightened; no protocol monetary-version handshake can truthfully assert all negative results are proof-bearing yet. Actual vendor explicit `G500` rejected by gateway / `G504` risk rejection / `E606` online host rejection are candidate negative proof. Known preflight checks and pre-launch cancellation are safe because SDK was not entered. Catalogue retry hints or UI status alone are insufficient.

### Latest negative-result RED / GREEN

`JeE7p9/out-local.txt`: 374 tests, 11 failures. Six classifier and two parser assertions plus empty-callback VM assertion are valid RED. PAX partial-response test threw at its own unsafe state cast; replaced with an explicit assertion before the cast and deferred production PAX partial guard until a valid RED. G505 fixture had a relaxed ShiftRepository cast error at VM926; fixed fixture to disable shifts explicitly.

AngelPay GREEN now uses explicit negative proof allowlist and UNKNOWN default, empty/malformed parser payload returns UNKNOWN, and VM permits empty-callback cancellation only when no durable prelaunch attempt exists. Existing timer tests now use actual contactless-limit E608 preauthorization advisory instead of E618 remove-card guidance. PAX partial fix remains pending valid RED. GenericFailure named regression did not fail in JeE7p9.

`1Oh3NV/out-local.txt`: 374 tests, 4 failures. Classifier and parser all GREEN. PAX partial now valid assertion RED (expected unknown Error but legacy retry reached Processing); partial-response guard subsequently implemented in sandbox + production, accepting only explicit issuer rejection (including ASCII-hex EMV8A) when authorization absent. Remaining two AngelPay new fixtures used a relaxed verifier that synthesized Cobrado and entered RecordingPayment; explicitly return NoSePudoVerificar now. Old launched-empty cancellation test expected charging release, corrected to retained gate as required by UNKNOWN.

### Outcome capability audit — not yet safe to advertise whole-APK version1

Beyond the fixed parser/classifier/partial-response paths, central negative emitters are not uniformly proof-bearing. PAX cancelPayment checks unknown before launching a coroutine but suspends in stopDetectCard before publishing Cancelled; a concurrent authorization can invalidate that earlier check. PAX approval delivered to offline queue clears authorizationUnresolved; resetPayment then clears authorizationApproved and can emit cancelled while the original socket request still exists. AngelPay abandonment helper regards every Error as pre-money; crypto timeout/partial crypto failure can also enter Error. The NoCobrado verifier branch remains a legacy unsupported negative contract (current real history verifier never returns it). Therefore do not advertise terminalPaymentOutcomeVersion=1 globally based only on the current fixes. Per-result proof or explicit per-attempt final-negative guard and dedicated tests are needed first. Startup UNKNOWN recovery and same-key approval replay are independent and remain implemented.

### Proof-bearing negatives, later verification evidence

- `MFt5Ws`: 377/5. Four valid residual RED cases (PAX cancellation scheduling race, approved queue reset, legacy NoCobrado, generic Error abandonment); one relaxed verifier fixture cast fixed. Implemented rechecks around suspendable cancellation, approval reset suppression, NoCobrado remains unknown, and launch-vs-final-negative tracking.
- `a9gXhS`: 378/4. Valid RED for durable outcomeEvidence serialization, AngelPay issuer/preflight producer proof, and retry/reset escape through generic postlaunch Error. All earlier residual tests passed. Implemented optional per-result proof serialization, explicit AngelPay failed producers, and guards retaining generic unknown Error through retry/reset.
- `HpoPhb`: 15/2. Valid RED for actual navigation-helper-to-SocketManager-to-Inbox PRE_AUTHORIZATION serialization and explicit PAX EMV8A issuer rejection proof. Implemented both after evidence. No blanket APK capability; absent proof remains absent.

Minimal wire addition: `outcomeEvidence?: "PRE_AUTHORIZATION" | "PROCESSOR_DECLINED"` in durable terminal result JSON. SocketManager preserves only these recognized values; it never manufactures one from status. AppNavigation's three owned pre-screen gates share `rejectRemotePaymentBeforeAuthorization`. PAX Error collector attaches a proof only from explicit issuer outcome/configuration refusal; generic Error remains unproven. AngelPay verified failed producers distinguish request validation from issuer refusal. The actual Room inbox persists the JSON winner before socket emission, retaining optional evidence through redelivery.

Remaining latest RED batch (awaiting root): prelaunch cancellation proof. `markDiscardedBeforeCharge` now has Boolean API with conservative false compiling stub until observed RED. Ledger assertion requires true only on CAS1, false on CAS0/disk failure; VM assertions require proof on committed preparing cancellation or a genuine never-started operation, never after uncommitted discard. AngelPay prelaunch cancellation proof assertions are also queued. Do not leave stub in final implementation.

### Final proof implementation awaiting coordinated GREEN/review

`Jwr1sD` was compile-only (two duplicate optional-argument test calls), not RED. Corrected before next snapshot. `Bi1vvM/out-local.txt`: 408 tests /8 assertion failures, all valid RED: Room cancellation/rejection proof2, ledger committed CAS proof1, PAX prelaunch cancellation proof2, text-only contactless failure1, AngelPay cancellation/abandonment proof2.

Implemented after Bi1vvM:
- `markDiscardedBeforeCharge` returns true only for CAS1, false for CAS0/write error; cancellation propagates. Conservative API stub removed.
- Room RECEIVED-only cancel/reject JSON includes PRE_AUTHORIZATION; failed CAS returns no invented JSON and existing-result replay is unchanged.
- PAX cancellation proof requires committed preparing discard, or no attempt and no financial operation begun. Failed proof preserves identity/unknown through reset. Approval handed to queue cannot be cancelled. A financial-operation latch and proof clear at card/cash/crypto entry prevent stale proof from crossing methods.
- Contactless human guidance alone cannot prove issuer refusal. GenericFailure stays unknown; explicit issuer code is required for finality.
- AngelPay cancellation/abandonment carries the saved explicit proof or genuine prelaunch proof; card/cash/crypto entry clears old proof. SDK result begins with no negative proof until its classifier establishes one. NoCobrado without processor evidence stays unknown.

Exact flavor commands verified from current `app/build.gradle.kts` (environment dimension):
- PAX sandbox APK: `./scripts/avq-verify.sh avoqado-tpv ./gradlew :app:assembleSandboxDebug --max-workers=1`
- Nexgo QA APK: `./scripts/avq-verify.sh avoqado-tpv ./gradlew :app:assembleNexgoDebug --max-workers=1` (flavor `nexgo`, no `nexgoSandbox`). Both QA flavors use `.sandbox` appId on their respective hardware.
- Production PAX mirror compilation: `./scripts/avq-verify.sh avoqado-tpv ./gradlew :app:compileProductionDebugKotlin --max-workers=1`
- Production PAX money tests: `./scripts/avq-verify.sh avoqado-tpv ./gradlew :app:testProductionDebugUnitTest --tests '*PaymentViewModel*Test' --tests '*BlumonSaleReferenceTest' --max-workers=1`

These commands remain root-owned; no independent builds, installs or hardware charges were performed here. Final full GREEN and independent-review findings still to be appended. Physical execution-finished proof is still unavailable from inspected public SDK contracts, so no automatic UNKNOWN slot-release event is implemented or claimed.

### Read-only Nexgo physical QA configuration check (2026-09-09)

No builds, device writes, installation, or charges performed. Source configuration proves an intended QA SDK initialization, but does not certify the installed APK or a particular test affiliation.

- `avoqado-tpv/app/build.gradle.kts:176` defines flavor `nexgo`: `BLUMON_ENV=SAND`, `ANGELPAY_ENV=QA`, `SUPPORTED_PROCESSOR=ANGELPAY`, SDK enabled, app-to-app fallback disabled. The correct task is `:app:assembleNexgoDebug`; PAX is `:app:assembleSandboxDebug`. `nexgoProd` is a separate production flavor.
- Common URL declarations at `app/build.gradle.kts:32` default DEV REST and socket to `https://patchiest-noncommemorational-willia.ngrok-free.dev` (REST adds `/api/v1/`). `-Pavoqado.devBaseUrl` changes only REST. Existing generated `app/build/generated/source/buildConfig/nexgo/debug/com/jaac/avoqado_tpv/BuildConfig.java:30` instead has REST `http://localhost:8799/api/v1/`, while socket remains the ngrok host at line 52. This is an actual generated-config routing mismatch for the proposed local lab, not evidence of installed APK routing. Fresh build/package configuration and intended device-to-Mac mapping remain to be checked by root.
- `NetworkModule.kt:54` and `HomeViewModel.kt:641` select DEV endpoints using `BLUMON_ENV`, not debuggable/package suffix. `AvoqadoTPVApplication.kt:174` and `AngelPayPaymentViewModel.kt:1451` translate SAND into the SDK `QA` environment. `AngelPaySdkGateway.kt:39` calls SDK initialize only if not initialized; it does not attest the environment of an existing initialized SDK session.
- No sandbox affiliation is compiled: legacy `ANGELPAY_QA_*` fields are empty. Backend terminal config `angelpayAuth` / `angelpayAccounts` provides account credentials; `AngelPayCredentialResolver.resolveByAccountId` selects the account. `AngelPayAuthRepository.kt:243` passes email/PIN to `authenticateSimple`; credential `environment` is logged metadata, not an environment comparison or initialization argument. No secret values were inspected or included here.
- The payment ViewModel authenticates the selected merchant account (`angelpayUserAccountId`, line 1497), uses SDK merchant selection, checks selected merchant ID against active SDK merchant ID (line 2477), and captures actual session affiliation (line 719). That check does not certify QA affiliation; legacy missing merchant/external ID cases return true. The expected QA account and live SDK merchant/session affiliation must therefore be independently verified before physical QA. Backend config environment alone is insufficient.
- Runtime settings cannot enable fallback when its BuildConfig flag is false (`isAppToAppFallbackEnabled`, line 748, logical AND). SDK flow also requires its runtime setting. No provider network host has been independently established from SDK internals in this check; only the explicit `QA` initialization argument is verified.

Final verification commands remain root-owned via `./scripts/avq-verify.sh avoqado-tpv ./gradlew ... --max-workers=1`: `:app:assembleSandboxDebug`, `:app:assembleNexgoDebug`, and production PAX mirror `:app:compileProductionDebugKotlin` plus `:app:testProductionDebugUnitTest` with the agreed financial filters. Last known full financial/remote suite: 74KSsL, 408 tests / 1 old pre-host kernel fixture failure; fixture-only Boolean CAS stub correction is pending the next GREEN run.

### Independent financial review follow-up — initial RED batch (historical)

All nine findings in task-1-review.md were accepted for regression coverage; none rejected. At initial test preparation production was unchanged. The subsequent RED and applied corrections are recorded below. Tests added cover:

1. AngelPay duplicate barrier false-CAS rejection in the existing VM unit test, plus two staggered actual SDK-entry calls with a real Room ledger in AngelPayPaymentReviewRoomTest. The second must never reach SDK intent validation.
2. Real Room authorization row, cancellation of the old VM scope, cloned SavedStateHandle/request, new ledger facade and new AngelPay VM receiving an empty callback: no PRE_AUTHORIZATION cancellation.
3. Contradictory tx=05/call=G505 or TIMEOUT parser cases, plus real parser→VM/socket proof regression.
4. Actual PAX RESULT_OFFLINE_APPROVED kernel response through startPayment/detect/contactless; authentication disappears as kernel returns. Approval must already be durable even when live registration exits early; reset cannot emit cancelled. This test does not set authorizationApproved by reflection.
5. Real Room authorization→unknown, new ledger instance, orderless attempt through openAttempt/markAuthorizing: durable terminal hold must refuse admission.
6. AngelPay real orchestration entry with absent pre-auth session and newly authenticated effective affiliation: captured JSON must retain the session that will charge.
7. PAX startPayment snapshot with kiosk attribution distinct from logged-in operator: saved staff must be the effective original seller.
8. PAX missing posId with failed durable discard: no PRE_AUTHORIZATION socket proof; no SDK sale.
9. LedgerRecoveryLeaseRoomTest covers both approval and unknown workers with sweep time captured over five minutes before acquisition and a reconnect worker; exactly one external registration/query. A separate real Room lease handoff asserts an expired owner's failure cannot overwrite its successor's state. No real multi-minute sleeps are used.

New focused classes: AngelPayPaymentReviewRoomTest (Robolectric API28, 4 tests), LedgerRecoveryLeaseRoomTest (Robolectric API28, 3 tests). Existing classes extended: AngelPayPaymentViewModelTest, AngelPayResultParserTest, PaymentAttemptRoomTest, PaymentViewModelTest, PaymentViewModelWatchdogTest. The parser-only regression currently requires safe UNKNOWN projection through the existing result API; the integration test independently checks the financially meaningful outcome if a richer result API is introduced.

Fixtures: real Room AvoqadoDatabase in-memory, no Android device/database writes; SDK/network boundaries mocked, explicit Result.success(Unit) for SDK initialization/auth/validation, real callback Intent parsing, controlled CompletableDeferred recorder/verifier completion for lease races. PAX existing test file preserves CRLF and uses its established IO wait pattern. At this initial preparation stage there were no production fixes, build configuration changes, builds, ADB or charges. Root subsequently executed the RED described below and owns all further compilation and execution.

### Current status — review corrections applied, full GREEN pending

Root-run `vBUz5M` completed **421 tests / 12 behavioral failures**. All original 408 controls were GREEN. Evidence: `/Users/amieva/.claude/avq-verify/run-avoqado-tpv.vBUz5M/out-local.txt`; the XML files were copied from the reusable snapshot into `/Users/amieva/.claude/avq-verify/run-avoqado-tpv.vBUz5M/xml/` before the next TPV run. This is valid RED for the 12 failing regressions, not for the recreation test that passed.

Applied after that RED, now frozen awaiting root verification:

- **AngelPay failed CAS:** removed `marked || alreadyOpened`; an already-open row no longer authorizes continuation when `markAuthorizing` loses. SDK orchestration authenticates and aligns the effective merchant session before freezing the context/affiliation and crossing the durable launch barrier.
- **Contradictory parsed results:** when an unapproved transaction coexists with an uncertain SDK/status result, parser conservatively projects `UNKNOWN` instead of publishing the issuer code alone. Explicit approval retains priority. No global negative-result capability is advertised.
- **PAX offline approval:** both sandbox and production mark financial operation started/approved, clear negative evidence, and await the ledger approval mark at the actual `RESULT_OFFLINE_APPROVED` branch before publishing Success or entering authentication-dependent registration. Reset retains the known approval obligation.
- **PAX original attribution:** the pre-SDK JSON uses `resolveAttributionStaffId()` so kiosk/POS seller attribution matches live registration rather than the logged-in operator.
- **PAX missing posId:** configuration is checked before the authorizing CAS; `PRE_AUTHORIZATION` requires successful Boolean `markDiscardedBeforeCharge`. Failed discard retains uncertainty and carries no proof. Mirrored in both flavors.
- **Terminal durable hold:** `openAttempt` checks for any locally unresolved authorization/approval across order and venue; authorizing CAS additionally has an atomic SQL `NOT EXISTS` condition against another unresolved attempt. Clearing ViewModel flags cannot remove this Room hold.
- **Recovery leases:** each candidate computes fresh acquisition time (`maxOf(sweepTime, System.currentTimeMillis())`) and its own expiry. Calls are bounded to 240 seconds beneath the minimum 300-second lease. Completion updates require matching attempt, venue, expected state, owned `lease_until`, and an unexpired lease. Unknown approval completion is one conditional DAO update, including approval identity and retry reset. Success counts only after CAS1. Existing recovery unit assertions now observe this owned-completion boundary.

**Schema:** these corrections add DAO queries only. No entity columns, database version, migrations or schema JSON changes were introduced for this review batch. Existing `lease_until` serves as the ownership token; this assumes monotonically distinguishable acquisition expiries and does not introduce a separate UUID owner column. The clock is wall time, not monotonic; the implementation prevents the reproduced stale sweep-time lease but cannot claim protection from arbitrary clock jumps or a non-cooperative external call that ignores coroutine cancellation. A stale completion cannot overwrite a successor whose lease differs.

**PREPARANDO semantics / remaining boundary:** the new terminal hold includes AUTORIZANDO, INDETERMINADO, HOST_RESPONDIO, AUTORIZADO and REGISTRO_FALLIDO; it deliberately does **not** include PREPARANDO, REGISTRADO or ENTREGADA_A_COLA. `openAttempt` checks then inserts in separate calls; the subsequent authorizing CAS atomically excludes another unresolved attempt. Therefore this is not an atomic reservation of all native pre-authorization/kernel execution: concurrent PREPARANDO rows are still possible, and PAX can reach its offline kernel path while PREPARANDO. `markHostResponded` still returns Unit and absorbs persistence failure; the offline correction places that write earlier and preserves the in-memory approval, but does not prove durable approval after a failed write. These limits remain for root review; no native execution-finished/cleanup proof is claimed.

**Recreation finding remains RED-only pending.** The original new test passed and is not treated as RED. Its fixture tagged the socket before initPayment, allowing an initialization/preflight emission to consume the one-result flag and mask a later erroneous cancellation. Tightened test tags after initialization, asserts the unconsumed/restored request, and requires ResultadoIncierto after the empty callback as well as no PRE proof. The recreated empty-callback production branch is intentionally unchanged until root observes this tighter test fail behaviorally.

`git diff --check` passed for the changed financial production paths. No compile/test/build was run by this agent. Root is preparing the full 421-test run including the tightened recreation case. Current status is **implementation awaiting verification**, not GREEN or complete. No build-config edits, ADB, hardware charges, commits, pushes or deployments.

### Required closure of offline write failure and PREPARANDO reservation — tests/design only

Root confirmed these are required parts of review findings 4/5, not deferrable caveats. While the previous 421-case run is in flight, three regressions were added without changing production:

- `PaymentViewModelKernelDurabilityTest.offline approval write failure keeps durable obligation and cannot publish success or cancellation`: real Room ledger with only the host-outcome DAO write forced to throw. The real ledger absorbs that exception, exactly reproducing its current failure behavior. An actual offline-approved contactless kernel response then loses session authentication before registration. The test requires no Success state/socket success, a durable hold, no reset cancellation, and rejection of a new attempt through a recreated ledger.
- `PaymentViewModelKernelDurabilityTest.recreated VM cannot enter offline capable kernel while previous instance is preparing`: first real ledger commits an orderless PREPARANDO row; a fresh ledger facade and PAX VM attempt a contactless sale. The SDK kernel boundary must never be called while the original reservation remains.
- `PaymentAttemptRoomTest.two ledger instances cannot reserve preparing kernel work concurrently across venues`: two independent ledger instances begin together on IO against one Room DB, with different venues and no orders. Exactly one reservation may succeed. A successful explicit pre-SDK discard of the winner must admit a later attempt, preserving the safe continuation rather than permanently blocking the terminal.

New test class uses the existing PAX fixture dependencies with Robolectric API28/real in-memory Room. The fault is at DAO approval persistence; it is not a fabricated exception thrown by the ViewModel's ledger mock. No builds, schema changes, production edits or device actions in this batch. Filters sent to root: `*PaymentViewModelKernelDurabilityTest`, `*PaymentAttemptRoomTest`. Await behavioral RED before implementation.

Minimum design to implement after RED:

1. Reserve the terminal in one Room transaction: bounded lookup including PREPARANDO and unresolved execution states plus insertion. A check followed by a separate insert is insufficient. Keep receipt/queue ownership states outside a pre-SDK reservation; do not clear unresolved native execution by time or Kotlin object recreation.
2. Persist a distinct native-kernel-entry phase before the offline-capable PAX call. PREPARANDO must continue to mean that no native authorization-capable call began, so its successful discard CAS remains valid PRE_AUTHORIZATION proof. A durable kernel-entered state cannot be discarded by the old PREPARANDO cancel helper. This may be a new state string using the existing schema, with all unresolved queries/recovery handling audited; no need to conflate native entry with bank-request entry.
3. Continue from kernel to online authorization through an explicit allowed transition owned by that attempt; do not restore the failed-CAS `alreadyOpened` exception or treat a recreated VM as the original execution owner. An explicit kernel refusal may release only under the documented no-authorization contract and successful durable transition. Unknown kernel completion stays held.
4. Propagate durable approval persistence success/failure instead of ignoring Unit. Set the in-memory approved obligation immediately, but publish final success only after a durable approval/queue/backend record exists. If the outcome write fails, the prior durable kernel-entry phase remains a hold through recreation and the UI must show charged/pending recovery rather than success/cancel/retry. Preserve the original context/key for saving the approval when persistence is available; never create a second authorization to repair registration.
5. Native cleanup proof remains a separate unsatisfied SDK contract; neither confirmed financial unknown nor navigation back, callback return, timeout or process restart is new proof of native idleness. These fixes must not introduce automatic execution-finished emission.
