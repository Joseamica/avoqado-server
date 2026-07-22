# Staff Selection and Team Schedules — Server Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the additive database, retry, canonical-window, management-CRUD, and staff-eligibility foundation required by the v5.2 professional-selection booking design without changing legacy booking behavior.

**Architecture:** The server keeps its existing Routes → Controllers → Services → Prisma layering. Neutral transaction/window helpers sit below dashboard/public/consumer entrypoints; staff schedules and service mappings are venue-scoped configuration; a single assignment service owns schedule evaluation, organization-scoped personal conflicts, and deterministic allocation. Booking and hold writers consume these interfaces in the follow-up server booking plan and must not be partially wired in this foundation slice.

**Tech Stack:** TypeScript, Express, Zod, Prisma, PostgreSQL `SERIALIZABLE`, Jest/ts-jest, real-PostgreSQL integration tests, date-fns-tz.

## Global Constraints

- Source of truth: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server/docs/superpowers/specs/2026-07-20-seleccion-profesionista-horarios-design.md`, version 5.2, especially §§1–8, 13, 15–16.
- `RESERVATIONS` is an existing paid **Feature**; never create or query a `Module`, `MODULE_CODES`, `moduleService`, Stripe product, or `SERIALIZED_INVENTORY` gate for this epic.
- Absence of opt-in configuration preserves legacy output and behavior; `isStaffAware = capacityMode === 'per_staff' || showStaffPicker === true`.
- New Prisma fields are additive with defaults: `showStaffPicker=false`, `capacityMode='pacing'`; use `prisma migrate dev`, never `db push`.
- Tenant isolation is absolute: resolve every parent with its validated `venueId`; organization-wide staff conflicts may return only existence, never another venue's identifying data.
- Staff identity on booking APIs is `Staff.id`; management APIs use `StaffVenue.id`.
- Every personal-occupancy writer uses the same organization-scoped predicate inside a serializable retry; no second per-staff advisory lock.
- In flows that use `lockAppointmentVenue`, acquire that venue advisory lock before their row locks; capture `checkedAt = new Date()` after locks that may wait; never compare Prisma `DateTime` to SQL `now()`/`CURRENT_TIMESTAMP`. ClassSession writers and `hardDeleteTeamMember` rely on shared serializable predicate reads/row locks and do **not** add the appointment venue advisory lock.
- Retry only `P2034`, direct `40001`/`55P03`, and `P2010` wrapping `40001`/`55P03`; never blanket-retry `P2028`.
- New window protocol is exactly `windowSemantics: 'base'`; legacy is `null`/absent. Canonical final duration is at most 1,440 minutes; legacy request limit remains 480.
- Reuse permissions `teams:read/update`, `menu:read/update`, and `reservations:*`; add no permission strings.
- Execution clarification v5.2-ID-1: ProductStaff management responses keep `staffVenueIds` and add `staff: Array<{ staffVenueId: string; staffId: string }>` so operated mobile/desktop rosters keyed by `Staff.id` can join the mapping without a new endpoint or permission.
- Zod validation messages are Spanish; controllers remain thin; business rules live in services.
- Tests are strict TDD: add one failing behavior test, run and record RED, implement minimally, run GREEN, then refactor. Never assert mock behavior or add test-only production APIs.
- Unit tests use `TZ=UTC`; transactional invariants require the real `integration` Jest project with `TEST_DATABASE_URL`, never prismaMock alone.
- Preserve unrelated changes in the user's main worktrees. Work only in `/Users/amieva/.codex/worktrees/avoqado-server/staff-selection-schedules` on `codex/staff-selection-schedules`.

---

### Task 1: Additive reservation-staff persistence, enforceable PostgreSQL CI, and test infrastructure

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260721_add_reservation_staff_schedules/migration.sql`
- Modify: `scripts/generate-schema-map.ts`
- Modify: `docs/SCHEMA_MAP.md` (generated)
- Modify: `tests/__helpers__/setup.ts`
- Modify: `tests/unit/services/dashboard/reservationAvailability.service.test.ts` (re-prime after its local `jest.resetAllMocks()`)
- Modify: `.github/workflows/ci-cd.yml`
- Modify: `scripts/pre-deploy-check.sh`
- Test: `tests/unit/scripts/pre-deploy-check.test.ts`
- Conditional fix if clean-DB RED confirms it: `tests/integration/referrals/referrals.integration.test.ts`

**Interfaces:**
- Produces: Prisma delegates `staffSchedule`, `staffScheduleException`, `productStaff`; additive `SlotHold.staffId`, `SlotHold.heldForReservationId`, `SlotHold.windowSemantics`; `ReservationSettings.showStaffPicker/capacityMode`; interval indexes required by later organization-wide conflict queries.
- Produces: integration test environment that always uses a caller-supplied ephemeral PostgreSQL URL and never logs credentials.

- [ ] **Step 1: Write the failing schema/CI contract test**

Create `tests/unit/scripts/pre-deploy-check.test.ts` with an executable regression harness; it must prove shell-provided DB variables win and no URL prefix is printed. The test copies the script into a temporary directory, writes a conflicting `.env`, prepends fake `npm`/`npx` executables that append their observed `DATABASE_URL` to a log and exit 0, exports sentinel URLs, then executes Bash:

