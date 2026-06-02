# TPV Venue Migration — Design Spec

**Date:** 2026-06-02
**Status:** Approved design (pre-implementation)
**Repos touched:** `avoqado-server` (anchor) + `avoqado-web-dashboard`. Phase 2 also `avoqado-tpv`.
**Owner:** Jose Amieva

---

## 1. Problem

Operators frequently request moving a single physical TPV (PAX terminal) from one
venue to another. Today this is dangerous and manual:

- The device caches `venueId`, Blumon/AngelPay merchant credentials, menu, staff PINs,
  receipts and unsynced sales in `EncryptedSharedPreferences` + a Room DB.
- The only existing "move" (`updateTerminal` venueId, called by the superadmin PATCH
  and the admin-MCP `move_terminal` tool) does **one** of the required steps: it
  re-parents the terminal and clears `assignedMerchantIds`. It does not verify the
  destination is usable, does not guard unsynced money, and does not wipe the device.
- Done wrong, money routes to the **old** venue's merchant account, or the device
  arrives at the new venue unusable (can't charge / nobody can log in).

We want a **superadmin dashboard wizard** that performs the migration safely, with
gated steps, requiring **zero action from the destination operator**.

## 2. Key findings that constrain the design

These came out of a cross-repo audit (2026-06-02). They are load-bearing:

1. **Order is forced: re-parent FIRST, then factory reset.**
   FACTORY_RESET does **not** clear the server-side venue binding — it only wipes the
   device's local copy. On reboot the wiped device asks
   `GET /tpv/terminals/:serial/activation-status` and **re-binds to whatever the server
   currently says**, with no activation code
   (`terminal-activation.service.ts:119-144,215-281`).
   - Reset → re-parent  = device re-binds to **old** venue. Wipe wasted. ❌
   - Re-parent → reset  = device re-binds to **new** venue, **by itself**. ✅
   This auto-restore is what gives us "zero friction for the operator."

2. **FACTORY_RESET cannot ACK completion.** `executeFactoryReset()` wipes storage then
   `killProcess()` *inside* execution, before the ACK is sent
   (`CommandExecutor.kt:950-993`; ACK only fires after `execute()` returns,
   `ConnectionViewModel.kt:865-909`). The command stays `SENT` and `EXPIRES` after 30 min.
   **A wizard gate that waits for `COMPLETED` would hang forever.**

3. **The real proof-of-wipe** is the reboot signature: device goes offline (stops
   heartbeating because local `venueId` is gone — heartbeat is gated on
   `isDeviceActivated()`, `ConnectionViewModel.kt:427-431`), then re-hits
   `activation-status` with its **hardware serial that survives the wipe**
   (`DeviceInfoManager.kt:78-118,238-287`). An already-bound, non-wiped device never
   calls `activation-status`, so that call is the unambiguous "I woke up blank" tell.

4. **Reset delivery after re-parent is via heartbeat, not socket.** The command `emit`
   targets `server.to(venue_<NEW>)` (`command-execution.service.ts:257-264`) but the
   running device is still in the `venue_<OLD>` socket room until it re-binds, so the
   socket push misses. The HTTP heartbeat path resolves the terminal by **serial** and
   delivers queued commands regardless of room (`tpv-health.service.ts:535-544`), so the
   reset still arrives — on the next heartbeat cycle, not instantly.

5. **Destination readiness is not guaranteed.** PIN login is venue-scoped
   (`StaffVenue @@unique([venueId, pin])`, checked in `auth.tpv.service.ts:39-47,112`)
   and card routing falls back to the destination's `VenuePaymentConfig` once
   `assignedMerchantIds` is cleared. If the destination has no payment config or no staff
   PINs, the device arrives dead. Nothing checks this today.

6. **Historical data is safe.** Every `Order`/`Payment` carries its own required
   `venueId`; only the `terminalId` attribution pointer crosses venues. Moving a terminal
   does not retroactively move old sales.

## 3. Goals / Non-goals

**Goals (Phase 1 — server + dashboard only, no APK deploy):**
- A superadmin "Migrar a otro venue" wizard on the Terminals page.
- Pre-flight that **hard-blocks** if the destination can't run the terminal.
- Correct order **enforced server-side** (impossible for the operator to invert).
- A real proof-of-wipe gate: "Finish" enables only after the device reboots and
  re-binds under the new venue.
- Destination operator does nothing.

**Non-goals (Phase 1) → deferred to Phase 2 (needs `avoqado-tpv` deploy):**
- Hard gate on unsynced device data (`pending_payments`, `verification_queue`). Phase 1
  treats this as a **manual checklist + "Force sync" button**, not a hard block.
- Pre-wipe ACK ("about to wipe") from the device.
- Fixing the two known wipe defects: FACTORY_RESET clears a dead `avoqado_prefs` and
  misses `avoqado_checkout_saved_carts`; and it does not flush the two unsynced queues.

## 4. Architecture

Three new superadmin endpoints + one new field. **No new model** — T0 (when the reset
was queued) is read from the existing `TpvCommandQueue` record; the proof-of-wipe is
derived from the new field + venue + online status.

| Piece | Responsibility |
|---|---|
| `POST /dashboard/superadmin/terminals/:id/migrate-preflight` | Run destination checks. Returns `{ canProceed, blockers[], warnings[] }`. **Mutates nothing.** Body: `{ targetVenueId }`. |
| `POST /dashboard/superadmin/terminals/:id/migrate-execute` | In **one transaction**: re-validate blockers → `updateTerminal({ venueId })` (clears `assignedMerchantIds`) → queue `FACTORY_RESET` (CRITICAL). Returns `{ commandId, startedAt, fromVenueId, toVenueId }`. **Order lives here, not in the frontend.** |
| `GET /dashboard/superadmin/terminals/:id/migrate-status?commandId=&since=` | The wizard's poll. Returns the proof-of-wipe state (see §6). |
| New column `Terminal.lastActivationStatusCheckAt DateTime?` | Stamped whenever the device hits `activation-status`. The inequivocal "woke up blank" signal. |

**Service:** new `terminal-migration.service.ts` orchestrating the three operations,
reusing `updateTerminal()` (`terminals.superadmin.service.ts:321-548`) and the command
queue (`command-queue.service.ts`). Keep it under 500 lines; it's an orchestrator, the
real work stays in the services it calls.

## 5. Pre-flight checks (hard blockers vs warnings)

**Hard blockers (cannot proceed):**
- Destination venue has an active `VenuePaymentConfig` (merchant account). Else: device
  cannot take card payments.
- Destination venue has ≥1 `StaffVenue` with a PIN. Else: nobody can log in.
- Terminal `brand` compatible with the destination's merchant config (mirror the existing
  brand/merchant compatibility check in `updateTerminal`).
