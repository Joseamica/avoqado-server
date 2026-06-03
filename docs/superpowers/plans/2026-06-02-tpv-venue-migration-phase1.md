# TPV Venue Migration (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SUPERADMIN dashboard wizard that safely migrates one physical TPV terminal from one venue to another — pre-flighting the
destination, re-parenting on the server, then wiping the device — with a gate that only completes once the device proves it wiped and
re-bound to the new venue.

**Architecture:** Server adds one `Terminal.lastActivationStatusCheckAt` field (the unforgeable "I woke up blank" signal, since
FACTORY_RESET kills the device before it can ACK) and three SUPERADMIN endpoints (`migrate-preflight`, `migrate-execute`, `migrate-status`)
orchestrating existing services (`updateTerminal` for the re-parent, `queueCommand` for the wipe). Order is forced server-side: re-parent →
queue FACTORY_RESET; the wipe auto-restores venue from the server on reboot, so re-parenting first makes the device re-bind to the NEW venue
with zero operator action. The dashboard adds a `MigrateTerminalWizard` (destination → pre-flight → confirm → poll) on the Superadmin
Terminals page.

**Tech Stack:** Express + TypeScript, Prisma/PostgreSQL, Jest (server); React 18 + Vite, TanStack Query, shadcn/ui (dashboard).

**Two repos:**

- Server: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server` (branch `develop`)
- Dashboard: `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`

**Design spec:** `avoqado-server/docs/plans/2026-06-02-tpv-venue-migration-design.md`

**Phase 2 (NOT in this plan — needs avoqado-tpv APK deploy):** hard drain gate on unsynced device queues, pre-wipe ACK, and the two wipe
defects (saved-carts file + queue flush).

**Repo rules to honor (from `avoqado-server/.claude/rules/`):**

- **Git:** NEVER `git add`/`commit`/`push` without asking the user first (`testing-and-git.md`). The `git commit` blocks below are the
  intended commit boundaries — confirm with the user before running each (or batch-confirm).
- **Co-Authored-By:** only the allowed Claude identity; never `claude-flow`/`ruv`.
- **Schema map:** this plan adds a _field_, not a model — no `MODEL_TO_DOMAIN` / `npm run schema:map` needed (that rule is for new/renamed
  `model`).
- **Feature gating:** this is an **internal SUPERADMIN ops tool — free, not a paid Feature/Module**, so the feature-gating questionnaire is
  skipped per the "interno de superadmin" exception.
- **Migrations:** `prisma migrate dev` only — NEVER `db push`. Never hand-edit an applied migration SQL.
- After any code edit: `npm run format && npm run lint:fix`. Before pushing: `npm run pre-deploy` must pass.

---

## File Structure

**Server (`avoqado-server`):**

- `prisma/schema.prisma` — add `lastActivationStatusCheckAt DateTime?` to `Terminal` (~line 3153).
- `prisma/migrations/<ts>_terminal_last_activation_status_check_at/` — generated migration.
- `src/services/dashboard/terminal-activation.service.ts` — stamp the field in `checkTerminalActivationStatus`.
- `src/services/dashboard/terminal-migration.service.ts` — **NEW.** `migratePreflight`, `migrateExecute`, `migrateStatus`. Orchestrator
  only; delegates to `updateTerminal` + `tpvCommandQueueService`.
- `src/controllers/dashboard/terminal-migration.controller.ts` — **NEW.** 3 thin controllers.
- `src/routes/superadmin/terminal.routes.ts` — register 3 routes + Zod schemas.
- `tests/unit/services/dashboard/terminal-migration.*.test.ts` — **NEW** unit tests.

**Dashboard (`avoqado-web-dashboard`):**

- `src/services/superadmin-terminals.service.ts` — add `migratePreflight`, `migrateExecute`, `migrateStatus` + types; append to
  `terminalAPI`.
- `src/pages/Superadmin/components/MigrateTerminalWizard.tsx` — **NEW** wizard.
- `src/pages/Superadmin/Terminals.tsx` — new "Migrar a otro venue" row action + mount wizard.

---

# PART A — Server (`avoqado-server`)

> Run all server commands from `/Users/amieva/Documents/Programming/Avoqado/avoqado-server`. After any code edit:
> `npm run format && npm run lint:fix`. Run a single test with `npm test -- <path>`.

### Task 1: Add `lastActivationStatusCheckAt` and stamp it on activation-status reads

**Files:**

- Modify: `prisma/schema.prisma` (Terminal model, ~line 3153)
- Modify: `src/services/dashboard/terminal-activation.service.ts:215-248`
- Test: `tests/unit/services/dashboard/terminal-activation.stamp.test.ts` (create)

- [ ] **Step 1: Add the field to the Terminal model**

In `prisma/schema.prisma`, inside `model Terminal { ... }`, alongside the activation block (after `lastActivationAttempt DateTime?`):

```prisma
  lastActivationAttempt DateTime?
  lastActivationStatusCheckAt DateTime?  // stamped when a (possibly just-wiped) device polls activation-status; proof-of-wipe signal for venue migration
```

- [ ] **Step 2: Generate the migration**

Run: `npm run migrate -- --name terminal_last_activation_status_check_at` (`npm run migrate` = `prisma migrate dev`.) Expected: a new folder
under `prisma/migrations/` adding the nullable column; `prisma generate` runs automatically. NEVER hand-edit an applied migration SQL
afterward.

- [ ] **Step 3: Write the failing test**

Create `tests/unit/services/dashboard/terminal-activation.stamp.test.ts`:

```typescript
import prisma from '@/utils/prismaClient'
import { checkTerminalActivationStatus } from '@/services/dashboard/terminal-activation.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findFirst: jest.fn(), update: jest.fn() },
  },
}))

const mockedPrisma = prisma as unknown as {
  terminal: { findFirst: jest.Mock; update: jest.Mock }
}