```typescript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

describe('pre-deploy database safety contract', () => {
  it('keeps exported DB URLs authoritative without exposing credentials', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predeploy-env-'))
    const bin = path.join(dir, 'bin')
    const observed = path.join(dir, 'observed.log')
    fs.mkdirSync(bin)
    fs.copyFileSync(path.resolve('scripts/pre-deploy-check.sh'), path.join(dir, 'pre-deploy-check.sh'))
    fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL="postgresql://dotenv:secret@invalid/db"\nTEST_DATABASE_URL="postgresql://dotenv:test-secret@invalid/test"\n')
    const fake = '#!/bin/bash\necho "$DATABASE_URL" >> "$OBSERVED_DB_LOG"\nexit 0\n'
    for (const name of ['npm', 'npx', 'git']) {
      fs.writeFileSync(path.join(bin, name), fake, { mode: 0o755 })
    }

    const sentinel = 'postgresql://sentinel_user:sentinel_password@127.0.0.1:1/sentinel'
    const output = execFileSync('/bin/bash', ['pre-deploy-check.sh'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OBSERVED_DB_LOG: observed, DATABASE_URL: sentinel, TEST_DATABASE_URL: sentinel },
    })

    expect(fs.readFileSync(observed, 'utf8').trim().split('\n').every(value => value === sentinel)).toBe(true)
    expect(output).toContain('test DB configurada')
    expect(output).not.toContain('sentinel_user')
    expect(output).not.toContain('sentinel_password')
  })
})
```

- [ ] **Step 2: Run the focused test and record RED**

Run: `TZ=UTC npx jest tests/unit/scripts/pre-deploy-check.test.ts --runInBand`

Expected: FAIL because the dotenv value reaches fake child commands and/or output exposes the credential-bearing URL prefix.

- [ ] **Step 3: Add the exact Prisma models and relations**

Insert these models near the reservation models, then add the listed inverse fields inside the existing parents:

```prisma
model StaffSchedule {
  id           String     @id @default(cuid())
  staffVenueId String     @unique
  staffVenue   StaffVenue @relation(fields: [staffVenueId], references: [id], onDelete: Cascade)
  venueId      String
  weekly       Json
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt

  @@index([venueId])
}

model StaffScheduleException {
  id           String     @id @default(cuid())
  staffVenueId String
  staffVenue   StaffVenue @relation(fields: [staffVenueId], references: [id], onDelete: Cascade)
  venueId      String
  startDate    String
  endDate      String
  kind         String
  startTime    String?
  endTime      String?
  note         String?
  createdAt    DateTime   @default(now())

  @@index([staffVenueId, startDate, endDate])
  @@index([venueId, startDate])
}

model ProductStaff {
  id           String     @id @default(cuid())
  productId    String
  product      Product    @relation(fields: [productId], references: [id], onDelete: Cascade)
  staffVenueId String
  staffVenue   StaffVenue @relation(fields: [staffVenueId], references: [id], onDelete: Cascade)
  venueId      String
  createdAt    DateTime   @default(now())

  @@unique([productId, staffVenueId])
  @@index([venueId, productId])
  @@index([staffVenueId])
}
```

Add:

```prisma
// Staff
slotHolds SlotHold[]

// StaffVenue
schedule           StaffSchedule?
scheduleExceptions StaffScheduleException[]
productStaff       ProductStaff[]

// Product
productStaff ProductStaff[]

// Reservation
rescheduleSlotHolds SlotHold[] @relation("ReservationRescheduleHolds")
@@index([assignedStaffId, startsAt, endsAt])

// ClassSession
@@index([assignedStaffId, startsAt, endsAt])

// ReservationSettings
showStaffPicker Boolean @default(false)
capacityMode    String  @default("pacing")

// SlotHold
staffId              String?
staff                Staff?       @relation(fields: [staffId], references: [id], onDelete: Cascade)
heldForReservationId String?
heldForReservation   Reservation? @relation("ReservationRescheduleHolds", fields: [heldForReservationId], references: [id], onDelete: Cascade)
windowSemantics      String?
@@index([venueId, staffId, startsAt])
@@index([staffId, startsAt, endsAt])
@@index([heldForReservationId, expiresAt])
```

- [ ] **Step 4: Generate and inspect the additive migration**

Run: `npx prisma migrate dev --name add-reservation-staff-schedules`

Expected: validation succeeds and generated SQL contains only three table creates, two settings columns with defaults, three nullable hold columns/FKs, and indexes. Inspect `git diff -- prisma/migrations prisma/schema.prisma`; fail the task if it drops, rewrites, or backfills an existing column.

- [ ] **Step 5: Register schema-map and Jest delegates**

Add exact domain entries:

```typescript
StaffSchedule: 'Reservations & Booking',
StaffScheduleException: 'Reservations & Booking',
ProductStaff: 'Reservations & Booking',
```

Add to `prismaMock`:

```typescript
staffSchedule: createMockModel(),
staffScheduleException: createMockModel(),
productStaff: createMockModel(),
```

Export a reusable `primeReservationStaffMocks()` function and call it both at module initialization and after `jest.clearAllMocks()` in the global `beforeEach`:

