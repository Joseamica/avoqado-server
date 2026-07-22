# Staff Selection and Team Schedules — Server Booking and Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the staff-aware foundation into every reservation writer, hold/reschedule protocol, settings transition, public/consumer serializer, check-in, and MCP surface, then produce safe Release A and Release B artifacts.

**Architecture:** The reservation core remains the authority: every entrypoint supplies a required non-persisted `writeOrigin`, the core re-reads settings and canonical product duration inside its serializable transaction, and all capacity/staff decisions happen after the venue lock. Public controllers own HTTP normalization and hold lifecycle but call the same neutral window/assignment helpers. Release A supports only the precisely bounded legacy reschedule-hold shape; a later commit removes that grace for Release B.

**Tech Stack:** TypeScript, Express, Zod, Prisma/PostgreSQL, Jest unit and real-PostgreSQL integration projects, MCP SDK.

## Global Constraints

- Requires all five tasks in `docs/superpowers/plans/2026-07-21-staff-selection-server-foundation.md` to be GREEN first.
- Source of truth: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/superpowers/specs/2026-07-20-seleccion-profesionista-horarios-design.md` v5.2, especially §§3, 6, 8–16.
- Never use `Module`, `MODULE_CODES`, `moduleService`, or `SERIALIZED_INVENTORY`; entitlement is existing Feature `RESERVATIONS`, opt-in is settings, authorization is existing permissions.
- `writeOrigin` is required and has no default: `'PUBLIC' | 'CONSUMER' | 'DASHBOARD' | 'MCP'`.
- Dashboard legacy remains without a new pacing gate. In staff-aware mode, dashboard may skip only global pacing after explicit `allowOverCapacity:true`; it can never skip staff eligibility or personal conflicts.
- Self-service (`PUBLIC`, `CONSUMER`, `MCP`) always treats both capacity gates as hard unless consuming a valid hold; a hold waives only the global pacing recheck.
- `WALK_IN` remains exempt only from booking-window notice, not from staff conflict or staff-aware capacity rules.
- `windowSemantics` accepts only `'base'`; absence is legacy. A new-protocol hold stores the final interval and marker. Reschedule is always historical final duration with marker `null`.
- A `'base'` request derives base duration from products and adds modifiers exactly once; final maximum is 1,440 minutes. Legacy request maximum remains 480.
- `reservationBookedProductIds` is the only read fallback. Explicit product lists persist atomically; productId-only legacy creates keep `productIds=[]`.
- Lock order is `venue advisory → Reservation FOR UPDATE when identified → SlotHold FOR UPDATE`; capture UTC `checkedAt` after locks; no SQL `now()` for Prisma `DateTime` cutoffs.
- Existing holds are capacity promises only within §6's explicit administrative invalidations; never recheck global pacing when consuming a valid hold.
- Every recoverable 409 has `message`, exact `code`, and whitelisted `details`; no client-facing arbitrary database/error payload.
- Release A and B are two distinct commits/artifacts. Do not activate opt-in or deploy a new-protocol client while old server pods remain.
- Strict TDD for each behavior; use real PostgreSQL for row locks, advisory locks, SSI, hold consumption, and activation races.
- Never connect tests or scripts to the user-provided production URL. Rollout preflight is read-only and takes its URL only from the release environment.

---

### Task 1: Required write origins, canonical core writes, product invariants, and two-gate capacity

**Files:**
- Modify: `src/services/dashboard/reservation.dashboard.service.ts`
- Modify: `src/services/dashboard/appointmentStaffAssignment.service.ts`
- Modify: `src/services/dashboard/reservationAvailability.service.ts`
- Modify: `src/controllers/dashboard/reservation.dashboard.controller.ts`
- Modify: `src/controllers/public/reservation.public.controller.ts`
- Modify: `src/services/consumer/reservation.consumer.service.ts`
- Modify: `src/mcp/tools/reservations.ts`
- Modify: `src/services/liveDemo.service.ts`
- Modify: `src/schemas/dashboard/reservation.schema.ts`
- Test: `tests/unit/services/dashboard/reservation.dashboard.service.test.ts`
- Create: `tests/integration/reservations/create-contract.test.ts`

**Interfaces:**
- Produces: `WriteOrigin`, required core arguments, `assertAppointmentCapacity`, canonical create persistence, and dashboard confirmation envelope.
- Consumes: foundation `resolveAppointmentWindow`, `normalizeBookedProductIds`, assignment helpers, settings transaction client, and neutral retry.

- [ ] **Step 1: Write compile-time and runtime RED tests for required origin**

Add a type fixture using `// @ts-expect-error` for a call that omits `writeOrigin`, plus table tests asserting each current entrypoint passes its exact origin. The core type is:

```typescript
export type WriteOrigin = 'PUBLIC' | 'CONSUMER' | 'DASHBOARD' | 'MCP'

export interface ReservationWriteContext {
  writeOrigin: WriteOrigin
  allowOverCapacity?: boolean
  windowSemantics?: 'base'
}
```

Run `npm run typecheck` and the focused suite; expected RED is missing required type/signature and unchanged callers.

- [ ] **Step 2: Make core signatures required and update every caller in one change**

Use explicit context parameters, not values inferred from persisted `Reservation.channel`:

```typescript
createReservation(venueId, data, context, createdById?)
updateReservation(venueId, reservationId, data, context, updatedById)
rescheduleReservation(venueId, reservationId, data, context, updatedById)
rescheduleAppointmentReservation(args & { writeOrigin: WriteOrigin; allowOverCapacity?: boolean })
```

Callers: dashboard=`DASHBOARD`; public and liveDemo=`PUBLIC`; consumer=`CONSUMER`; MCP=`MCP`. Delete the caller-supplied settings argument; inside every retry closure call `getReservationSettings(venueId, tx)` and pass that one object to booking-window, deposits, auto-confirm, assignment, window resolution, and capacity.

- [ ] **Step 3: Write RED tests for product persistence and window authority**

Pin these rows after create:

```typescript
// explicit list
expect(created).toMatchObject({ productId: 'a', productIds: ['a', 'b'], duration: 75 })
// legacy scalar only
expect(created).toMatchObject({ productId: 'a', productIds: [] })
```

Assert a 60-minute appointment plus 15-minute modifier persists final 75 under `'base'`, while legacy retains its current raw/double-extension behavior. Assert both `'base'` 60 product with requested base 5 and legacy-absent marker with raw 5 under staff-aware settings yield `APPOINTMENT_WINDOW_CHANGED` and zero writes; the same legacy raw request under default settings remains byte-compatible. Assert final 1,440 succeeds, 1,441 fails, and legacy >480 fails at schema/core defense.

- [ ] **Step 4: Implement canonical create branching**

Normalize once at the HTTP boundary and pass both canonical IDs and `productIdsWasProvided`. In the core:

```typescript
const bookedProductIds = normalizeBookedProductIds(data).productIds
let resolved: ResolvedAppointmentWindow
if (data.windowSemantics === 'base') {
  resolved = await resolveAppointmentWindow(tx, {
    venueId,
    productIds: bookedProductIds,
    startsAt: data.startsAt,
    baseEndsAt: data.endsAt,
    modifierSelections: data.modifierSelections ?? [],
    settings,
  })
} else {
  await assertLegacyAppointmentDurationFloor(tx, {
    venueId,
    productIds: bookedProductIds,
    rawDurationMin: data.duration,
    settings,
  })
  const modifiers = await resolveModifierSelections(tx, bookedProductIds, data.modifierSelections ?? [])
  const finalDurationMin = data.duration + modifiers.totalDurationDelta
  if (data.duration > 480 || finalDurationMin > 1440) throw new BadRequestError('La duración solicitada excede el máximo permitido')
  resolved = {
    startsAt: data.startsAt,
    baseEndsAt: data.endsAt,
    finalEndsAt: new Date(data.endsAt.getTime() + modifiers.totalDurationDelta * 60_000),
    canonicalBaseDurationMin: data.duration,
    modifierDurationDelta: modifiers.totalDurationDelta,
    finalDurationMin,
    productIds: bookedProductIds,
  }
}
```