describe('checkTerminalActivationStatus — stamps lastActivationStatusCheckAt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.terminal.update.mockResolvedValue({})
  })

  it('updates lastActivationStatusCheckAt for the resolved terminal', async () => {
    mockedPrisma.terminal.findFirst.mockResolvedValue({
      id: 'term-1',
      serialNumber: 'AVQD-123',
      status: 'ACTIVE',
      activatedAt: new Date('2026-01-01T00:00:00Z'),
      venueId: 'venue-new',
      venue: { id: 'venue-new', name: 'New', slug: 'new' },
    })

    await checkTerminalActivationStatus('AVQD-123')

    expect(mockedPrisma.terminal.update).toHaveBeenCalledWith({
      where: { id: 'term-1' },
      data: { lastActivationStatusCheckAt: expect.any(Date) },
    })
  })

  it('does NOT stamp when the terminal is not found', async () => {
    mockedPrisma.terminal.findFirst.mockResolvedValue(null)
    await expect(checkTerminalActivationStatus('AVQD-missing')).rejects.toThrow()
    expect(mockedPrisma.terminal.update).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run it, verify it fails**

Run: `npm test -- tests/unit/services/dashboard/terminal-activation.stamp.test.ts` Expected: FAIL (the first test sees `terminal.update`
never called).

- [ ] **Step 5: Implement the stamp**

In `src/services/dashboard/terminal-activation.service.ts`, immediately after the not-found guard (the
`if (!terminal) { ... throw new NotFoundError(...) }` block ending ~line 246), insert a fire-and-forget stamp (do not block the device
response on it):

```typescript
// Proof-of-wipe signal for venue migration: a (possibly just-wiped) device
// polls this endpoint on boot. Record the timestamp; never block the response on it.
void prisma.terminal
  .update({ where: { id: terminal.id }, data: { lastActivationStatusCheckAt: new Date() } })
  .catch(err => logger.warn(`Failed to stamp lastActivationStatusCheckAt for ${terminal.id}: ${err}`))
```

(`logger` is already imported in this file. The test mocks `update` to resolve, so the `void`/`.catch` is fine.)

- [ ] **Step 6: Run the test, verify it passes**

Run: `npm test -- tests/unit/services/dashboard/terminal-activation.stamp.test.ts` Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/dashboard/terminal-activation.service.ts tests/unit/services/dashboard/terminal-activation.stamp.test.ts
git commit -m "feat(tpv): add Terminal.lastActivationStatusCheckAt + stamp on activation-status (migration proof-of-wipe signal)"
```

---

### Task 2: `migratePreflight` — destination readiness checks

**Files:**

- Create: `src/services/dashboard/terminal-migration.service.ts`
- Test: `tests/unit/services/dashboard/terminal-migration.preflight.test.ts`

- [ ] **Step 1: Confirm destination-model field names**

Before writing the predicates, grep the two destination models so the checks use real fields:

```bash
grep -n "model VenuePaymentConfig" -A 40 prisma/schema.prisma
grep -n "model StaffVenue" -A 40 prisma/schema.prisma
```

Note the "active/enabled" field on `VenuePaymentConfig` and the `pin` + active/status field on `StaffVenue`. Use those exact names below
(the code uses `isActive` / `active` as placeholders — replace with what you find).

- [ ] **Step 2: Write the failing test**

Create `tests/unit/services/dashboard/terminal-migration.preflight.test.ts`:

```typescript
import prisma from '@/utils/prismaClient'
import { migratePreflight } from '@/services/dashboard/terminal-migration.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    venuePaymentConfig: { findFirst: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    tpvCommandQueue: { findFirst: jest.fn() },
  },
}))

const m = prisma as unknown as {
  terminal: { findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  venuePaymentConfig: { findFirst: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  tpvCommandQueue: { findFirst: jest.Mock }
}

const healthy = () => {
  m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-old', status: 'ACTIVE', brand: 'PAX' })
  m.venue.findUnique.mockResolvedValue({ id: 'venue-new', name: 'New' })
  m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1' })
  m.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  m.tpvCommandQueue.findFirst.mockResolvedValue(null)
}

describe('migratePreflight', () => {
  beforeEach(() => jest.clearAllMocks())

  it('canProceed=true with no blockers when destination is ready', async () => {
    healthy()
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.canProceed).toBe(true)
    expect(r.blockers).toHaveLength(0)
  })

  it('blocks when destination has no payment config', async () => {
    healthy()
    m.venuePaymentConfig.findFirst.mockResolvedValue(null)
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.canProceed).toBe(false)
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'NO_PAYMENT_CONFIG' }))
  })

  it('blocks when destination has no staff with a PIN', async () => {
    healthy()
    m.staffVenue.findFirst.mockResolvedValue(null)
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.canProceed).toBe(false)
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'NO_STAFF_PIN' }))
  })

  it('blocks when terminal is RETIRED', async () => {
    healthy()
    m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-old', status: 'RETIRED', brand: 'PAX' })
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'TERMINAL_RETIRED' }))
  })

  it('blocks when a migration is already in progress', async () => {
    healthy()
    m.tpvCommandQueue.findFirst.mockResolvedValue({ id: 'cmd-x' })
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'MIGRATION_IN_PROGRESS' }))
  })

  it('blocks when source and destination venue are the same', async () => {
    healthy()
    m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', status: 'ACTIVE', brand: 'PAX' })
    const r = await migratePreflight('term-1', 'venue-new')
    expect(r.blockers).toContainEqual(expect.objectContaining({ code: 'SAME_VENUE' }))
  })
})
```

- [ ] **Step 3: Run it, verify it fails**

Run: `npm test -- tests/unit/services/dashboard/terminal-migration.preflight.test.ts` Expected: FAIL ("migratePreflight is not a function" /
module not found).

- [ ] **Step 4: Implement `migratePreflight`**

Create `src/services/dashboard/terminal-migration.service.ts`:

```typescript
import prisma from '@/utils/prismaClient'
import { NotFoundError } from '@/errors/AppError'