```typescript
export function primeReservationStaffMocks() {
  prismaMock.staffSchedule.findUnique.mockResolvedValue(null)
  prismaMock.staffScheduleException.findMany.mockResolvedValue([])
  prismaMock.productStaff.findMany.mockResolvedValue([])
}

primeReservationStaffMocks()
beforeEach(() => {
  jest.clearAllMocks()
  primeReservationStaffMocks()
})
```

Because `tests/unit/services/dashboard/reservationAvailability.service.test.ts` calls `jest.resetAllMocks()` in its own `beforeEach` after global setup, import `primeReservationStaffMocks` there and invoke it immediately after that reset. This local re-prime is mandatory; otherwise future staff-aware tests receive `undefined` instead of empty configuration.

- [ ] **Step 6: Make integration tests a production gate and harden dotenv precedence**

In `.github/workflows/ci-cd.yml`, add a PostgreSQL service to `test-and-build`:

```yaml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: avoqado_test
    ports:
      - 5432:5432
    options: >-
      --health-cmd "pg_isready -U postgres -d avoqado_test"
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

Set both job variables to `postgresql://postgres:postgres@localhost:5432/avoqado_test`, run `npx prisma migrate deploy`, then `npm run test:integration`; remove the secret-presence skip and `continue-on-error`. Keep this inside `test-and-build`, already required by production deploy.

Before declaring this GREEN, run the full integration project against a newly migrated, unseeded database. If `tests/integration/referrals/referrals.integration.test.ts` fails because it assumes seeded organizations/venues, change that test's `beforeAll` to create its own uniquely prefixed organization/venue/customer fixtures and its `afterAll` to delete exactly those fixture IDs. Do not run the production/demo seed in CI, skip the suite, or weaken assertions.

Immediately after `set -e`, preserve caller values:

```bash
DATABASE_URL_WAS_SET="${DATABASE_URL-}"
TEST_DATABASE_URL_WAS_SET="${TEST_DATABASE_URL-}"
```

Keep the current safe `.env` parser unchanged. Immediately after its closing `fi`, restore caller precedence:

```bash
if [ -n "$DATABASE_URL_WAS_SET" ]; then export DATABASE_URL="$DATABASE_URL_WAS_SET"; fi
if [ -n "$TEST_DATABASE_URL_WAS_SET" ]; then export TEST_DATABASE_URL="$TEST_DATABASE_URL_WAS_SET"; fi
```

Replace every credential-bearing URL log with `echo "test DB configurada"`.

- [ ] **Step 7: Run GREEN and schema gates**

Run:

```bash
TZ=UTC npx jest tests/unit/scripts/pre-deploy-check.test.ts --runInBand
npx prisma validate
npm run schema:map
npm run schema:map -- --check
npm run typecheck
```

Expected: all commands exit 0; `git diff --exit-code docs/SCHEMA_MAP.md` is expected to fail before staging because generation is part of the task, but a second `npm run schema:map -- --check` must pass.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations scripts/generate-schema-map.ts docs/SCHEMA_MAP.md tests/__helpers__/setup.ts tests/unit/scripts/pre-deploy-check.test.ts tests/unit/services/dashboard/reservationAvailability.service.test.ts .github/workflows/ci-cd.yml scripts/pre-deploy-check.sh
git commit -m "feat(reservations): add staff scheduling persistence"
```

---

### Task 2: Extract and normalize serializable retry behavior

**Files:**
- Create: `src/utils/serializableRetry.ts`
- Create: `tests/unit/utils/serializableRetry.test.ts`
- Modify: `src/services/dashboard/reservation.dashboard.service.ts`
- Modify: `src/services/dashboard/classSession.dashboard.service.ts`
- Modify: `src/services/dashboard/creditPack.public.service.ts`
- Modify: `src/services/consumer/reservation.consumer.service.ts`
- Modify: `src/controllers/public/reservation.public.controller.ts`
- Modify: affected unit mocks that import `withSerializableRetry`
- Create: `tests/integration/reservations/serializable-retry.test.ts`

**Interfaces:**
- Produces: `isRetryableDbError(error: unknown): boolean`.
- Produces: `withSerializableRetry<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeoutMs?: number; maxRetries?: number; baseDelayMs?: number }): Promise<T>`.
- Consumes: shared Prisma singleton; no dashboard service imports, preventing settings/ClassSession circular imports.

- [ ] **Step 1: Write classifier and retry-loop tests first**

Create table-driven tests with these exact expectations:

```typescript
it.each([
  [{ code: 'P2034' }, true],
  [{ code: '40001' }, true],
  [{ code: '55P03' }, true],
  [{ code: 'P2010', meta: { code: '40001' } }, true],
  [{ code: 'P2010', meta: { code: '55P03' } }, true],
  [{ code: 'P2028' }, false],
  [{ code: 'P2010', meta: { code: '23505' } }, false],
])('classifies %j as %s', (error, expected) => {
  expect(isRetryableDbError(error)).toBe(expected)
})
```

Mock `prisma.$transaction` to reject twice with `P2034` then resolve; assert the callback is attempted three times. Assert exhaustion throws a `ConflictError` with status 409 and a non-retryable error is rethrown unchanged.

- [ ] **Step 2: Run RED**

Run: `TZ=UTC npx jest tests/unit/utils/serializableRetry.test.ts --runInBand`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the neutral helper**

```typescript
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

const RETRY_SQLSTATES = new Set(['40001', '55P03'])