Persist `productId = bookedProductIds[0]` and `productIds = data.productIdsWasProvided ? bookedProductIds : []` in the original `reservation.create`; delete any post-commit stamping path. Use resolved final interval for all conflicts, deposits, persistence, and calendar outbox.

- [ ] **Step 5: Write RED tests for two independent capacity gates**

Cover pacing `1/2/null`, one/two staff, occupied A/free B, requested busy staff, and dashboard origin/consent. Exact behavior:

```typescript
new ConflictError(
  'El horario está lleno. Confirma si deseas sobre-agendar.',
  'OVER_CAPACITY_CONFIRMATION_REQUIRED',
  { preview: { startsAt, endsAt, occupancy, limit } },
)
```

Self-service never receives a confirmation code; it receives a hard Spanish 409. Dashboard legacy ignores `allowOverCapacity` and preserves no pacing gate. Staff-aware dashboard without consent writes nothing; with true writes and response includes `overCapacity:true`. A hard staff conflict remains 409 even with true.

- [ ] **Step 6: Implement `assertAppointmentCapacity` after the venue lock**

Run global and resource gates separately. Global limit is legacy `effectiveAppointmentPacing` only for self-service legacy; in staff-aware mode it is `pacingMaxPerSlot ?? Infinity`. Resource gate asks assignment service for a requested or available eligible candidate. Return `{ overCapacity:boolean }`; only dashboard staff-aware may accept a failed global gate with consent.

- [ ] **Step 7: Enforce staff-selection authorization**

PUBLIC/CONSUMER direct `staffId` without a hold is accepted only when `showStaffPicker===true` and the existing Feature middleware granted `RESERVATIONS`; otherwise 400/zero writes. MCP and dashboard retain operated selection. `shouldAutoAssign` handles no explicit staff in staff-aware appointments. Legacy nonappointment rows with staff still call organization-wide personal conflict but never ProductStaff/schedule/autoallocator.

- [ ] **Step 8: Run GREEN and integration row inspection**

```bash
TZ=UTC npx jest tests/unit/services/dashboard/reservation.dashboard.service.test.ts tests/unit/services/dashboard/appointmentStaffAssignment.service.test.ts --runInBand
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' npx jest --selectProjects=integration --runTestsByPath tests/integration/reservations/create-contract.test.ts --runInBand
npm run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add src tests/unit tests/integration/reservations/create-contract.test.ts
git commit -m "feat(reservations): enforce staff-aware write contracts"
```

---

### Task 2: Public/consumer normalization and Release A hold protocol

**Files:**
- Modify: `src/schemas/dashboard/reservation.schema.ts`
- Modify: `src/controllers/public/reservation.public.controller.ts`
- Modify: `src/services/dashboard/reservation.dashboard.service.ts`
- Modify: `src/services/consumer/reservation.consumer.service.ts`
- Modify: `src/routes/public.routes.ts`
- Test: public/consumer controller unit suites
- Create: `tests/integration/reservations/slot-holds.test.ts`
- Create: `tests/integration/reservations/public-product-normalization.test.ts`

**Interfaces:**
- Produces: booking hold/create/availability schemas with canonical product IDs, staff, modifiers, and marker.
- Produces: idempotent `DELETE /reservations/hold/:holdId` and Release A reschedule compatibility.
- Consumes: core Task 1 and foundation assignment/window helpers.

- [ ] **Step 1: Write HTTP normalization RED tests**

Cover `productId` only; matching/conflicting `productId` plus `productIds`; CSV; repeated keys; trim/dedupe/order; explicit empty plus scalar mismatch; and >20. All mismatch/limit cases are 400 and zero writes. Availability, hold, and create must yield identical canonical arrays.

- [ ] **Step 2: Extend exact schemas and boundary mapping**

Booking availability accepts `productIds` as string or string array, `staffId`, `windowSemantics:'base'`, and advisory `duration` up to 1,440 only for the new protocol. Hold accepts `modifierSelections`, same IDs/staff/marker. Public/consumer create maps HTTP `staffId` explicitly to internal `assignedStaffId`; never use `...req.body` for that boundary. Reschedule hold rejects any `windowSemantics` with 400.