export interface MigrationBlocker {
  code: 'TERMINAL_RETIRED' | 'SAME_VENUE' | 'NO_PAYMENT_CONFIG' | 'NO_STAFF_PIN' | 'MIGRATION_IN_PROGRESS'
  message: string
}

export interface MigrationWarning {
  code: 'UNSYNCED_DATA' | 'OPEN_SHIFT'
  message: string
}

export interface PreflightResult {
  canProceed: boolean
  fromVenueId: string
  toVenueId: string
  blockers: MigrationBlocker[]
  warnings: MigrationWarning[]
}

export async function migratePreflight(terminalId: string, toVenueId: string): Promise<PreflightResult> {
  const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } })
  if (!terminal) throw new NotFoundError('Terminal not found')

  const blockers: MigrationBlocker[] = []
  const warnings: MigrationWarning[] = []

  if (terminal.status === 'RETIRED') {
    blockers.push({ code: 'TERMINAL_RETIRED', message: 'La terminal está retirada y no puede migrarse.' })
  }
  if (terminal.venueId === toVenueId) {
    blockers.push({ code: 'SAME_VENUE', message: 'La terminal ya pertenece a ese venue.' })
  }

  const targetVenue = await prisma.venue.findUnique({ where: { id: toVenueId } })
  if (!targetVenue) throw new NotFoundError('Target venue not found')

  // Hard blocker: destination must be able to take card payments.
  const paymentConfig = await prisma.venuePaymentConfig.findFirst({
    where: { venueId: toVenueId /*, isActive: true — use the real active field from Step 1 */ },
  })
  if (!paymentConfig) {
    blockers.push({
      code: 'NO_PAYMENT_CONFIG',
      message: 'El venue destino no tiene configuración de pagos (merchant). La TPV no podría cobrar.',
    })
  }

  // Hard blocker: destination must have at least one staff PIN, or nobody can log in.
  const staffPin = await prisma.staffVenue.findFirst({
    where: { venueId: toVenueId, pin: { not: null } /*, active: true — use the real field from Step 1 */ },
  })
  if (!staffPin) {
    blockers.push({ code: 'NO_STAFF_PIN', message: 'El venue destino no tiene staff con PIN. Nadie podría iniciar sesión en la TPV.' })
  }

  // Idempotency: refuse if a FACTORY_RESET is already queued/pending for this terminal.
  const inFlight = await prisma.tpvCommandQueue.findFirst({
    where: { terminalId, commandType: 'FACTORY_RESET', status: { in: ['PENDING', 'QUEUED', 'SENT', 'RECEIVED', 'EXECUTING'] } },
  })
  if (inFlight) {
    blockers.push({ code: 'MIGRATION_IN_PROGRESS', message: 'Ya hay una migración (factory reset) en curso para esta terminal.' })
  }

  // Soft warning (Phase 1): unsynced device data cannot be verified server-side yet.
  warnings.push({
    code: 'UNSYNCED_DATA',
    message: 'Confirma que la TPV terminó de sincronizar sus ventas antes de continuar (Fase 2 lo verificará automáticamente).',
  })

  return {
    canProceed: blockers.length === 0,
    fromVenueId: terminal.venueId,
    toVenueId,
    blockers,
    warnings,
  }
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- tests/unit/services/dashboard/terminal-migration.preflight.test.ts` Expected: PASS (6 tests). Then
`npm run format && npm run lint:fix`.

- [ ] **Step 6: Commit**

```bash
git add src/services/dashboard/terminal-migration.service.ts tests/unit/services/dashboard/terminal-migration.preflight.test.ts
git commit -m "feat(tpv): migratePreflight — destination readiness checks (payment config, staff PIN, retired, in-flight)"
```

---

### Task 3: `migrateExecute` — re-parent then queue FACTORY_RESET (forced order)

**Files:**

- Modify: `src/services/dashboard/terminal-migration.service.ts`
- Test: `tests/unit/services/dashboard/terminal-migration.execute.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/dashboard/terminal-migration.execute.test.ts`:

```typescript
import { migrateExecute } from '@/services/dashboard/terminal-migration.service'
import prisma from '@/utils/prismaClient'
import * as terminalsService from '@/services/dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'