function nestedCode(error: Record<string, unknown>): string | undefined {
  const meta = error.meta as Record<string, unknown> | undefined
  const cause = error.cause as Record<string, unknown> | undefined
  return [meta?.code, meta?.sqlState, cause?.code].find(value => typeof value === 'string') as string | undefined
}

export function isRetryableDbError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as Record<string, unknown>
  if (value.code === 'P2034') return true
  if (typeof value.code === 'string' && RETRY_SQLSTATES.has(value.code)) return true
  return value.code === 'P2010' && RETRY_SQLSTATES.has(nestedCode(value) ?? '')
}

export async function withSerializableRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeoutMs?: number; maxRetries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 10_000, maxRetries = 5, baseDelayMs = 50 } = options
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: timeoutMs,
      })
    } catch (error) {
      if (!isRetryableDbError(error)) throw error
      if (attempt === maxRetries) throw new ConflictError('Conflicto de concurrencia persistente, por favor intente de nuevo')
      logger.warn({ attempt, maxRetries }, 'Serialization/lock conflict; retrying transaction')
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)))
    }
  }
  throw new ConflictError('Conflicto de concurrencia persistente')
}
```

- [ ] **Step 4: Replace every old import/call site**

Delete the local helper from `reservation.dashboard.service.ts`. Import from `@/utils/serializableRetry` in every runtime caller. Update test mocks to mock that neutral module, especially `tests/unit/services/dashboard/creditPack.public.service.test.ts`; do not leave a compatibility re-export in the reservation service because it would preserve the circular dependency.

- [ ] **Step 5: Add a real-PostgreSQL contention test**

In `tests/integration/reservations/serializable-retry.test.ts`, use two independent Prisma clients and a barrier table row so both serializable closures read before either writes. Assert one closure retries and both final increments are present. Add a second case that runs `SET LOCAL lock_timeout = '50ms'` then attempts a held advisory lock with `{ maxRetries: 2, baseDelayMs: 1 }`; assert the public error is 409 and never `P2028`/500.

- [ ] **Step 6: Run GREEN and regression gates**

```bash
TZ=UTC npx jest tests/unit/utils/serializableRetry.test.ts tests/unit/services/dashboard/reservation.dashboard.service.test.ts tests/unit/services/dashboard/creditPack.public.service.test.ts --runInBand
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' npx jest --selectProjects=integration --runTestsByPath tests/integration/reservations/serializable-retry.test.ts --runInBand
npm run typecheck
```

Expected: PASS; the integration command may run only after the local ephemeral test DB has been migrated.

- [ ] **Step 7: Commit**

```bash
git add src/utils/serializableRetry.ts src/services tests/unit tests/integration/reservations/serializable-retry.test.ts
git commit -m "refactor(reservations): centralize serializable retries"
```

---

### Task 3: Canonical appointment-window and recoverable error contracts

**Files:**
- Create: `src/services/reservation/resolveAppointmentWindow.ts`
- Create: `tests/unit/services/reservation/resolveAppointmentWindow.test.ts`
- Modify: `src/errors/AppError.ts`
- Modify: `src/app.ts`
- Create: `tests/unit/errors/AppError.details.test.ts`
- Modify: `src/services/dashboard/reservationSettings.service.ts`
- Modify: `tests/unit/services/dashboard/reservationSettings.guard.test.ts`

**Interfaces:**
- Produces: `normalizeBookedProductIds(input): NormalizedBookedProducts`.
- Produces: `reservationBookedProductIds(reservation): string[]`.
- Produces: `resolveCanonicalAppointmentDuration(db, args): Promise<{ productIds: string[]; canonicalBaseDurationMin: number }>`.
- Produces: `resolveAppointmentWindow(tx, input): Promise<ResolvedAppointmentWindow>`.
- Produces: `ConflictError(message, code?, details?)` whose handler serializes `details`.
- Produces: `ReservationConfig.publicBooking.showStaffPicker`, `ReservationConfig.scheduling.capacityMode`, and `isStaffAware(settings)`.

- [ ] **Step 1: Write failing error-envelope tests**

Pin the class contract:

```typescript
const error = new ConflictError('La duración cambió', 'APPOINTMENT_WINDOW_CHANGED', {
  expectedBaseDurationMin: 60,
  expectedBaseEndsAt: '2026-07-21T18:00:00.000Z',
})
expect(error).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_WINDOW_CHANGED' })
expect(error.details).toEqual({ expectedBaseDurationMin: 60, expectedBaseEndsAt: '2026-07-21T18:00:00.000Z' })
```

Add a small supertest/global-handler test that throws this error and asserts the JSON includes only `message`, `code`, and `details` in production mode.

- [ ] **Step 2: Run RED, then extend `AppError`**

Run: `TZ=UTC npx jest tests/unit/errors/AppError.details.test.ts --runInBand`

Implement:

```typescript
class AppError extends Error {
  public statusCode: number
  public isOperational: boolean
  public status: string
  public code?: string
  public details?: unknown