- [ ] **Step 3: Write hold creation RED tests**

Normal appointment hold must run in `withSerializableRetry`, acquire venue lock, capture post-lock `checkedAt`, resolve canonical final window, validate/assign staff, gate self-service capacity, and persist:

```typescript
{
  venueId,
  startsAt: resolved.startsAt,
  endsAt: resolved.finalEndsAt,
  productIds: canonicalIds,
  staffId: resolvedStaffId,
  heldForReservationId: null,
  windowSemantics: request.windowSemantics ?? null,
  partySize,
  expiresAt: new Date(checkedAt.getTime() + SLOT_HOLD_TTL_MS),
}
```

Reject a hold with neither product(s) nor `classSessionId`. Explicit staff validates; no staff autoassigns only when required; legacy stores null. Test 55P03 retry and expiry clock after a delayed lock.

For a legacy marker-absent hold under staff-aware settings, call `assertLegacyAppointmentDurationFloor` before inserting. Product canonical 60/raw window 5 yields `APPOINTMENT_WINDOW_CHANGED` and zero holds; default settings retain the raw legacy path.

- [ ] **Step 4: Implement reschedule hold as a separate branch**

Lock order: venue → reservation row → existing live sibling hold. Re-read tenant reservation, validate status/policy, derive booked IDs with `reservationBookedProductIds`, preserve `Reservation.duration` final, derive endsAt, require optional body endsAt ±1, delete sibling, gate target excluding reservation, then insert `{heldForReservationId:R.id, staffId:R.assignedStaffId, windowSemantics:null}`. If target gate fails, transaction rollback restores sibling. Never call canonical Product duration or re-sum modifiers.

- [ ] **Step 5: Write hold-consumption RED matrix**

Normal create requires `heldForReservationId:null`; reschedule R requires exact R identity, marker null, current reprogrammable status, historical duration, and current identity. Normal create marker must equal hold marker before interval comparisons. For `'base'`, re-resolve catalog and compare final interval; for legacy compare raw request↔raw hold exactly. Staff is inherited when omitted and must match when explicit. Global capacity is not rechecked; eligibility/personal conflict is rechecked when staff-aware or hold.staffId exists. Success deletes the locked hold in the reservation transaction; every mismatch/expired/consumed case is 409 and zero reservation writes.

- [ ] **Step 6: Implement Release A legacy reschedule grace precisely**

When `heldForReservationId` is null, permit reschedule only if venue, final interval, party size, and legacy product shape match exactly:

```typescript
const legacyShape = reservation.productId ? [reservation.productId] : []
const releaseAGrace = hold.heldForReservationId === null && arraysEqual(hold.productIds, legacyShape)
```

Log/metric every grace consumption. A multi-service reservation `[A,B]` with old hold `[A]` is deliberately accepted only during A; any other mismatch is 409. Do not use `createdAt` or current time to infer pod generation.

- [ ] **Step 7: Reduce pre-transaction fast-fail and add idempotent release**

With `holdId`, preflight checks only row existence and obvious expiry; capacity/window comparison stays in the locked transaction. DELETE filters by id+venue authorization where applicable and always returns 204 for absent/already-deleted tokens. Server-side `APPOINTMENT_WINDOW_CHANGED` leaves the hold intact so the client can explicitly release it.

- [ ] **Step 8: Add real-PostgreSQL concurrency and guarantee tests**

Cover double create/hold, operator overfills after hold then checkout succeeds, administrative duration change invalidates without consuming, unique consumption, expiry while waiting for advisory lock, reschedule sibling replacement pacing=1, R1 token against R2, normal create with reschedule token, cancelled parent lazy hold excluded by `isLiveSlotHold`, and Release A fixtures. Add simultaneous hold↔`ClassSession.SCHEDULED` races for the same `Staff.id`, both same-venue and cross-venue within one organization; exactly one conflicting writer may commit.

- [ ] **Step 8a: Enforce Feature downgrade on reschedule holds**