// Mock the Prisma layer so the REAL migratePreflight (called inside migrateExecute) runs.
// Do NOT self-mock the migration module — Jest can't intercept intra-module calls, so
// migrateExecute's internal migratePreflight() would still hit the real one regardless.
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    venuePaymentConfig: { findFirst: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    tpvCommandQueue: { findFirst: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/terminals.superadmin.service')
jest.mock('@/services/tpv/command-queue.service', () => ({
  tpvCommandQueueService: { queueCommand: jest.fn() },
}))

const m = prisma as unknown as {
  terminal: { findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  venuePaymentConfig: { findFirst: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  tpvCommandQueue: { findFirst: jest.Mock }
}
const mockedUpdate = terminalsService.updateTerminal as jest.Mock
const mockedQueue = tpvCommandQueueService.queueCommand as jest.Mock

const healthyPreflight = () => {
  m.terminal.findUnique.mockResolvedValue({ id: 'term-1', venueId: 'venue-old', status: 'ACTIVE', brand: 'PAX' })
  m.venue.findUnique.mockResolvedValue({ id: 'venue-new', name: 'New' })
  m.venuePaymentConfig.findFirst.mockResolvedValue({ id: 'vpc-1' })
  m.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  m.tpvCommandQueue.findFirst.mockResolvedValue(null)
}

describe('migrateExecute', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    healthyPreflight()
    mockedUpdate.mockResolvedValue({ id: 'term-1', venueId: 'venue-new', name: 'T1' })
    mockedQueue.mockResolvedValue({
      commandId: 'cmd-1',
      correlationId: 'corr-1',
      status: 'QUEUED',
      queued: true,
      terminalOnline: true,
      message: 'ok',
    })
  })

  it('re-parents BEFORE queueing the wipe, and queues FACTORY_RESET against the NEW venue', async () => {
    const order: string[] = []
    mockedUpdate.mockImplementation(async () => {
      order.push('reparent')
      return { id: 'term-1', venueId: 'venue-new' }
    })
    mockedQueue.mockImplementation(async () => {
      order.push('wipe')
      return { commandId: 'cmd-1', status: 'QUEUED' }
    })

    const r = await migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })

    expect(order).toEqual(['reparent', 'wipe'])
    expect(mockedUpdate).toHaveBeenCalledWith('term-1', { venueId: 'venue-new' }, expect.objectContaining({ staffId: 'admin-1' }))
    expect(mockedQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: 'term-1',
        venueId: 'venue-new',
        commandType: 'FACTORY_RESET',
        priority: 'CRITICAL',
      }),
    )
    expect(r).toEqual(expect.objectContaining({ commandId: 'cmd-1', fromVenueId: 'venue-old', toVenueId: 'venue-new' }))
  })

  it('throws and does NOT wipe when the destination is not ready (blocker)', async () => {
    m.staffVenue.findFirst.mockResolvedValue(null) // → NO_STAFF_PIN blocker
    await expect(migrateExecute('term-1', 'venue-new', { staffId: 'admin-1' })).rejects.toThrow()
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedQueue).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- tests/unit/services/dashboard/terminal-migration.execute.test.ts` Expected: FAIL ("migrateExecute is not a function").

- [ ] **Step 3: Implement `migrateExecute`**

Append to `src/services/dashboard/terminal-migration.service.ts`:

```typescript
import { updateTerminal, type TerminalActor } from '@/services/dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { BadRequestError } from '@/errors/AppError'

export interface MigrateExecuteResult {
  commandId: string
  fromVenueId: string
  toVenueId: string
  startedAt: Date
}

export async function migrateExecute(
  terminalId: string,
  toVenueId: string,
  actor: TerminalActor & { staffName?: string },
): Promise<MigrateExecuteResult> {
  // Re-validate at execute time — state may have changed since preflight.
  const pre = await migratePreflight(terminalId, toVenueId)
  if (!pre.canProceed) {
    throw new BadRequestError(`Migration blocked: ${pre.blockers.map(b => b.code).join(', ')}`)
  }

  // 1) Re-parent FIRST. updateTerminal validates the target venue exists and
  //    clears assignedMerchantIds (cross-tenant safety) on venue change.
  await updateTerminal(terminalId, { venueId: toVenueId }, actor)

  // 2) Queue the wipe AGAINST THE NEW VENUE. queueCommand asserts
  //    terminal.venueId === venueId, which now holds after the re-parent.
  //    Delivery is via the device's next heartbeat (post-reparent the socket
  //    room no longer matches), which is exactly our model.
  const queued = await tpvCommandQueueService.queueCommand({
    terminalId,
    venueId: toVenueId,
    commandType: 'FACTORY_RESET',
    priority: 'CRITICAL',
    requestedBy: actor.staffId ?? 'system',
    requestedByName: actor.staffName,
    source: 'DASHBOARD',
  })

  return { commandId: queued.commandId, fromVenueId: pre.fromVenueId, toVenueId, startedAt: new Date() }
}
```

> If `TerminalActor` is not exported, export it from `terminals.superadmin.service.ts` (it is declared there at `:16-20`). If
> `BadRequestError`/`NotFoundError` live elsewhere, match the import used by `command-queue.service.ts` / `terminals.superadmin.service.ts`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- tests/unit/services/dashboard/terminal-migration.execute.test.ts` Expected: PASS (2 tests). Then
`npm run format && npm run lint:fix`.

- [ ] **Step 5: Commit**

```bash
git add src/services/dashboard/terminal-migration.service.ts tests/unit/services/dashboard/terminal-migration.execute.test.ts
git commit -m "feat(tpv): migrateExecute — forced re-parent then FACTORY_RESET against new venue"
```

---

### Task 4: `migrateStatus` — derive proof-of-wipe

**Files:**

- Modify: `src/services/dashboard/terminal-migration.service.ts`
- Test: `tests/unit/services/dashboard/terminal-migration.status.test.ts`

The signal: `reboundAfterWipe` = the terminal's `lastActivationStatusCheckAt` is later than the FACTORY_RESET command's `createdAt` (a
non-wiped device NEVER calls activation-status). `onlineUnderNewVenue` = heartbeat fresh AND the terminal now sits on the command's venue.
`confirmed` = both.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/dashboard/terminal-migration.status.test.ts`:

```typescript
import prisma from '@/utils/prismaClient'
import { migrateStatus } from '@/services/dashboard/terminal-migration.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    tpvCommandQueue: { findUnique: jest.fn() },
    terminal: { findUnique: jest.fn() },
  },
}))

const m = prisma as unknown as {
  tpvCommandQueue: { findUnique: jest.Mock }
  terminal: { findUnique: jest.Mock }
}

const T0 = new Date('2026-06-02T18:00:00Z')