  constructor(message: string, statusCode: number, isOperational = true, code?: string, details?: unknown) {
    super(message)
    this.statusCode = statusCode
    this.isOperational = isOperational
    this.code = code
    this.details = details
    this.status = statusCode >= 400 && statusCode < 500 ? 'fail' : 'error'
    Object.setPrototypeOf(this, new.target.prototype)
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor)
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicto de recurso', code?: string, details?: unknown) {
    super(message, 409, true, code, details)
  }
}
```

In `src/app.ts`, add `...(err.details !== undefined && { details: err.details })` beside `code`. Remove the obsolete `TerminalBrandChangeBlocked` comment claiming details were already serialized only after the behavior test is green.

- [ ] **Step 3: Write product-normalization/window tests and record RED**

Cover exact cases:

```typescript
expect(normalizeBookedProductIds({ productId: 'a' })).toEqual({ productIds: ['a'], leadProductId: 'a', productIdsWasProvided: false })
expect(normalizeBookedProductIds({ productId: 'a', productIds: 'a,b,a' }).productIds).toEqual(['a', 'b'])
expect(normalizeBookedProductIds({ productIds: ['a,b', 'c'] }).productIds).toEqual(['a', 'b', 'c'])
expect(() => normalizeBookedProductIds({ productId: 'a', productIds: [] })).toThrow(/coincidir/i)
expect(() => normalizeBookedProductIds({ productId: 'b', productIds: ['a'] })).toThrow(/coincidir/i)
expect(() => normalizeBookedProductIds({ productIds: Array.from({ length: 21 }, (_, i) => `p${i}`) })).toThrow(/20/)
```

For a 60-minute appointment product, assert `'base'` request of 5 minutes throws `APPOINTMENT_WINDOW_CHANGED`. Also expose/test `assertLegacyAppointmentDurationFloor`: staff-aware settings plus raw legacy 5 for canonical 60 throws the same code, while settings defaults keep raw 5 byte-compatible. Then assert 60 + modifier 15 resolves final 75 exactly once; 1,440 final passes and 1,441 fails. Assert product count/venue/type mismatch fails closed. Assert `reservationBookedProductIds({ productId:'a', productIds:[] })` returns `['a']` and a nonempty array whose first item differs from `productId` throws 409.

- [ ] **Step 4: Implement the exact public types and normalization**

```typescript
export type WindowSemantics = 'base'
export interface NormalizedBookedProducts {
  productIds: string[]
  leadProductId: string | undefined
  productIdsWasProvided: boolean
}
export interface ResolvedAppointmentWindow {
  startsAt: Date
  baseEndsAt: Date
  finalEndsAt: Date
  canonicalBaseDurationMin: number
  modifierDurationDelta: number
  finalDurationMin: number
  productIds: string[]
}
```

Normalize by flattening string/array values, splitting commas, trimming, dropping empties, stable-deduping, and rejecting more than 20. Use precedence `productIds !== undefined ? productIds : productId ? [productId] : []`; if both keys were sent, require `productId === normalized[0]`, including explicit-empty mismatch.

- [ ] **Step 5: Implement canonical duration and resolved window**

`resolveCanonicalAppointmentDuration` must fetch all IDs in one query with `{ id: { in: productIds }, venueId, type: 'APPOINTMENTS_SERVICE' }`, require exact count, restore request order, and sum `duration ?? durationMinutes ?? settings.scheduling.defaultDurationMin` per product. `resolveAppointmentWindow` must compare base minutes within ±1, call existing `resolveModifierSelections` once, compute `finalDurationMin`, reject above 1,440, and throw:

```typescript
throw new ConflictError('La duración del servicio cambió. Selecciona el horario nuevamente.', 'APPOINTMENT_WINDOW_CHANGED', {
  expectedBaseDurationMin: canonicalBaseDurationMin,
  expectedBaseEndsAt: new Date(startsAt.getTime() + canonicalBaseDurationMin * 60_000).toISOString(),
})
```

Add `assertLegacyAppointmentDurationFloor(db, { venueId, productIds, rawDurationMin, settings })`: return immediately when `!isStaffAware(settings)`; otherwise call the canonical-duration helper and throw `APPOINTMENT_WINDOW_CHANGED` when `rawDurationMin < canonicalBaseDurationMin`. It does not rewrite the legacy raw interval or remove the legacy modifier behavior.

Do not wire this helper into holds/creates yet; that is an atomic task in the booking plan.

- [ ] **Step 6: Extend settings mapping without the setup transition**

Make `getReservationSettings(venueId, client = prisma)` accept `Prisma.TransactionClient | typeof prisma`. Add:

```typescript
// ReservationConfig.scheduling
capacityMode: 'pacing' | 'per_staff'
// ReservationConfig.publicBooking
showStaffPicker: boolean