Add `RESERVATIONS` entitlement checks to reschedule availability, reschedule-hold mint, and hold-backed consume without gating cancellation or ordinary public reads. Test downgrade before mint (no hold), downgrade between mint and consume (no reservation move; hold invalid commercially), and reactivation. Settings-picker rollback exception does not bypass a lost paid Feature.

- [ ] **Step 10: Run GREEN and commit Release A artifact**

```bash
TZ=UTC npx jest tests/unit/controllers/public tests/unit/services/consumer --runInBand
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' npx jest --selectProjects=integration --runTestsByPath tests/integration/reservations/slot-holds.test.ts tests/integration/reservations/public-product-normalization.test.ts --runInBand
npm run typecheck
git add src tests
git commit -m "feat(reservations): add Release A staff-aware hold protocol"
```

Record this commit hash as the deployable Release A artifact in `.superpowers/sdd/progress.md`.

---

### Task 3: Update/reschedule integrity and transactional opt-in activation

**Files:**
- Modify: `src/services/dashboard/reservation.dashboard.service.ts`
- Modify: `src/services/dashboard/reservationSettings.service.ts`
- Modify: `src/schemas/dashboard/reservation.schema.ts`
- Modify: dashboard/public controllers
- Modify: `tests/unit/services/dashboard/reservationSettings.guard.test.ts`
- Create: `tests/integration/reservations/update-reschedule-settings.test.ts`

**Interfaces:**
- Produces: reversible 1,440-minute update bridge, product invariant, hold invalidation, fixed-duration reschedule, and setup gate.

- [ ] **Step 1: Write update invariant RED tests**

For staff-aware appointments, any product set/lead change is 400. In legacy: scalar-only row changes scalar and keeps `[]`; one-element array changes scalar and `[new]`; clearing makes null/`[]`; multi-service lead change is 400 without data loss. A change to time/duration/product/staff deletes every `heldForReservationId=R.id` in the same transaction; metadata-only edit does not.

Add the rollback duration matrix before implementation: create a valid 600-minute base appointment, disable opt-in, then assert a metadata edit and a time edit preserving duration 600 succeed; growth to 700 fails. Separately, assert a legacy row at or below 480 cannot grow to 600 while opt-in is off.

- [ ] **Step 2: Implement update duration bridge**

Schema accepts duration through 1,440. Core always verifies effective duration ≈ end-start and <=1,440. Compute:

```typescript
const maxAllowed = isAppointmentReservation && isStaffAware(settings)
  ? 1440
  : Math.max(480, reservation.duration)
```

A base-created 600-minute row remains editable/preservable after opt-in off and may shrink, not grow to 700. A legacy <=480 row cannot grow to 600 while off. Nonappointment rows do not inherit staff-aware cap behavior.

- [ ] **Step 3: Write fixed reschedule RED tests**

After product/catalog duration changes 60→90 and 90→60, availability/hold/reschedule still uses stored `Reservation.duration`. Both public and dashboard reschedule preserve current staff; an ineligible/unavailable staff yields zero slots/actionable conflict, never reassignment. Dashboard appointment reschedule uses confirmable global overcapacity; MCP is hard 409. The generic `rescheduleReservation→updateReservation` path gains staff-aware capacity only when time changes; legacy stays unchanged.

- [ ] **Step 4: Implement fixed reschedule data flow**

Resolve reservation by cancelSecret/id under tenant auth, derive IDs with helper, pass internal `fixedDurationMin` and `excludeReservationId` to availability, and never accept fixed duration from query. Hold/reschedule derive final endsAt from stored duration. Preserve assigned staff and invalidate existing sibling on identity changes.

- [ ] **Step 5: Write activation race RED tests**

Activation off→on fails with actionable service IDs when any active appointment product has zero mappings; fails with confirmation codes when future active appointment reservations lack staff; fails when any live appointment hold lacks staff. Test activation-vs-create and activation-vs-hold barriers: exactly one wins and final state is consistent. `weekly:null` and later new unmapped service do not disable opt-in; they simply fall back/no slots per normal rules.

- [ ] **Step 6: Implement transactional setup gate**