- Terminal is not `RETIRED`.
- No migration already in progress for this terminal (idempotency).

**Warnings (Phase 1 — confirm + proceed):**
- Open shift / open orders associated with the terminal's current operators → advise
  closing first. (Shifts are venue-scoped, no `terminalId`; this is a soft check.)
- Unsynced device data cannot be verified server-side in Phase 1 → checklist item
  "Confirma que la TPV está sincronizada" + a **"Forzar sincronización"** button that
  sends `SYNC_DATA` and waits a beat before continuing. Becomes a hard gate in Phase 2.

## 6. Happy-path flow

```
1. PREFLIGHT — superadmin picks terminal + destination venue
   → hard blockers all green, warnings acknowledged

2. EXECUTE (single server transaction)
   a. re-validate hard blockers (state may have changed)
   b. updateTerminal({ venueId: target })  → clears assignedMerchantIds
   c. queue FACTORY_RESET (priority CRITICAL)  → returns commandId, startedAt = T0
   Wizard shows "Comando en cola, esperando que la TPV lo reciba."
   (Delivery is via the device's next heartbeat — by serial, not socket room — §2.4.)

3. DEVICE (autonomous)
   → still has OLD venueId locally, so it is still heartbeating
   → pulls FACTORY_RESET in its heartbeat response → executes → wipes → killProcess → reboot
   → no local venueId: STOPS heartbeating, lands on activation screen
   → calls GET activation-status with hardware serial
       · server stamps Terminal.lastActivationStatusCheckAt = now
       · server responds venueId = NEW (already re-parented in step 2b)
   → device re-binds to NEW venue by itself, resumes heartbeating

4. POLL (migrate-status) resolves PROOF when BOTH primary signals are true:
   · reboundAfterWipe:   lastActivationStatusCheckAt > T0   (a non-wiped device NEVER
                         calls activation-status — this alone proves the wipe)
   · onlineUnderNewVenue: terminal online AND venueId === toVenueId
   · wentOffline (lastHeartbeat stale since T0) is shown as corroboration but is NOT
     required — a fast reboot can make the offline blip un-observable; requiring it
     would risk a false negative.
   → "Finalizar" enables. Destination operator did nothing.
```