export function isStaffAware(settings: ReservationConfig): boolean {
  return settings.scheduling.capacityMode === 'per_staff' || settings.publicBooking.showStaffPicker === true
}
```

Map unknown DB strings to `'pacing'`, add defaults, and support both flat and nested update DTOs using `!== undefined`. Do not implement the off→on transactional setup gate until the assignment/hold predicate exists.

- [ ] **Step 7: Run GREEN**

```bash
TZ=UTC npx jest tests/unit/errors/AppError.details.test.ts tests/unit/services/reservation/resolveAppointmentWindow.test.ts tests/unit/services/dashboard/reservationSettings.guard.test.ts --runInBand
npm run typecheck
```

Expected: PASS and no existing reservation test changes.

- [ ] **Step 8: Commit**

```bash
git add src/errors/AppError.ts src/app.ts src/services/reservation/resolveAppointmentWindow.ts src/services/dashboard/reservationSettings.service.ts tests/unit
git commit -m "feat(reservations): resolve canonical appointment windows"
```

---

### Task 4: Venue-scoped staff schedule and ProductStaff management APIs

**Files:**
- Modify: `src/schemas/dashboard/reservation.schema.ts`
- Create: `src/services/dashboard/staffSchedule.service.ts`
- Create: `src/services/dashboard/productStaff.service.ts`
- Create: `tests/unit/services/dashboard/staffSchedule.service.test.ts`
- Create: `tests/unit/services/dashboard/productStaff.service.test.ts`
- Modify: `src/controllers/dashboard/reservation.dashboard.controller.ts`
- Modify: `src/routes/dashboard/reservation.routes.ts`
- Create: `tests/integration/reservations/staff-management.test.ts`

**Interfaces:**
- Produces: `getStaffSchedule(venueId, staffVenueId)` and `replaceStaffSchedule(venueId, staffVenueId, input, actorId)`.
- Produces: `getProductStaff(venueId, productId)` and `replaceProductStaff(venueId, productId, staffVenueIds, actorId)`; both return the additive StaffVenue↔Staff bridge from v5.2-ID-1.
- Produces four routes before `/:id`: `GET/PUT staff/:staffVenueId/schedule`, `GET/PUT products/:productId/staff`.

- [ ] **Step 1: Write schema tests first**

Export a required seven-day schema while keeping legacy settings optional:

```typescript
export const weeklyScheduleSchema = z.object({
  monday: dayScheduleSchema,
  tuesday: dayScheduleSchema,
  wednesday: dayScheduleSchema,
  thursday: dayScheduleSchema,
  friday: dayScheduleSchema,
  saturday: dayScheduleSchema,
  sunday: dayScheduleSchema,
})
export const operatingHoursSchema = weeklyScheduleSchema.optional()
```

Add and test `localDateStringSchema` using regex plus UTC round-trip; exception refinements require `endDate >= startDate`, `HOURS` times present and ordered, `OFF` times absent, maximum 30 exceptions. PUT body is `{ weekly: weeklyScheduleSchema.nullable(), exceptions: z.array(...).max(30) }` and ProductStaff body is `{ staffVenueIds: z.array(z.string().min(1)).max(100) }`.

- [ ] **Step 2: Run schema RED**

Run: `TZ=UTC npx jest tests/unit/schemas/dashboard/reservation.staff-config.schema.test.ts --runInBand`

Expected: FAIL until exports/refinements exist.

- [ ] **Step 3: Write staff-schedule service tests and record RED**

Pin tenant lookup `{ id: staffVenueId, venueId }`; GET returns `{ staffVenueId, weekly: null, exceptions: [] }` when no row. PUT validates parent before transaction; inside one transaction it upserts weekly or deletes it when `weekly:null`, deletes old exceptions, then creates all new exceptions using the parent's `venueId`. A failed `createMany` must roll the entire replacement back. Activity log is invoked after transaction settlement with `STAFF_SCHEDULE_UPDATED`.

- [ ] **Step 4: Implement staff-schedule service**

Use this boundary; never accept `venueId` from the body:

```typescript
export interface ReplaceStaffScheduleInput {
  weekly: OperatingHours | null
  exceptions: Array<{
    startDate: string
    endDate: string
    kind: 'OFF' | 'HOURS'
    startTime?: string
    endTime?: string
    note?: string
  }>
}
```

First load `staffVenue.findFirst({ where: { id: staffVenueId, venueId }, include: { staff: { select: { active: true } } } })`; foreign parents are `BadRequestError`. Do all replacement writes in one `$transaction`; `void logAction(...)` only after success.

- [ ] **Step 5: Write ProductStaff service tests and record RED**

Pin product lookup `{ id: productId, venueId, type:'APPOINTMENTS_SERVICE' }`, stable dedupe of IDs, full prevalidation before any delete, local+active membership and active `Staff`, mixed own/foreign array causing zero writes, `[]` deleting all mappings, and GET returning `{ productId, staffVenueIds, staff, explicit: rows.length > 0 }`. Assert each `staff` row contains the matching `StaffVenue.id` and `Staff.id` and nothing private.

- [ ] **Step 6: Implement ProductStaff service**

```typescript
export interface ProductStaffResult {
  productId: string
  staffVenueIds: string[]
  staff: Array<{ staffVenueId: string; staffId: string }>
  explicit: boolean
}
```

Validate `members.length === uniqueIds.length` with `where: { id:{in:uniqueIds}, venueId, active:true, staff:{active:true} }`; select only `{ id, staffId }`. Only then enter a transaction that deletes current rows and `createMany`s `{ productId, staffVenueId, venueId }`. Build `staff` from those selected fields in request order and log `SERVICE_STAFF_UPDATED` after commit.

- [ ] **Step 7: Add thin handlers and correctly ordered routes**

Controllers extract `venueId` and `userId` from `authContext`, call the service, and return 200. Insert these before any `/:id` route:

```typescript
router.get('/staff/:staffVenueId/schedule', checkPermission('teams:read'), controller.getStaffSchedule)
router.put('/staff/:staffVenueId/schedule', checkPermission('teams:update'), validateRequest(...), controller.replaceStaffSchedule)
router.get('/products/:productId/staff', checkPermission('menu:read'), controller.getProductStaff)
router.put('/products/:productId/staff', checkPermission('menu:update'), validateRequest(...), controller.replaceProductStaff)
```

Reuse the parent reservation router's auth and `RESERVATIONS` Feature middleware; do not add feature or module middleware here.

- [ ] **Step 8: Add real-PostgreSQL tenant/atomicity integration tests**

Create two organizations and at least two venues. Cover foreign `staffVenueId`, foreign product, mixed arrays, inactive membership, inactive staff, exception replacement rollback, and successful empty mapping. Inspect database rows after every rejection to assert zero writes and unchanged prior state.

- [ ] **Step 9: Run GREEN and permission audit**

```bash
TZ=UTC npx jest tests/unit/schemas/dashboard/reservation.staff-config.schema.test.ts tests/unit/services/dashboard/staffSchedule.service.test.ts tests/unit/services/dashboard/productStaff.service.test.ts --runInBand
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' npx jest --selectProjects=integration --runTestsByPath tests/integration/reservations/staff-management.test.ts --runInBand
npm run audit:permissions
npm run typecheck
```

Expected: PASS and permission audit exit 0 with no new permission.

- [ ] **Step 10: Commit**

```bash
git add src/schemas/dashboard/reservation.schema.ts src/services/dashboard/staffSchedule.service.ts src/services/dashboard/productStaff.service.ts src/controllers/dashboard/reservation.dashboard.controller.ts src/routes/dashboard/reservation.routes.ts tests/unit tests/integration/reservations/staff-management.test.ts
git commit -m "feat(reservations): manage staff schedules and service mappings"
```

---

### Task 5: Staff-aware schedule, personal-conflict, allocation, availability, ClassSession, and hard-delete engine

**Files:**
- Create: `src/services/dashboard/appointmentStaffAssignment.service.ts`
- Create: `tests/unit/services/dashboard/appointmentStaffAssignment.service.test.ts`
- Modify: `src/services/dashboard/reservationAvailability.service.ts`
- Modify: `tests/unit/services/dashboard/reservationAvailability.service.test.ts`
- Modify: `src/schemas/dashboard/reservation.schema.ts`
- Modify: public/dashboard availability controllers
- Modify: `src/services/dashboard/classSession.dashboard.service.ts`
- Modify: `tests/unit/services/dashboard/classSession.dashboard.service.test.ts`
- Modify: `src/services/dashboard/team.dashboard.service.ts`
- Modify: `tests/unit/services/dashboard/team.dashboard.service.test.ts`
- Create: `tests/integration/reservations/staff-concurrency.test.ts`

**Interfaces:**
- Produces: `isLiveSlotHold(hold, checkedAt)` shared by availability, allocation, capacity, hard-delete, and later hold consumption.
- Produces: `lockAppointmentVenue(tx, venueId)`, `assertOrganizationStaffAvailability(tx, args)`, `assertStaffEligible(tx, args)`, `resolveStaffAssignment(tx, args)`.
- Produces: staff-aware availability with `includeFull`, fixed reschedule duration, ProductStaff/schedule filters, and organization-scoped personal busy checks.

- [ ] **Step 1: Write schedule precedence and live-hold unit tests first**

Pin:

```typescript
expect(isLiveSlotHold({ expiresAt: future, heldForReservationId: null }, checkedAt)).toBe(true)
expect(isLiveSlotHold({ expiresAt: future, heldForReservationId: 'r1', heldForReservation: { status: 'CONFIRMED' } }, checkedAt)).toBe(true)
expect(isLiveSlotHold({ expiresAt: future, heldForReservationId: 'r1', heldForReservation: { status: 'CANCELLED' } }, checkedAt)).toBe(false)
expect(isLiveSlotHold({ expiresAt: past, heldForReservationId: null }, checkedAt)).toBe(false)
```

For schedule evaluation: applicable `OFF` closes; otherwise applicable `HOURS` ranges are unioned; otherwise staff weekly applies; when no weekly row, venue `operatingHours` applies. Test inside/outside/crossing-close and exceptions without weekly in a non-UTC venue.

- [ ] **Step 2: Run RED, then implement pure schedule/live-hold helpers**

Run: `TZ=UTC npx jest tests/unit/services/dashboard/appointmentStaffAssignment.service.test.ts --runInBand`

Use `fromZonedTime` and local `yyyy-MM-dd` strings; a final window must fit wholly in one normalized union interval. Do not read process timezone.

- [ ] **Step 3: Add failing eligibility and conflict tests**

Test active `StaffVenue` plus active `Staff`; exact appointment products; intersection across every booked product; explicit empty ProductStaff in opt-in means no candidates; cross-venue Reservation/ClassSession/live-hold conflict within the same organization; no lookup outside the organization; personal `ExternalBusyBlock` retains its existing platform-wide query. Assert conflict errors do not contain remote venue/customer identifiers.

- [ ] **Step 4: Implement lock, eligibility, and organization-wide conflict interfaces**

```typescript
export async function lockAppointmentVenue(tx: Prisma.TransactionClient, venueId: string): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '1500ms'`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'apt-hold:' + venueId}))`
}