`updateReservationSettings` uses neutral retry and venue advisory. Inside closure: re-read current settings; determine off→on; validate all active appointment ProductStaff mappings; acquire lock in standard order; capture checkedAt; query future unstaffed appointment reservations and live null-staff holds with parameterized UTC dates; then upsert. Use the same transaction client for all reads/writes. Return Spanish 400/409 details; never interpolate SQL `now()`.

- [ ] **Step 7: Run GREEN**

```bash
TZ=UTC npx jest tests/unit/services/dashboard/reservation.dashboard.service.test.ts tests/unit/services/dashboard/reservationSettings.guard.test.ts --runInBand
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' npx jest --selectProjects=integration --runTestsByPath tests/integration/reservations/update-reschedule-settings.test.ts --runInBand
npm run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat(reservations): harden updates reschedules and opt-in"
```

---

### Task 4: Entitled serializers, check-in attribution, URL safety, and MCP parity

**Files:**
- Modify: `src/controllers/public/reservation.public.controller.ts`
- Modify: `src/services/consumer/venue.consumer.service.ts`
- Modify: `src/services/reservation/createOrderFromReservation.ts`
- Modify: `src/mcp/tools/reservations.ts`
- Modify: relevant MCP registration/tests
- Create: `tests/integration/reservations/serializers-mcp-checkin.test.ts`

**Interfaces:**
- Produces: independent optional `appointmentWindowSemantics` and `staffSelection`, servedBy prefill, safe return URLs, and six MCP tools with parity.

- [ ] **Step 1: Write serializer entitlement RED matrix**

Public `/info` and consumer venue read omit both new keys in legacy settings, or when Feature `RESERVATIONS` is false even with stale opt-in settings. `per_staff` plus picker off and entitled emits only `appointmentWindowSemantics:'base'`. Entitled picker on emits capability plus strict whitelist:

```typescript
staffSelection: {
  enabled: true,
  staffByProductId: { [productId]: [{ id: staffId, name, photoUrl }] },
}
```

Use a FREE non-exempt fixture; grandfather/demo is invalid for the negative case.

- [ ] **Step 2: Implement shared entitled serialization**

Resolve `venueHasFeatureAccess(venueId,'RESERVATIONS')` once per request and pass the boolean with settings to a shared pure serializer. Query ProductStaff→StaffVenue→Staff in one relation load; filter active membership/staff and return only id/name/photo. Never gate the whole public venue endpoint.

- [ ] **Step 3: Write and implement check-in attribution test**

Only the new-order branch passes `servedById: reservation.assignedStaffId ?? undefined` into order creation. Existing idempotent/best-effort branches remain unchanged. ActivityLog remains only `{created:true}`; no backfill or update of existing orders.

- [ ] **Step 4: Write and implement return-URL whitelist tests**

Use `new URL`; allow HTTPS exact `avoqado.io`, subdomains via `endsWith('.avoqado.io')`, or exact venue website host; localhost/127.0.0.1 only in development. Ignore `javascript:`, `data:`, non-HTTP, `evilavoqado.io`, and foreign hosts. Set redirect params with `URL.searchParams.set`; invalid URL falls back silently, never 400.

- [ ] **Step 5: Write MCP parity RED tests**

Extend `reservation_settings` and `configure_reservations` with both opt-ins and setup-gate preview/confirm. `create_reservation` resolves canonical appointment product duration, fixes `'base'` in opt-in, supports staffId/staffName uniqueness, and supplies `writeOrigin:'MCP'`; explicit duration mismatch yields window code. Default 90 remains only legacy no-product/nonappointment.

Register exact tools: `staff_schedule`, `set_staff_schedule`, `service_staff`, `set_service_staff`. Reads require `teams:read`/`menu:read`; writes require update permission, plan gate `RESERVATIONS`, preview then `confirm:true`, and `auditMcpWrite` after success. Reuse Task 4 foundation services; no duplicate DB logic.

- [ ] **Step 6: Run GREEN**

```bash
TZ=UTC npx jest tests/unit/mcp-customer tests/unit/controllers/public tests/unit/services/consumer --runInBand
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' npx jest --selectProjects=integration --runTestsByPath tests/integration/reservations/serializers-mcp-checkin.test.ts --runInBand
npm run audit:permissions
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat(reservations): expose staff selection and MCP parity"
```