`migrate-status` response shape:
```ts
{
  commandStatus: 'PENDING'|'SENT'|'EXPIRED'|...,   // from TpvCommandQueue
  commandDelivered: boolean,                        // status >= SENT
  wentOffline: boolean,                             // corroboration only (may be missed)
  reboundAfterWipe: boolean,                        // lastActivationStatusCheckAt > T0
  onlineUnderNewVenue: boolean,                     // online && venueId === toVenueId
  confirmed: boolean,                               // reboundAfterWipe && onlineUnderNewVenue
  elapsedMs: number
}
```

## 7. Error handling & edge cases

- **Risk window (re-parented, reset not yet executed):** the device still holds the OLD
  merchant credentials in cache, so a charge in this gap would route to the old venue.
  *Phase 1 mitigation:* the wizard shows **"NO usar esta terminal hasta finalizar"**, and
  the window is short (one heartbeat cycle). Phase 2 hardens this. Do **not** try to LOCK
  the terminal as a freeze — `validateCommandForTerminal` refuses FACTORY_RESET on a
  LOCKED terminal (`command-queue.service.ts:672-674`).
- **Device never returns (powered off / no internet):** poll times out (~10 min) →
  "La TPV no ha reaparecido…" with "seguir esperando" / "dejar pendiente". **State is
  safe:** the re-parent already committed; whenever the device next connects (within the
  30-min command TTL) it pulls the reset and re-binds to the new venue anyway. If the
  command EXPIRES first, superadmin re-queues only the reset (venue is already correct).
- **Resume:** closing the wizard does not break anything. Reopening detects the pending/
  recent FACTORY_RESET for the terminal and resumes the poll. No duplicate migration.
- **Idempotency:** `migrate-execute` rejects if a migration is already in progress for the
  terminal (a non-expired FACTORY_RESET queued after the last re-parent).

## 8. Permissions

Gate the wizard + endpoints with `tpv-factory-reset:execute`. This permission already
exists in the catalog (`defaultPermissions.ts:459-462`) but is **never enforced** today —
this is the moment to wire it up. Mirror the name exactly on the dashboard
(`<PermissionGate permission="tpv-factory-reset:execute">`). Surface is SUPERADMIN-only
regardless (cross-venue is inherently superadmin).

## 9. File-level touchpoints

**avoqado-server**
- `prisma/schema.prisma` — add `Terminal.lastActivationStatusCheckAt DateTime?` + new migration.
- `src/services/dashboard/terminal-activation.service.ts` — stamp the field in
  `checkTerminalActivationStatus` (~`:215-281`).
- `src/services/dashboard/terminal-migration.service.ts` — **new** orchestrator
  (preflight / execute / status), reusing `updateTerminal()` + `command-queue`.
- `src/controllers/dashboard/...` + `src/routes/...` — 3 superadmin routes, gated by
  `tpv-factory-reset:execute`.
- Reuse: `command-queue.service.ts` (queue FACTORY_RESET), `tpv-health.service.ts`
  (online/lastHeartbeat reads).

**avoqado-web-dashboard**
- `src/pages/Superadmin/Terminals.tsx` — new row action "Migrar a otro venue".
- `src/pages/Superadmin/components/MigrateTerminalWizard.tsx` — **new** 4-step wizard.
- `src/services/superadmin-terminals.service.ts` — 3 new calls (preflight/execute/status).
- `<PermissionGate permission="tpv-factory-reset:execute">`.

## 10. Phase 2 (deferred — needs avoqado-tpv deploy)

1. **Hard drain gate:** surface unsynced queue depth (`pending_payments`,
   `verification_queue`) to the server (heartbeat field or dedicated call) so
   `migrate-preflight` can hard-block until drained.
2. **Pre-wipe ACK:** in `executeFactoryReset()`, before `clearAll()`/`killProcess`, send a
   `WIPE_INITIATED` ACK so "device began wiping" is deterministic, not just inferred.
3. **Fix the two wipe defects:** clear the real `avoqado_checkout_saved_carts` (drop the
   dead `avoqado_prefs`), and flush the two unsynced queues before wiping.

## 11. To confirm during implementation

- Whether the heartbeat payload already carries any unsynced-count fields (would make the
  Phase 2 drain gate cheaper / partially server-only). Audit said unlikely; verify.
- Exact `VenuePaymentConfig` "active" predicate to reuse for the merchant blocker.
- Whether `updateTerminal`'s brand/merchant compatibility check should be lifted into
  `migrate-preflight` as a read-only validator (avoid mutating to discover a blocker).