describe('migrateStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    m.tpvCommandQueue.findUnique.mockResolvedValue({
      id: 'cmd-1',
      terminalId: 'term-1',
      venueId: 'venue-new',
      status: 'SENT',
      createdAt: T0,
    })
  })

  it('confirmed=true once device re-bound after wipe AND is online under the new venue', async () => {
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-new',
      lastActivationStatusCheckAt: new Date(T0.getTime() + 60_000), // after T0
      lastHeartbeat: new Date(), // fresh → online
    })
    const r = await migrateStatus('term-1', 'cmd-1')
    expect(r.reboundAfterWipe).toBe(true)
    expect(r.onlineUnderNewVenue).toBe(true)
    expect(r.confirmed).toBe(true)
  })

  it('confirmed=false when activation check predates the wipe command', async () => {
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-new',
      lastActivationStatusCheckAt: new Date(T0.getTime() - 60_000), // before T0 (stale)
      lastHeartbeat: new Date(),
    })
    const r = await migrateStatus('term-1', 'cmd-1')
    expect(r.reboundAfterWipe).toBe(false)
    expect(r.confirmed).toBe(false)
  })

  it('confirmed=false when device rebound but is still offline', async () => {
    m.terminal.findUnique.mockResolvedValue({
      id: 'term-1',
      venueId: 'venue-new',
      lastActivationStatusCheckAt: new Date(T0.getTime() + 60_000),
      lastHeartbeat: new Date(Date.now() - 10 * 60_000), // 10 min ago → offline
    })
    const r = await migrateStatus('term-1', 'cmd-1')
    expect(r.reboundAfterWipe).toBe(true)
    expect(r.onlineUnderNewVenue).toBe(false)
    expect(r.confirmed).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- tests/unit/services/dashboard/terminal-migration.status.test.ts` Expected: FAIL ("migrateStatus is not a function").

- [ ] **Step 3: Implement `migrateStatus`**

Append to `src/services/dashboard/terminal-migration.service.ts`:

```typescript
const ONLINE_THRESHOLD_MS = 2 * 60 * 1000 // mirror tpv-health/command-execution online cutoff

export interface MigrateStatusResult {
  commandStatus: string
  commandDelivered: boolean
  reboundAfterWipe: boolean
  currentlyOnline: boolean
  onlineUnderNewVenue: boolean
  confirmed: boolean
  elapsedMs: number
}

export async function migrateStatus(terminalId: string, commandId: string): Promise<MigrateStatusResult> {
  const command = await prisma.tpvCommandQueue.findUnique({ where: { id: commandId } })
  if (!command || command.terminalId !== terminalId) throw new NotFoundError('Migration command not found for terminal')

  const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } })
  if (!terminal) throw new NotFoundError('Terminal not found')

  const t0 = command.createdAt
  const now = Date.now()

  const commandDelivered = ['SENT', 'RECEIVED', 'EXECUTING', 'COMPLETED'].includes(command.status)
  const reboundAfterWipe = !!terminal.lastActivationStatusCheckAt && terminal.lastActivationStatusCheckAt > t0
  const currentlyOnline = !!terminal.lastHeartbeat && now - terminal.lastHeartbeat.getTime() < ONLINE_THRESHOLD_MS
  const onlineUnderNewVenue = currentlyOnline && terminal.venueId === command.venueId
  const confirmed = reboundAfterWipe && onlineUnderNewVenue

  return {
    commandStatus: command.status,
    commandDelivered,
    reboundAfterWipe,
    currentlyOnline,
    onlineUnderNewVenue,
    confirmed,
    elapsedMs: now - t0.getTime(),
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- tests/unit/services/dashboard/terminal-migration.status.test.ts` Expected: PASS (3 tests). Then
`npm run format && npm run lint:fix`.

- [ ] **Step 5: Commit**

```bash
git add src/services/dashboard/terminal-migration.service.ts tests/unit/services/dashboard/terminal-migration.status.test.ts
git commit -m "feat(tpv): migrateStatus — proof-of-wipe (rebound-after-wipe + online-under-new-venue)"
```

---

### Task 5: Controllers + Zod schemas + routes (3 SUPERADMIN endpoints)

**Files:**

- Create: `src/controllers/dashboard/terminal-migration.controller.ts`
- Modify: `src/routes/superadmin/terminal.routes.ts`

> No new permission middleware: `src/routes/dashboard/superadmin.routes.ts:55-57` already applies `authenticateTokenMiddleware` +
> `checkPermission('system:manage')` (SUPERADMIN-only, and SUPERADMIN bypasses all `checkPermission`) to every
> `/dashboard/superadmin/terminals/*` route. Cross-venue migration is inherently SUPERADMIN, so this inherited gate is exactly right.

- [ ] **Step 1: Write the controllers**

Create `src/controllers/dashboard/terminal-migration.controller.ts` (mirror the existing `terminals.superadmin.controller.ts:109-147` shape
— read params/body, thread the actor from `authContext`, call the service, `res.status(200).json({ data, message })`):

```typescript
import { Request, Response, NextFunction } from 'express'
import { migratePreflight, migrateExecute, migrateStatus } from '@/services/dashboard/terminal-migration.service'

export const preflight = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params
    const { toVenueId } = req.body
    const data = await migratePreflight(terminalId, toVenueId)
    return res.status(200).json({ data, message: 'Preflight complete' })
  } catch (error) {
    next(error)
  }
}

export const execute = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params
    const { toVenueId } = req.body
    const authContext = (req as any).authContext
    // authContext exposes ONLY { userId, orgId, venueId, role } (critical-warnings.md) — no `name`.
    // requestedByName is optional; omit it (or look up the staff name inside the service if needed).
    const data = await migrateExecute(terminalId, toVenueId, {
      staffId: authContext?.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    return res.status(200).json({ data, message: 'Migration started' })
  } catch (error) {
    next(error)
  }
}

export const status = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params
    const { commandId } = req.query as { commandId: string }
    const data = await migrateStatus(terminalId, commandId)
    return res.status(200).json({ data, message: 'OK' })
  } catch (error) {
    next(error)
  }
}
```

- [ ] **Step 2: Register routes + Zod schemas**

In `src/routes/superadmin/terminal.routes.ts`, add the import and 3 routes (mirror the existing `validateRequest(schema)` +
`terminalController.xxx` pattern at `:99`):

```typescript
import * as migrationController from '../../controllers/dashboard/terminal-migration.controller'

// Zod messages MUST be Spanish (critical-warnings.md — validation middleware shows them raw to users).
const migratePreflightSchema = z.object({
  params: z.object({ terminalId: z.string().cuid('ID de terminal inválido') }),
  body: z.object({ toVenueId: z.string().cuid('Debes seleccionar un venue destino válido') }),
})
const migrateExecuteSchema = migratePreflightSchema
const migrateStatusSchema = z.object({
  params: z.object({ terminalId: z.string().cuid('ID de terminal inválido') }),
  query: z.object({ commandId: z.string().cuid('ID de comando inválido') }),
})

router.post('/:terminalId/migrate-preflight', validateRequest(migratePreflightSchema), migrationController.preflight)
router.post('/:terminalId/migrate-execute', validateRequest(migrateExecuteSchema), migrationController.execute)
router.get('/:terminalId/migrate-status', validateRequest(migrateStatusSchema), migrationController.status)
```

(If `validateRequest` doesn't validate `query`, match however other GET routes in this file validate query params — or validate `commandId`
inline in the controller.)

- [ ] **Step 3: Typecheck / build**

Run: `npm run build` Expected: compiles clean (Prisma client already regenerated in Task 1). Fix any type errors (e.g. export
`TerminalActor`).

- [ ] **Step 4: Smoke-test the endpoints (manual)**

Start the server (`npm run dev`) and, with a SUPERADMIN token, exercise preflight against a real terminal id + a destination venue id:

```bash
curl -s -X POST "http://localhost:<port>/api/v1/dashboard/superadmin/terminals/<TERMINAL_ID>/migrate-preflight" \
  -H "Authorization: Bearer <SUPERADMIN_JWT>" -H "Content-Type: application/json" \
  -d '{"toVenueId":"<DEST_VENUE_ID>"}' | jq
```

Expected: JSON `{ data: { canProceed, blockers, warnings, ... } }`. Do NOT call migrate-execute against a production terminal during
smoke-testing.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/dashboard/terminal-migration.controller.ts src/routes/superadmin/terminal.routes.ts
git commit -m "feat(tpv): SUPERADMIN routes for terminal venue-migration (preflight/execute/status)"
```

---

# PART B — Dashboard (`avoqado-web-dashboard`)

> Run all dashboard commands from `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`. Verify with `npm run build`
> (typecheck) — this repo's superadmin components are validated by build + manual QA, not component unit tests.

### Task 6: Service layer — 3 functions + types

**Files:**

- Modify: `src/services/superadmin-terminals.service.ts`

- [ ] **Step 1: Add types + functions, append to `terminalAPI`**

In `src/services/superadmin-terminals.service.ts` (mirror the existing inline-path style; `import api from '@/api'` is already at the top;
every call inlines `/api/v1/...` and returns `response.data.data`):

```typescript
export interface MigrationBlocker {
  code: string
  message: string
}
export interface MigrationWarning {
  code: string
  message: string
}
export interface PreflightResult {
  canProceed: boolean
  fromVenueId: string
  toVenueId: string
  blockers: MigrationBlocker[]
  warnings: MigrationWarning[]
}
export interface MigrateExecuteResult {
  commandId: string
  fromVenueId: string
  toVenueId: string
  startedAt: string
}
export interface MigrateStatusResult {
  commandStatus: string
  commandDelivered: boolean
  reboundAfterWipe: boolean
  currentlyOnline: boolean
  onlineUnderNewVenue: boolean
  confirmed: boolean
  elapsedMs: number
}

export async function migratePreflight(terminalId: string, toVenueId: string): Promise<PreflightResult> {
  const response = await api.post(`/api/v1/dashboard/superadmin/terminals/${terminalId}/migrate-preflight`, { toVenueId })
  return response.data.data
}

export async function migrateExecute(terminalId: string, toVenueId: string): Promise<MigrateExecuteResult> {
  const response = await api.post(`/api/v1/dashboard/superadmin/terminals/${terminalId}/migrate-execute`, { toVenueId })
  return response.data.data
}

export async function migrateStatus(terminalId: string, commandId: string): Promise<MigrateStatusResult> {
  const response = await api.get(`/api/v1/dashboard/superadmin/terminals/${terminalId}/migrate-status`, { params: { commandId } })
  return response.data.data
}
```

Then append the three to the `terminalAPI` aggregator (`superadmin-terminals.service.ts:243-253`):

```typescript
export const terminalAPI = {
  getAllTerminals,
  getTerminalById,
  createTerminal,
  updateTerminal,
  generateActivationCode,
  deleteTerminal,
  sendRemoteActivation,
  isTerminalOnline,
  getAppUpdates,
  migratePreflight,
  migrateExecute,
  migrateStatus,
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build` Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add src/services/superadmin-terminals.service.ts
git commit -m "feat(tpv): dashboard service for terminal venue-migration (preflight/execute/status)"
```

---

### Task 7: `MigrateTerminalWizard` component

**Files:**

- Create: `src/pages/Superadmin/components/MigrateTerminalWizard.tsx`

Model on `AttachTerminalDialog.tsx` (Dialog + nested AlertDialog + `useMutation` + `useToast`), but with a small `step` state machine:
`pickVenue → preflight → confirm → progress`. Destination selection uses `SearchCombobox` over `getAllVenues()`. The progress step polls
`migrateStatus` with `refetchInterval` until `confirmed`.

- [ ] **Step 1: Create the component**

Create `src/pages/Superadmin/components/MigrateTerminalWizard.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SearchCombobox, type SearchComboboxItem } from '@/components/search-combobox'
import { useToast } from '@/hooks/use-toast'
import { includesNormalized } from '@/lib/utils'
import { getAllVenues } from '@/services/superadmin.service'
import { terminalAPI, type Terminal, type PreflightResult } from '@/services/superadmin-terminals.service'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  terminal: Terminal | null
}

type Step = 'pickVenue' | 'preflight' | 'confirm' | 'progress'

export default function MigrateTerminalWizard({ open, onOpenChange, terminal }: Props) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const [step, setStep] = useState<Step>('pickVenue')
  const [search, setSearch] = useState('')
  const [toVenueId, setToVenueId] = useState('')
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [commandId, setCommandId] = useState<string | null>(null)

  const { data: venues = [] } = useQuery({ queryKey: ['venues'], queryFn: () => getAllVenues() })
  const venueItems = useMemo<SearchComboboxItem[]>(
    () =>
      venues
        .filter((v: any) => v.id !== terminal?.venueId && (!search || includesNormalized(v.name ?? '', search)))
        .map((v: any) => ({ id: v.id, label: v.name, description: v.slug })),
    [venues, search, terminal],
  )

  const reset = () => {
    setStep('pickVenue')
    setSearch('')
    setToVenueId('')
    setPreflight(null)
    setCommandId(null)
  }
  const close = () => {
    onOpenChange(false)
    setTimeout(reset, 200)
  }

  const preflightMutation = useMutation({
    mutationFn: () => terminalAPI.migratePreflight(terminal!.id, toVenueId),
    onSuccess: r => {
      setPreflight(r)
      setStep('preflight')
    },
    onError: (e: any) =>
      toast({ title: 'Error en pre-vuelo', description: e?.response?.data?.message || e?.message, variant: 'destructive' }),
  })

  const executeMutation = useMutation({
    mutationFn: () => terminalAPI.migrateExecute(terminal!.id, toVenueId),
    onSuccess: r => {
      setCommandId(r.commandId)
      setStep('progress')
      queryClient.invalidateQueries({ queryKey: ['terminals'] })
      queryClient.invalidateQueries({ queryKey: ['superadmin-terminals'] })
    },
    onError: (e: any) =>
      toast({ title: 'No se pudo iniciar la migración', description: e?.response?.data?.message || e?.message, variant: 'destructive' }),
  })

  const { data: migStatus } = useQuery({
    queryKey: ['migrate-status', terminal?.id, commandId],
    queryFn: () => terminalAPI.migrateStatus(terminal!.id, commandId!),
    enabled: step === 'progress' && !!terminal && !!commandId,
    refetchInterval: q => (q.state.data?.confirmed === true ? false : 2000),
  })

  return (
    <>
      <Dialog open={open} onOpenChange={v => (v ? onOpenChange(true) : close())}>
        <DialogContent className="sm:max-w-[560px] bg-background">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="w-5 h-5" /> Migrar TPV a otro venue
            </DialogTitle>
            <DialogDescription>
              {terminal?.name} ({terminal?.serialNumber}) — actualmente en <strong>{terminal?.venue?.name}</strong>.
            </DialogDescription>
          </DialogHeader>

          {step === 'pickVenue' && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Elige el venue destino:</p>
              <SearchCombobox
                placeholder="Buscar venue destino…"
                items={venueItems}
                value={search}
                onChange={setSearch}
                onSelect={item => setToVenueId(item.id)}
              />
              {toVenueId && (
                <p className="text-xs">
                  Destino seleccionado: <strong>{venues.find((v: any) => v.id === toVenueId)?.name}</strong>
                </p>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={close}>
                  Cancelar
                </Button>
                <Button disabled={!toVenueId || preflightMutation.isPending} onClick={() => preflightMutation.mutate()}>
                  {preflightMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Verificar destino
                </Button>
              </DialogFooter>
            </div>
          )}

          {step === 'preflight' && preflight && (
            <div className="space-y-3">
              {preflight.blockers.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-destructive flex items-center gap-1">
                    <AlertTriangle className="w-4 h-4" /> No se puede migrar:
                  </p>
                  <ul className="text-sm list-disc pl-5 space-y-1">
                    {preflight.blockers.map(b => (
                      <li key={b.code}>{b.message}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" /> El venue destino está listo.
                </p>
              )}
              {preflight.warnings.map(w => (
                <p key={w.code} className="text-xs text-amber-600 flex items-start gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5" /> {w.message}
                </p>
              ))}
              <DialogFooter>
                <Button variant="outline" onClick={() => setStep('pickVenue')}>
                  Atrás
                </Button>
                <Button disabled={!preflight.canProceed} onClick={() => setStep('confirm')}>
                  Continuar
                </Button>
              </DialogFooter>
            </div>
          )}

          {step === 'progress' && (
            <div className="space-y-3 py-2">
              <p className="text-sm text-amber-600 flex items-start gap-1">
                <AlertTriangle className="w-4 h-4 mt-0.5" /> NO uses esta terminal hasta finalizar.
              </p>
              <ProgressRow
                done={migStatus?.commandDelivered}
                label="Comando de borrado entregado a la TPV"
                pending="En cola, esperando heartbeat…"
              />
              <ProgressRow
                done={migStatus?.reboundAfterWipe}
                label="La TPV se reinició y borró su memoria"
                pending="Esperando que la TPV reinicie…"
              />
              <ProgressRow
                done={migStatus?.onlineUnderNewVenue}
                label="La TPV está en línea en el venue nuevo"
                pending="Esperando reconexión…"
              />
              <DialogFooter>
                {migStatus?.confirmed ? (
                  <Button
                    onClick={() => {
                      toast({ title: 'Migración completa', description: 'La TPV está activa en el venue nuevo.' })
                      close()
                    }}
                  >
                    Finalizar
                  </Button>
                ) : (
                  <Button variant="outline" disabled>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Esperando a la TPV…
                  </Button>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={step === 'confirm'}
        onOpenChange={v => {
          if (!v && !executeMutation.isPending) setStep('preflight')
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Migrar esta TPV?</AlertDialogTitle>
            <AlertDialogDescription>
              Se re-asignará <strong>{terminal?.name}</strong> al venue <strong>{venues.find((v: any) => v.id === toVenueId)?.name}</strong>{' '}
              y se enviará un FACTORY RESET. La TPV se reiniciará, borrará su memoria y aparecerá sola en el venue nuevo. Esta acción no se
              puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={executeMutation.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={e => {
                e.preventDefault()
                executeMutation.mutate()
              }}
              disabled={executeMutation.isPending}
            >
              {executeMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Migrar y borrar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function ProgressRow({ done, label, pending }: { done?: boolean; label: string; pending: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {done ? (
        <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
      ) : (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
      )}
      <span className={done ? '' : 'text-muted-foreground'}>{done ? label : pending}</span>
    </div>
  )
}
```

> Verify the exact import paths of `SearchCombobox`, `useToast`, `includesNormalized`, `getAllVenues`, and the `ui/*` primitives against
> `AttachTerminalDialog.tsx` (they were copied from there). If `getAllVenues` returns a typed `Venue[]`, drop the `any` casts.

- [ ] **Step 2: Typecheck**

Run: `npm run build` Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Superadmin/components/MigrateTerminalWizard.tsx
git commit -m "feat(tpv): MigrateTerminalWizard — destination → preflight → confirm → proof-of-wipe poll"
```

---

### Task 8: Wire the row action into the Superadmin Terminals page

**Files:**

- Modify: `src/pages/Superadmin/Terminals.tsx`

- [ ] **Step 1: Add state + handler + button + mount the wizard**

In `src/pages/Superadmin/Terminals.tsx`:

1. Import + state (near `Terminals.tsx:40-41`):

```tsx
import MigrateTerminalWizard from './components/MigrateTerminalWizard'
import { ArrowRightLeft } from 'lucide-react'
// ...
const [migrateOpen, setMigrateOpen] = useState(false)
const [migrateTerminal, setMigrateTerminal] = useState<Terminal | null>(null)
```

2. Handler (near the other `handleEdit` at `:234`):

```tsx
const handleMigrate = useCallback((terminal: Terminal) => {
  setMigrateTerminal(terminal)
  setMigrateOpen(true)
}, [])
```

3. New action button in the actions cell (alongside the Edit button, ~`:355`):

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => handleMigrate(terminal)}>
      <ArrowRightLeft className="w-4 h-4" />
    </Button>
  </TooltipTrigger>
  <TooltipContent>Migrar a otro venue</TooltipContent>
</Tooltip>
```

4. Add `handleMigrate` to the `columns` `useMemo` dependency array (`:396`) so the closure isn't stale.

5. Mount the wizard next to `<TerminalDialog>` (~`:413-418`):

```tsx
<MigrateTerminalWizard open={migrateOpen} onOpenChange={setMigrateOpen} terminal={migrateTerminal} />
```

- [ ] **Step 2: Typecheck**

Run: `npm run build` Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Superadmin/Terminals.tsx
git commit -m "feat(tpv): 'Migrar a otro venue' row action on Superadmin Terminals page"
```

---

### Task 9: End-to-end manual QA (staging, with a real spare terminal)

**Do NOT run this against a production terminal that's taking payments.** Use a spare/test PAX or a terminal you control.

- [ ] **Step 1: Preflight blockers** — open the wizard, pick a venue with NO payment config and/or NO staff PIN. Confirm the wizard shows
      the blockers and disables "Continuar".
- [ ] **Step 2: Happy path** — pick a ready destination venue → confirm → observe: the terminal's venue flips immediately (Terminals list),
      the device receives the wipe on its next heartbeat, reboots, and the wizard's three rows tick green; "Finalizar" enables only after
      `confirmed`.
- [ ] **Step 3: Verify on the device** — staff of the NEW venue can log in by PIN; a test card charge routes to the NEW venue's merchant
      account; old menu/receipts are gone.
- [ ] **Step 4: Device-offline path** — start a migration with the device powered off; confirm the wizard keeps waiting (no false "done"),
      the re-parent already took effect server-side, and when the device powers on within 30 min it pulls the wipe and re-binds to the new
      venue.
- [ ] **Step 5: Resume** — close the wizard mid-progress, reopen the row action; confirm no duplicate migration is started (preflight
      reports `MIGRATION_IN_PROGRESS`).

---

## Self-Review notes (for the implementer)

- **Spec coverage:** preflight blockers (§5 of spec) → Task 2; forced order + heartbeat delivery (§2.1, §2.4) → Task 3; proof-of-wipe (§2.3,
  §6) → Tasks 1+4; endpoints (§4) → Task 5; wizard + risk-window banner + offline/resume (§6, §7) → Tasks 7–9.
- **Deviations from spec (intentional):** (a) backend permission is the inherited `system:manage` (SUPERADMIN) instead of wiring
  `tpv-factory-reset:execute` — the superadmin router already gates this and SUPERADMIN bypasses `checkPermission`, so wiring it would be
  dead code; revisit if migration is ever exposed to org owners. (b) `migrate-status` takes only `commandId` (T0 + target venue derive from
  the command row). (c) the spec's informational `wentOffline` is replaced by the well-defined `currentlyOnline`.
- **Verify-before-coding flags:** the real "active" field on `VenuePaymentConfig` and the active/`pin` fields on `StaffVenue` (Task 2, Step
  1); that `validateRequest` validates `query` (Task 5, Step 2); the dashboard import paths copied from `AttachTerminalDialog` (Task 7).
- **Out of scope (Phase 2):** hard drain gate, pre-wipe ACK, the two wipe defects.

```

```