---

### Task 5: Operational preflights, demo mappings, Release B strictness, and server completion gate

**Files:**
- Create: `scripts/preflight-reservation-staff-rollout.ts`
- Create: `tests/unit/scripts/preflight-reservation-staff-rollout.test.ts`
- Modify: `prisma/seed.ts`
- Confirm no-op: `src/services/onboarding/demoSeed.service.ts`
- Modify: Release A grace in public hold consumption to strict B
- Modify: `tests/integration/reservations/slot-holds.test.ts`
- Create: `docs/runbooks/reservation-staff-rollout.md`

**Interfaces:**
- Produces: parameterized read-only preflight, explicit demo ProductStaff mappings, and final strict `heldForReservationId===R.id` Release B artifact.

- [ ] **Step 1: Write preflight query RED tests**

The script exports query builders and a runner returning counts for: future active assigned Reservation/ClassSession missing same-venue StaffVenue; future organization+Staff overlaps for Reservation↔Reservation, Reservation↔ClassSession, ClassSession↔ClassSession (self joins use `a.id < b.id`); and future PENDING/CONFIRMED reservations whose nonempty `productIds[1]` differs from `productId`. Fixture one violation per category and assert exact count; all-zero exits 0, any nonzero exits 1. Queries are SELECT-only and use `clock_timestamp() AT TIME ZONE 'UTC'` only for operational SQL.

- [ ] **Step 2: Implement safe preflight CLI**

Read `DATABASE_URL` from environment without printing it; open Prisma, run the fixed parameterized queries, log only category/count and actionable row IDs/confirmation codes scoped to the release operator, disconnect, and set exit code. Reject execution when `NODE_ENV==='test'` lacks a test URL. Never update/backfill automatically.

- [ ] **Step 3: Add demo mappings with correct identity**

In wellness seed, after both products and staff exist, resolve `StaffVenue` via composite `staffId_venueId` and create explicit ProductStaff rows. Do not insert Staff.id into `staffVenueId`. Keep `demoSeed.service.ts` unchanged because it creates no appointment product/staff mapping; add a comment to the runbook, not dead code.

- [ ] **Step 4: Write Release B RED tests and remove grace**

Change Release A legacy-null fixture expectation to 409/zero writes. Keep exact `heldForReservationId===reservation.id` success. Delete grace branch and metric, not the additive columns or dual marker comparisons. Commit this separately so Release A remains deployable by its recorded hash.

- [ ] **Step 5: Document exact deployment sequence**

Run preflight before A; deploy recorded A commit with defaults and no new clients; wait until every old pod exits; rerun every preflight; record control-plane timestamp; wait `SLOT_HOLD_TTL_MS + 60s`; deploy B commit; then clients in order dashboard/desktop → widget/consumer → iOS+Android together → one pilot opt-in. Include rollback settings-first and the exact live-hold drain SELECT from v5.2 §16. State that branch protection must mark `test-and-build` required.

- [ ] **Step 6: Run the complete server gate on ephemeral PostgreSQL**

```bash
npm ci
TZ=UTC npx jest tests/unit/services/dashboard/reservationAvailability.service.test.ts tests/unit/services/dashboard/reservation.dashboard.service.test.ts --runInBand
npm run test:unit
export TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test'
export DATABASE_URL="$TEST_DATABASE_URL"
npx prisma migrate deploy
npm run test:integration
npm run audit:permissions
npm run schema:map -- --check
npm run typecheck
npm run pre-deploy
```

Expected: every command exits 0. Never run this gate with a production URL.

- [ ] **Step 7: Commit Release B artifact**

```bash
git add scripts/preflight-reservation-staff-rollout.ts tests prisma/seed.ts docs/runbooks/reservation-staff-rollout.md src/controllers/public/reservation.public.controller.ts src/services/dashboard/reservation.dashboard.service.ts
git commit -m "feat(reservations): finalize strict staff rollout"
```

Record both A and B hashes in the progress ledger and run an independent whole-feature reviewer before any client work is declared mergeable.