export interface OrganizationStaffAvailabilityArgs {
  organizationId: string
  staffId: string
  startsAt: Date
  endsAt: Date
  checkedAt: Date
  excludeReservationId?: string
  excludeHoldId?: string
  excludeClassSessionId?: string
}
```

Derive allowed venue IDs by joining `StaffVenue.staffId` to `Venue.organizationId`, including inactive membership rows so soft-deleted scope remains visible. Query only existence for active Reservations, live holds with parent status, and `ClassSession.status='SCHEDULED'`. Invoke existing personal-busy-block logic without narrowing its platform-wide semantics.

- [ ] **Step 5: Add failing deterministic-allocation tests, then implement**

`resolveStaffAssignment` validates an explicit request or finds candidates. Stable sort is: fewest venue-local active reservations on the venue-local day, then `StaffVenue.startDate`, then `StaffVenue.id`. `shouldAutoAssign` is true only for appointment services when `capacityMode==='per_staff' || showStaffPicker`. Return `Staff.id`, never `StaffVenue.id`.

- [ ] **Step 6: Add failing availability/capacity tests**

Pin legacy 14/27-style assertions unchanged when settings are defaults. In staff-aware settings, legacy availability for a 60-minute canonical product with advisory/raw duration 5 must dimension/reject using the canonical 60-minute floor; it may not expose a five-minute slot. New tests also cover active Staff filtering, ProductStaff intersection, venue-hours fallback, live holds, scheduled classes, cross-venue conflict, and `includeFull`: only pacing failure emits `{ available:false, reason:'FULL' }`; pacing plus a hard staff conflict omits the slot. Occupancy excludes pure table/event reservations by joining `Product.type='APPOINTMENTS_SERVICE'` and retains conservative overlap counting.

- [ ] **Step 7: Implement availability branching and schemas**

Add query fields `productIds`, `includeFull`, `windowSemantics`; use the shared normalizer. Preserve existing `duration` as advisory and use `max(canonicalBaseDurationMin, duration ?? canonicalBaseDurationMin)` capped at 1,440 for new protocol. Add an internal-only `fixedDurationMin` option for reschedule, never accepted directly from public query. Evaluate every hard constraint before the global pacing branch that may emit `FULL`.

- [ ] **Step 8: Migrate ClassSession writers under TDD**

Create/bulk/update use `withSerializableRetry`. On every update retry, lock/re-read `{ id, venueId }` with `FOR UPDATE`, revalidate status/capacity/membership, derive effective start/end/duration/update payload inside the closure, and run `assertOrganizationStaffAvailability` only if interval/staff changes. Bulk rejects internal overlaps before writes. Metadata-only capacity/notes updates do not revalidate a preexisting personal conflict.

- [ ] **Step 9: Harden `hardDeleteTeamMember` under TDD**

Inside `withSerializableRetry`, row-lock/re-read `{ id: teamMemberId, venueId }`, capture `checkedAt`, and reject when same-venue active Reservation, scheduled future ClassSession, or live future hold exists for its `staffId`; only then delete. Add create-vs-delete integration coverage to prove SSI yields either a valid commitment with membership or a successful delete with no commitment, never an orphan.

- [ ] **Step 10: Add real-PostgreSQL concurrency matrix**

Cover same/cross-venue same-organization appointment↔appointment, appointment↔legacy nonappointment, appointment↔hold, appointment↔ClassSession, ClassSession bulk/internal overlap, two partial ClassSession updates, other-organization isolation, and hard-delete-vs-create. Start transactions concurrently with a barrier; assert exactly one conflicting writer commits and the retry closure re-reads all effective state.

- [ ] **Step 11: Run GREEN and full foundation regression**

```bash
TZ=UTC npx jest tests/unit/services/dashboard/appointmentStaffAssignment.service.test.ts tests/unit/services/dashboard/reservationAvailability.service.test.ts tests/unit/services/dashboard/classSession.dashboard.service.test.ts tests/unit/services/dashboard/team.dashboard.service.test.ts --runInBand
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' npx jest --selectProjects=integration --runTestsByPath tests/integration/reservations/staff-concurrency.test.ts --runInBand
npm run test:unit
npm run typecheck
npm run audit:permissions
```

Expected: all pass; no existing legacy assertion is weakened or deleted.

- [ ] **Step 12: Commit**

```bash
git add src/services/dashboard/appointmentStaffAssignment.service.ts src/services/dashboard/reservationAvailability.service.ts src/services/dashboard/classSession.dashboard.service.ts src/services/dashboard/team.dashboard.service.ts src/controllers src/schemas tests/unit tests/integration/reservations/staff-concurrency.test.ts
git commit -m "feat(reservations): add staff-aware scheduling engine"
```

---

## Foundation completion gate

Run from the isolated server worktree:

```bash
TZ=UTC npx jest tests/unit/services/dashboard/reservationAvailability.service.test.ts tests/unit/services/dashboard/reservation.dashboard.service.test.ts --runInBand
npm run test:unit
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' npx prisma migrate deploy
TEST_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' DATABASE_URL='postgresql://postgres:postgres@localhost:5432/avoqado_test' npm run test:integration
npm run audit:permissions
npm run schema:map -- --check
npm run typecheck
```

Do not activate `showStaffPicker` or `capacityMode='per_staff'` in any environment after this plan alone. Release readiness requires the follow-up booking/holds/settings/MCP plan, rollout-A/B preflights, all six client plans, and the v5.2 §15 gates.
