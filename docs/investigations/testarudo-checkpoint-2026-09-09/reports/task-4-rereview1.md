Five actionable gaps remain in the reviewed snapshot.

1. **P1 — An unsigned socket can inherit a replacement socket’s verified identity.** [terminal-registry.ts:66](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/communication/sockets/terminal-registry.ts:66)  
   A venue-changing HTTP heartbeat clears the forward `socketId` but leaves its reverse mapping. Concrete sequence: unsigned socket U, authenticated for venue V, registers terminal A under another venue through the [payload-driven heartbeat registration](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/communication/sockets/controllers/observability.controller.ts:255); A’s HTTP heartbeat restores V with a null socket; signed socket S subsequently registers A. U’s stale reverse mapping now returns S’s verified entry. The cancellation handler accepts U’s `ACCEPTED`, potentially releasing S’s live request. Remove displaced reverse mappings even on null-socket updates, and require the returned entry’s `socketId` to match the emitting socket.

2. **P1 — Recovery bypasses the new physical Payment attribution check.** [terminal-payment.service.ts:1164](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:1164)  
   The wrong-terminal, request-tagged Payment in the new regression test correctly leaves the request UNKNOWN after socket success. The next UNKNOWN sweep nevertheless finds that same Payment and completes the request: recovery checks the request tag, tenant and card status, but omits physical terminal and source validation. Manual reconciliation has the same bypass. Apply the attribution checks when recovery establishes a previously uncommitted association, while preserving the captured Payment.

3. **P1 — Lost captured socket still returns a definitive HTTP error for an uncertain delivery.** [terminal-payment.service.ts:572](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:572)  
   When reconnect replay delivers the request before the original sender discovers its missing socket, persistence now correctly retains uncertainty. However, `BadRequestError` produces HTTP 400 without the canonical `status:'timeout'`/`requestId` response. This violates the specified compatibility path for released clients and can invite another authorization while the first executes. Resolve through the same uncertainty response used for lost ACK.

4. **P2 — Recovery can prevent the mismatch envelope from ever being constructed.** [terminal-payment.service.ts:1241](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:1241)  
   If recovery finds an exact-tagged Payment with different monetary values before socket completion, it writes COMPLETED without `CONTRACT_MISMATCH`, requested/reported values or `reconciliationRequired`. A subsequent socket success calls `closeRowFromPaymentTx`, whose [COMPLETED early return](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:896) skips derivation permanently. Stale/manual recovery share this path. Construct the canonical monetary envelope during reconciliation, with `logAction` remaining outside the financial transaction.

5. **P2 — The picker still advertises a physically reserved terminal as available after a venue move.** [terminal-payment.service.ts:335](/Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/terminal-payment.service.ts:335)  
   A historical unresolved request in venue A correctly blocks admission after its terminal moves to B, but the picker’s aggregation filters reservations by B and returns `busy:false`. Aggregate physical reservations across venues for the already venue-scoped live candidates; return only the busy flag, preserving foreign financial privacy.

| Original finding | Verdict |
|---|---|
| 1. Signed terminal identity | **NOT ADDRESSED** — replacement mapping bypass |
| 2. One Payment closing two requests | **ADDRESSED** |
| 3. Payment terminal attribution | **NOT ADDRESSED** — recovery bypass |
| 4. Immutable replay contract | **ADDRESSED** |
| 5. Historical physical reservation | **NOT ADDRESSED** — admission fixed; availability incomplete |
| 6. Missing-socket delivery race | **NOT ADDRESSED** — reservation fixed; HTTP uncertainty incomplete |
| 7. Monetary mismatch envelope | **NOT ADDRESSED** — recovery-first completion gap |
| 8. Oldest-200 starvation | **ADDRESSED** |
| 9. Automatic-release watchdog copy | **ADDRESSED** |

**Spec verdict:** Task4 remains partially compliant. Normalized replay validation, bounded cursor rotation, complete sequential 100-candidate batching, and conservative reservation retention are present. No invented native-idle evidence or elapsed-time release is required.

**Quality verdict:** Changes requested. I accept the supplied b78ERW **126/126, four suites GREEN** and ZkUvsw behavioral RED evidence as reported; I did not rerun them. The triggers above come from static inspection. Typecheck, hardware and migration application remain pending; transaction-exception coverage does not demonstrate process termination/restart. No edits, tests, builds, DB/device access or agents were used.

The fixes close several important paths, but recovery and socket replacement still bypass protections.  
Task4 needs another focused correction round; this is not full-system or hardware approval. No clarification is needed from you.