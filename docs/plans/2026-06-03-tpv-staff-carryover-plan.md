# TPV Staff Carry-Over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner grant the right people access (role + PIN) at a destination venue — as a step inside the TPV migration wizard (before the terminal moves) and as a standalone action — in plain language, reusing the existing safe staff-assignment logic.

**Architecture:** No schema change. A new backend service (`venue-access.service.ts`) batches the existing `assignToVenue` upsert atomically; new superadmin + org-owner endpoints expose it; a candidate-lister feeds the picker. Two frontends (avoqado-superadmin, avoqado-web-dashboard org) add a `staff` wizard step + a standalone "Dar acceso" drawer that both call the grant endpoint. Grants happen BEFORE the move, enforced by step order.

**Tech Stack:** Express + TypeScript + Prisma (Jest); React 18 + TanStack Query (Vitest + MSW). Spec: `docs/plans/2026-06-03-tpv-staff-carryover-design.md`.

---

## File Structure

**avoqado-server**
- `src/services/superadmin/staff.superadmin.service.ts` — *modify*: extract `upsertVenueAssignment(tx, …)`; `assignToVenue` becomes a thin wrapper.
- `src/services/dashboard/venue-access.service.ts` — *new*: `grantVenueAccessBatch`, `listVenueAccessCandidates`.
- `src/services/organization-dashboard/orgVenueAccess.service.ts` — *new*: org-scoped wrappers.
- `src/routes/superadmin/venue-access.schemas.ts` — *new*: Zod (Spanish, non-empty-string ids).
- `src/controllers/superadmin/venue-access.controller.ts` — *new*.
- `src/routes/superadmin/venue-access.routes.ts` — *new*; mount in the superadmin router.
- `src/routes/dashboard/organizationDashboard.routes.ts` — *modify*: 2 routes behind `requireOrgOwner`.
- `.worktrees/admin-mcp/scripts/mcp/` — *modify*: add `grant_venue_access` tool.
- Tests under `tests/unit/services/` and `tests/unit/routes/`.

**avoqado-superadmin**
- `src/features/terminals/api.ts` — *modify*: add candidates + grant calls + types.
- `src/features/terminals/use-venue-access.ts` — *new*: `useVenueAccessCandidates`, `useGrantVenueAccess`.
- `src/features/terminals/StaffAccessStep.tsx` — *new*: picker + per-person role/PIN + summary.
- `src/features/terminals/role-labels.ts` — *new*: `StaffRole` → Spanish label map.
- `src/features/terminals/TerminalMigrationDrawer.tsx` — *modify*: insert `staff` step (`pick → staff → preflight → progress`).
- `src/features/terminals/GrantAccessDrawer.tsx` — *new*: standalone wrapper around `StaffAccessStep`.

**avoqado-web-dashboard**
- `src/pages/Organization/components/use-org-venue-access.ts` — *new*: hooks.
- `src/pages/Organization/components/OrgStaffAccessStep.tsx` — *new*.
- `src/pages/Organization/components/OrgMigrateTerminalWizard.tsx` — *modify*: insert `staff` step.
- `src/pages/Organization/components/OrgGrantAccessDialog.tsx` — *new*: standalone, mounted from `OrgTerminalDrawer.tsx`.
- `src/utils/role-permissions.ts` — *reuse* its Spanish labels if present, else add a small map.

---

# PHASE 1 — Backend (avoqado-server)

Independently deployable + testable. Additive endpoints (safe for the legacy dashboard).

## Task B1: tx-aware `upsertVenueAssignment` + refactor `assignToVenue`

**Files:**
- Modify: `src/services/superadmin/staff.superadmin.service.ts`
- Test: `tests/unit/services/superadmin/upsert-venue-assignment.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/superadmin/upsert-venue-assignment.test.ts
import prisma from '@/utils/prismaClient'
import { upsertVenueAssignment } from '@/services/superadmin/staff.superadmin.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    staffOrganization: { findUnique: jest.fn() },
    staffVenue: { findFirst: jest.fn(), upsert: jest.fn() },
  },
}))

const m = prisma as unknown as {
  staff: { findUnique: jest.Mock }
  venue: { findUnique: jest.Mock }
  staffOrganization: { findUnique: jest.Mock }
  staffVenue: { findFirst: jest.Mock; upsert: jest.Mock }
}

const healthy = () => {
  m.staff.findUnique.mockResolvedValue({ id: 'staff-1' })
  m.venue.findUnique.mockResolvedValue({ id: 'venue-1', organizationId: 'org-1', name: 'V' })
  m.staffOrganization.findUnique.mockResolvedValue({ isActive: true })
  m.staffVenue.findFirst.mockResolvedValue(null)
  m.staffVenue.upsert.mockResolvedValue({})
}

describe('upsertVenueAssignment', () => {
  beforeEach(() => jest.clearAllMocks())

  it('upserts the StaffVenue when staff ∈ org and PIN is free', async () => {
    healthy()
    await upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'MANAGER' as any, '3987')
    expect(m.staffVenue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { staffId_venueId: { staffId: 'staff-1', venueId: 'venue-1' } },
        update: expect.objectContaining({ role: 'MANAGER', pin: '3987', active: true, endDate: null }),
        create: expect.objectContaining({ staffId: 'staff-1', venueId: 'venue-1', role: 'MANAGER', pin: '3987', active: true }),
      }),
    )
  })

  it('rejects when staff does not belong to the venue org', async () => {
    healthy()
    m.staffOrganization.findUnique.mockResolvedValue(null)
    await expect(upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'MANAGER' as any)).rejects.toThrow(
      'no pertenece a la organización',
    )
    expect(m.staffVenue.upsert).not.toHaveBeenCalled()
  })

  it('rejects when the PIN is already used by someone else in the venue', async () => {
    healthy()
    m.staffVenue.findFirst.mockResolvedValue({ id: 'other' })
    await expect(upsertVenueAssignment(prisma as any, 'staff-1', 'venue-1', 'WAITER' as any, '3987')).rejects.toThrow(
      'PIN ya está en uso',
    )
    expect(m.staffVenue.upsert).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npm run test:unit -- upsert-venue-assignment`
Expected: FAIL — `upsertVenueAssignment` is not exported.

- [ ] **Step 3: Add `upsertVenueAssignment` and rewrite `assignToVenue` as a wrapper**

In `src/services/superadmin/staff.superadmin.service.ts`, add the import (if missing) and the helper. Then replace the body of `assignToVenue` (currently lines ~419-487) so its validations live in the helper:

```ts
import { Prisma } from '@prisma/client' // add to existing imports if not present

/**
 * Core venue-assignment upsert — tx-aware so a batch can run it inside one transaction.
 * Validates: staff exists, venue exists, staff ∈ venue's org, PIN unique within venue.
 * Does NOT hydrate/return the staff (callers decide).
 */
export async function upsertVenueAssignment(
  client: Prisma.TransactionClient,
  staffId: string,
  venueId: string,
  role: StaffRole,
  pin?: string,
): Promise<void> {
  const staff = await client.staff.findUnique({ where: { id: staffId }, select: { id: true } })
  if (!staff) {
    const error: any = new Error('Usuario no encontrado')
    error.statusCode = 404
    throw error
  }

  const venue = await client.venue.findUnique({
    where: { id: venueId },
    select: { id: true, organizationId: true, name: true },
  })
  if (!venue) {
    const error: any = new Error('Sucursal no encontrada')
    error.statusCode = 404
    throw error
  }

  const orgMembership = await client.staffOrganization.findUnique({
    where: { staffId_organizationId: { staffId, organizationId: venue.organizationId } },
  })
  if (!orgMembership || !orgMembership.isActive) {
    const error: any = new Error('El usuario no pertenece a la organización de esta sucursal. Asígnelo primero a la organización.')
    error.statusCode = 400
    throw error
  }

  if (pin) {
    const existingPin = await client.staffVenue.findFirst({
      where: { venueId, pin, active: true, staffId: { not: staffId } },
    })
    if (existingPin) {
      const error: any = new Error('Este PIN ya está en uso en esta sucursal')
      error.statusCode = 400
      throw error
    }
  }

  await client.staffVenue.upsert({
    where: { staffId_venueId: { staffId, venueId } },
    update: { role, pin: pin !== undefined ? pin || null : undefined, active: true, endDate: null },
    create: { staffId, venueId, role, pin: pin || null, active: true },
  })
}
```

Then make `assignToVenue` delegate (keep its public signature + `getStaffById` return for the existing route):

```ts
export async function assignToVenue(staffId: string, venueId: string, role: StaffRole, pin?: string) {
  await upsertVenueAssignment(prisma, staffId, venueId, role, pin)
  logger.info(`[STAFF-SUPERADMIN] Assigned staff to venue`, { staffId, venueId, role })
  return getStaffById(staffId)
}
```

(Passing the global `prisma` where `Prisma.TransactionClient` is expected is fine — `PrismaClient` is assignable to it.)

- [ ] **Step 4: Run tests; verify pass + no regression in the existing assign route test**

Run: `npm run test:unit -- upsert-venue-assignment staff.superadmin`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/superadmin/staff.superadmin.service.ts tests/unit/services/superadmin/upsert-venue-assignment.test.ts
git commit -m "refactor(staff): extract tx-aware upsertVenueAssignment from assignToVenue"
```

---

## Task B2: `grantVenueAccessBatch` service

**Files:**
- Create: `src/services/dashboard/venue-access.service.ts`
- Test: `tests/unit/services/dashboard/grant-venue-access.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/dashboard/grant-venue-access.test.ts
import prisma from '@/utils/prismaClient'
import { grantVenueAccessBatch } from '@/services/dashboard/venue-access.service'
import * as staffSvc from '@/services/superadmin/staff.superadmin.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}))
jest.mock('@/services/superadmin/staff.superadmin.service')
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { logAction } from '@/services/dashboard/activity-log.service'

const m = prisma as unknown as { $transaction: jest.Mock }
const upsert = staffSvc.upsertVenueAssignment as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  // run the interactive-transaction callback with a fake tx
  m.$transaction.mockImplementation(async (cb: any) => cb({}))
  upsert.mockResolvedValue(undefined)
})

describe('grantVenueAccessBatch', () => {
  const actor = { staffId: 'admin-1' }

  it('grants every person and writes one audit log each', async () => {
    const res = await grantVenueAccessBatch(
      'venue-1',
      [
        { staffId: 's1', role: 'MANAGER' as any, pin: '1111' },
        { staffId: 's2', role: 'WAITER' as any, pin: '2222' },
      ],
      actor as any,
    )
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenCalledWith(expect.anything(), 's1', 'venue-1', 'MANAGER', '1111')
    expect(logAction).toHaveBeenCalledTimes(2)
    expect(res).toEqual([
      { staffId: 's1', role: 'MANAGER', pin: '1111' },
      { staffId: 's2', role: 'WAITER', pin: '2222' },
    ])
  })

  it('rejects an empty batch', async () => {
    await expect(grantVenueAccessBatch('venue-1', [], actor as any)).rejects.toThrow('al menos una persona')
  })

  it('rejects two people sharing a PIN (would collide at the unique index)', async () => {
    await expect(
      grantVenueAccessBatch('venue-1', [
        { staffId: 's1', role: 'MANAGER' as any, pin: '1111' },
        { staffId: 's2', role: 'WAITER' as any, pin: '1111' },
      ], actor as any),
    ).rejects.toThrow('mismo PIN')
    expect(m.$transaction).not.toHaveBeenCalled()
  })

  it('does NOT write any audit log when a grant fails inside the transaction (atomic)', async () => {
    upsert.mockRejectedValueOnce(new Error('boom'))
    await expect(
      grantVenueAccessBatch('venue-1', [{ staffId: 's1', role: 'MANAGER' as any, pin: '1111' }], actor as any),
    ).rejects.toThrow('boom')
    expect(logAction).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npm run test:unit -- grant-venue-access`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```ts
// src/services/dashboard/venue-access.service.ts
import prisma from '@/utils/prismaClient'
import { StaffRole } from '@prisma/client'
import { upsertVenueAssignment } from '@/services/superadmin/staff.superadmin.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import type { TerminalActor } from '@/services/dashboard/terminals.superadmin.service'

export interface VenueAccessGrant {
  staffId: string
  role: StaffRole
  pin?: string
}

export interface GrantResult {
  staffId: string
  role: StaffRole
  pin: string | null
}

/**
 * Grant venue access to a batch of staff ATOMICALLY.
 * Pre-validates the batch (no duplicate staff, no duplicate PINs), then upserts
 * all assignments in ONE transaction — all succeed or none do. Audit logs are
 * written only after the transaction commits.
 */
export async function grantVenueAccessBatch(
  venueId: string,
  grants: VenueAccessGrant[],
  actor: TerminalActor,
): Promise<GrantResult[]> {
  if (grants.length === 0) {
    const error: any = new Error('Selecciona al menos una persona')
    error.statusCode = 400
    throw error
  }

  const ids = grants.map(g => g.staffId)
  if (new Set(ids).size !== ids.length) {
    const error: any = new Error('Una persona aparece dos veces en la lista.')
    error.statusCode = 400
    throw error
  }

  const pins = grants.map(g => g.pin).filter((p): p is string => !!p)
  if (new Set(pins).size !== pins.length) {
    const error: any = new Error('Dos personas tienen el mismo PIN. Cada PIN debe ser distinto.')
    error.statusCode = 400
    throw error
  }

  await prisma.$transaction(async tx => {
    for (const g of grants) {
      await upsertVenueAssignment(tx, g.staffId, venueId, g.role, g.pin)
    }
  })

  for (const g of grants) {
    await logAction({
      staffId: actor.staffId ?? null,
      venueId,
      action: 'STAFF_VENUE_ACCESS_GRANTED',
      entity: 'StaffVenue',
      entityId: g.staffId,
      data: { grantedStaffId: g.staffId, role: g.role, viaPin: !!g.pin },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    })
  }

  return grants.map(g => ({ staffId: g.staffId, role: g.role, pin: g.pin ?? null }))
}
```

- [ ] **Step 4: Run tests; verify pass**

Run: `npm run test:unit -- grant-venue-access`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/dashboard/venue-access.service.ts tests/unit/services/dashboard/grant-venue-access.test.ts
git commit -m "feat(venue-access): atomic grantVenueAccessBatch service"
```

---

## Task B3: `listVenueAccessCandidates` service

**Files:**
- Modify: `src/services/dashboard/venue-access.service.ts`
- Test: `tests/unit/services/dashboard/list-access-candidates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/dashboard/list-access-candidates.test.ts
import prisma from '@/utils/prismaClient'
import { listVenueAccessCandidates } from '@/services/dashboard/venue-access.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn() }, staff: { findMany: jest.fn() } },
}))
const m = prisma as unknown as { venue: { findUnique: jest.Mock }; staff: { findMany: jest.Mock } }

beforeEach(() => {
  jest.clearAllMocks()
  m.venue.findUnique.mockResolvedValue({ id: 'dest', organizationId: 'org-1' })
})

describe('listVenueAccessCandidates', () => {
  it('pre-selects the source-venue role + suggests the source PIN + lists distinct roles held', async () => {
    m.staff.findMany.mockResolvedValue([
      {
        id: 's1', firstName: 'Braulio', lastName: 'Niño', email: 'b@x.com',
        venues: [
          { venueId: 'src', role: 'MANAGER', pin: '3987', active: true },
          { venueId: 'other', role: 'WAITER', pin: '3987', active: true },
        ],
      },
    ])
    const r = await listVenueAccessCandidates('dest', 'src')
    expect(r[0]).toEqual(
      expect.objectContaining({
        staffId: 's1',
        name: 'Braulio Niño',
        inSourceVenue: true,
        currentRoleAtSource: 'MANAGER',
        alreadyAtDestination: false,
        suggestedPin: '3987',
        rolesHeld: expect.arrayContaining(['MANAGER', 'WAITER']),
      }),
    )
  })

  it('flags a person who already has access at the destination', async () => {
    m.staff.findMany.mockResolvedValue([
      { id: 's2', firstName: 'Ana', lastName: 'Lopez', email: 'a@x.com',
        venues: [{ venueId: 'dest', role: 'CASHIER', pin: '1010', active: true }] },
    ])
    const r = await listVenueAccessCandidates('dest', 'src')
    expect(r[0]).toEqual(
      expect.objectContaining({ alreadyAtDestination: true, currentRoleAtDestination: 'CASHIER', inSourceVenue: false }),
    )
  })
})
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npm run test:unit -- list-access-candidates`
Expected: FAIL — `listVenueAccessCandidates` not exported.

- [ ] **Step 3: Implement (append to `venue-access.service.ts`)**

```ts
export interface AccessCandidate {
  staffId: string
  name: string
  email: string
  inSourceVenue: boolean
  currentRoleAtSource: StaffRole | null
  alreadyAtDestination: boolean
  currentRoleAtDestination: StaffRole | null
  suggestedPin: string | null
  rolesHeld: StaffRole[]
}

function mostCommon(arr: string[]): string | null {
  if (arr.length === 0) return null
  const counts = new Map<string, number>()
  for (const x of arr) counts.set(x, (counts.get(x) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

export async function listVenueAccessCandidates(destVenueId: string, sourceVenueId?: string): Promise<AccessCandidate[]> {
  const venue = await prisma.venue.findUnique({ where: { id: destVenueId }, select: { id: true, organizationId: true } })
  if (!venue) {
    const error: any = new Error('Sucursal no encontrada')
    error.statusCode = 404
    throw error
  }

  const staff = await prisma.staff.findMany({
    where: { active: true, organizations: { some: { organizationId: venue.organizationId, isActive: true } } },
    select: {
      id: true, firstName: true, lastName: true, email: true,
      venues: { select: { venueId: true, role: true, pin: true, active: true } },
    },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  })

  return staff.map(s => {
    const activeVenues = s.venues.filter(v => v.active)
    const sourceRow = sourceVenueId ? activeVenues.find(v => v.venueId === sourceVenueId) : undefined
    const destRow = activeVenues.find(v => v.venueId === destVenueId)
    const pins = activeVenues.map(v => v.pin).filter((p): p is string => !!p)
    return {
      staffId: s.id,
      name: `${s.firstName} ${s.lastName}`.trim() || s.email,
      email: s.email,
      inSourceVenue: !!sourceRow,
      currentRoleAtSource: sourceRow?.role ?? null,
      alreadyAtDestination: !!destRow,
      currentRoleAtDestination: destRow?.role ?? null,
      suggestedPin: sourceRow?.pin ?? mostCommon(pins),
      rolesHeld: [...new Set(activeVenues.map(v => v.role))],
    }
  })
}
```

- [ ] **Step 4: Run tests; verify pass**

Run: `npm run test:unit -- list-access-candidates`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/dashboard/venue-access.service.ts tests/unit/services/dashboard/list-access-candidates.test.ts
git commit -m "feat(venue-access): listVenueAccessCandidates for the staff picker"
```

---

## Task B4: Zod schemas (Spanish, mixed-format ids)

**Files:**
- Create: `src/routes/superadmin/venue-access.schemas.ts`
- Test: `tests/unit/routes/venue-access.schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/routes/venue-access.schemas.test.ts
import { grantVenueAccessSchema, listCandidatesSchema } from '@/routes/superadmin/venue-access.schemas'

const UUID = 'f71607dc-cade-402f-8af8-798ce6d1dc66'
const CUID = 'cmph332eq00039kg8z9cqyc4g'

describe('venue-access schemas', () => {
  it('accepts a valid batch grant (mixed cuid/uuid ids)', () => {
    const r = grantVenueAccessSchema.safeParse({
      params: { venueId: UUID },
      body: { grants: [{ staffId: CUID, role: 'MANAGER', pin: '3987' }] },
    })
    expect(r.success).toBe(true)
  })

  it('rejects an empty grants array in Spanish', () => {
    const r = grantVenueAccessSchema.safeParse({ params: { venueId: CUID }, body: { grants: [] } })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toBe('Selecciona al menos una persona')
  })

  it('rejects an invalid role', () => {
    const r = grantVenueAccessSchema.safeParse({
      params: { venueId: CUID }, body: { grants: [{ staffId: CUID, role: 'KING' }] },
    })
    expect(r.success).toBe(false)
  })

  it('accepts a candidates query with optional sourceVenueId', () => {
    const r = listCandidatesSchema.safeParse({ params: { venueId: CUID }, query: { sourceVenueId: UUID } })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npm run test:unit -- venue-access.schemas`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/routes/superadmin/venue-access.schemas.ts
import { z } from 'zod'
import { StaffRole } from '@prisma/client'

// ids are mixed cuid/uuid in prod — validate as non-empty strings (see terminal-migration.schemas.ts)
const id = (msg: string) => z.string().min(1, msg)

export const grantVenueAccessSchema = z.object({
  params: z.object({ venueId: id('ID de sucursal inválido') }),
  body: z.object({
    grants: z
      .array(
        z.object({
          staffId: id('ID de usuario inválido'),
          role: z.nativeEnum(StaffRole, { errorMap: () => ({ message: 'Rol inválido' }) }),
          pin: z.string().regex(/^\d{4,6}$/, 'El PIN debe ser de 4 a 6 dígitos').optional(),
        }),
      )
      .min(1, 'Selecciona al menos una persona'),
  }),
})

export const listCandidatesSchema = z.object({
  params: z.object({ venueId: id('ID de sucursal inválido') }),
  query: z.object({ sourceVenueId: z.string().min(1).optional() }),
})
```

- [ ] **Step 4: Run tests; verify pass**

Run: `npm run test:unit -- venue-access.schemas`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/superadmin/venue-access.schemas.ts tests/unit/routes/venue-access.schemas.test.ts
git commit -m "feat(venue-access): zod schemas (Spanish, mixed-id)"
```

---

## Task B5: Superadmin controller + routes

**Files:**
- Create: `src/controllers/superadmin/venue-access.controller.ts`
- Create: `src/routes/superadmin/venue-access.routes.ts`
- Modify: the superadmin router that aggregates routes (find with `grep -rn "venue-access\|migration" src/routes/superadmin*.ts src/routes/superadmin/index.ts` — mount the new router under `/venues`).

- [ ] **Step 1: Implement the controller**

```ts
// src/controllers/superadmin/venue-access.controller.ts
import { Request, Response, NextFunction } from 'express'
import { grantVenueAccessBatch, listVenueAccessCandidates } from '@/services/dashboard/venue-access.service'

export const candidates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { sourceVenueId } = req.query as { sourceVenueId?: string }
    const data = await listVenueAccessCandidates(venueId, sourceVenueId)
    res.json({ candidates: data })
  } catch (err) {
    next(err)
  }
}

export const grant = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { grants } = req.body
    const authContext = (req as any).authContext
    const actor = {
      staffId: authContext?.userId ?? null,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    }
    const results = await grantVenueAccessBatch(venueId, grants, actor)
    res.json({ granted: results })
  } catch (err) {
    next(err)
  }
}
```

- [ ] **Step 2: Implement the routes**

```ts
// src/routes/superadmin/venue-access.routes.ts
import { Router } from 'express'
import { validateRequest } from '@/middlewares/validation'
import { grantVenueAccessSchema, listCandidatesSchema } from './venue-access.schemas'
import * as controller from '@/controllers/superadmin/venue-access.controller'

const router = Router()

// GET  /superadmin/venues/:venueId/staff-access/candidates?sourceVenueId=
router.get('/:venueId/staff-access/candidates', validateRequest(listCandidatesSchema), controller.candidates)
// POST /superadmin/venues/:venueId/staff-access
router.post('/:venueId/staff-access', validateRequest(grantVenueAccessSchema), controller.grant)

export default router
```

- [ ] **Step 3: Mount it under the superadmin `/venues` namespace**

Find the aggregator (e.g. `src/routes/superadmin.routes.ts` or `src/routes/superadmin/index.ts`) and add:

```ts
import venueAccessRoutes from '@/routes/superadmin/venue-access.routes'
// near the other `router.use('/venues', …)` mounts:
router.use('/venues', venueAccessRoutes)
```

If `/venues` is already mounted by another router, mount these two paths there instead (the paths `/:venueId/staff-access*` won't collide with existing venue endpoints). Verify with: `grep -rn "router.use('/venues'" src/routes`.

- [ ] **Step 4: Smoke-test the validation wiring**

Run: `npm run build`
Expected: compiles. (HTTP behavior is covered by the schema unit tests + manual check in Task B8.)

- [ ] **Step 5: Commit**

```bash
git add src/controllers/superadmin/venue-access.controller.ts src/routes/superadmin/venue-access.routes.ts src/routes/superadmin*.ts src/routes/superadmin/index.ts
git commit -m "feat(venue-access): superadmin candidates + grant endpoints"
```

---

## Task B6: Org-owner wrappers + routes (requireOrgOwner)

**Files:**
- Create: `src/services/organization-dashboard/orgVenueAccess.service.ts`
- Modify: `src/routes/dashboard/organizationDashboard.routes.ts`
- Test: `tests/unit/services/organization-dashboard/org-venue-access.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/organization-dashboard/org-venue-access.test.ts
import prisma from '@/utils/prismaClient'
import { grantVenueAccessForOrg, listVenueAccessCandidatesForOrg } from '@/services/organization-dashboard/orgVenueAccess.service'
import * as venueAccess from '@/services/dashboard/venue-access.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findFirst: jest.fn() } },
}))
jest.mock('@/services/dashboard/venue-access.service')

const m = prisma as unknown as { venue: { findFirst: jest.Mock } }
const grantBatch = venueAccess.grantVenueAccessBatch as jest.Mock
const listCands = venueAccess.listVenueAccessCandidates as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('grantVenueAccessForOrg', () => {
  it('rejects when the destination venue is not in the org', async () => {
    m.venue.findFirst.mockResolvedValue(null) // venue ∉ org
    await expect(
      grantVenueAccessForOrg('org-1', 'venue-x', [{ staffId: 's1', role: 'MANAGER' as any }], { staffId: 'o' } as any),
    ).rejects.toThrow()
    expect(grantBatch).not.toHaveBeenCalled()
  })

  it('delegates to grantVenueAccessBatch when the venue is in the org', async () => {
    m.venue.findFirst.mockResolvedValue({ id: 'venue-1' })
    grantBatch.mockResolvedValue([{ staffId: 's1', role: 'MANAGER', pin: null }])
    await grantVenueAccessForOrg('org-1', 'venue-1', [{ staffId: 's1', role: 'MANAGER' as any }], { staffId: 'o' } as any)
    expect(grantBatch).toHaveBeenCalledWith('venue-1', [{ staffId: 's1', role: 'MANAGER' }], expect.anything())
  })
})

describe('listVenueAccessCandidatesForOrg', () => {
  it('rejects when the venue is not in the org', async () => {
    m.venue.findFirst.mockResolvedValue(null)
    await expect(listVenueAccessCandidatesForOrg('org-1', 'venue-x')).rejects.toThrow()
    expect(listCands).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npm run test:unit -- org-venue-access`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the org-scoped wrappers**

```ts
// src/services/organization-dashboard/orgVenueAccess.service.ts
import prisma from '@/utils/prismaClient'
import {
  grantVenueAccessBatch,
  listVenueAccessCandidates,
  type VenueAccessGrant,
} from '@/services/dashboard/venue-access.service'
import type { TerminalActor } from '@/services/dashboard/terminals.superadmin.service'

async function assertVenueInOrg(venueId: string, orgId: string) {
  const venue = await prisma.venue.findFirst({ where: { id: venueId, organizationId: orgId }, select: { id: true } })
  if (!venue) {
    const error: any = new Error('La sucursal no pertenece a esta organización')
    error.statusCode = 403
    throw error
  }
}

export async function grantVenueAccessForOrg(
  orgId: string,
  venueId: string,
  grants: VenueAccessGrant[],
  actor: TerminalActor,
) {
  await assertVenueInOrg(venueId, orgId)
  // grantVenueAccessBatch → upsertVenueAssignment independently re-checks staff ∈ org (defense in depth).
  return grantVenueAccessBatch(venueId, grants, actor)
}

export async function listVenueAccessCandidatesForOrg(orgId: string, venueId: string, sourceVenueId?: string) {
  await assertVenueInOrg(venueId, orgId)
  if (sourceVenueId) await assertVenueInOrg(sourceVenueId, orgId)
  return listVenueAccessCandidates(venueId, sourceVenueId)
}
```

- [ ] **Step 4: Add the two routes behind `requireOrgOwner`**

In `src/routes/dashboard/organizationDashboard.routes.ts`, near the existing terminal-migration routes, add (reuse the same Zod body shape — import the schemas; validate `req.body.grants`):

```ts
import * as orgVenueAccess from '@/services/organization-dashboard/orgVenueAccess.service'

/**
 * GET /dashboard/organizations/:orgId/venues/:venueId/staff-access/candidates?sourceVenueId=
 * Owner-only. Lists org staff with their current role at the source venue (for pre-select).
 */
router.get(
  '/:orgId/venues/:venueId/staff-access/candidates',
  authenticateTokenMiddleware,
  requireOrgOwner,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, venueId } = req.params
      const { sourceVenueId } = req.query as { sourceVenueId?: string }
      const candidates = await orgVenueAccess.listVenueAccessCandidatesForOrg(orgId, venueId, sourceVenueId)
      res.json({ candidates })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /dashboard/organizations/:orgId/venues/:venueId/staff-access
 * Owner-only. Body: { grants: [{ staffId, role, pin? }] }. Atomic batch grant.
 */
router.post(
  '/:orgId/venues/:venueId/staff-access',
  authenticateTokenMiddleware,
  requireOrgOwner,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orgId, venueId } = req.params
      const { grants } = req.body
      const authContext = (req as any).authContext
      const actor = { staffId: authContext?.userId ?? null, ipAddress: req.ip, userAgent: req.get('user-agent') ?? undefined }
      const granted = await orgVenueAccess.grantVenueAccessForOrg(orgId, venueId, grants, actor)
      res.json({ granted })
    } catch (err) {
      next(err)
    }
  },
)
```

(If the file validates bodies with a middleware elsewhere, add `validateRequest(grantVenueAccessSchema)` after `requireOrgOwner`; otherwise the service-layer validations in `grantVenueAccessBatch` already reject bad input with Spanish messages.)

- [ ] **Step 5: Run tests; verify pass + build**

Run: `npm run test:unit -- org-venue-access && npm run build`
Expected: PASS + compiles.

- [ ] **Step 6: Commit**

```bash
git add src/services/organization-dashboard/orgVenueAccess.service.ts src/routes/dashboard/organizationDashboard.routes.ts tests/unit/services/organization-dashboard/org-venue-access.test.ts
git commit -m "feat(venue-access): org-owner candidates + grant endpoints (requireOrgOwner)"
```

---

## Task B7: MCP tool `grant_venue_access`

**Files:**
- Modify: `.worktrees/admin-mcp/scripts/mcp/` (the admin MCP, pending merge → develop). Find the tool registry: `grep -rn "move_terminal" .worktrees/admin-mcp/scripts/mcp`.

> The admin MCP lives in the `feat/admin-mcp` worktree. Implement this tool **there** so it rides with that branch. If that branch has already merged to develop by the time you run this task, apply it in `scripts/mcp/` on develop instead.

- [ ] **Step 1: Add the tool, mirroring `move_terminal`'s structure (Prisma-direct)**

Register a `grant_venue_access` tool that accepts `{ venueId, grants: [{ staffId, role, pin? }], sourceVenueId? }` and calls the same logic. Reuse the service if importable from the worktree; otherwise inline the same validations (staff ∈ org, venue exists, PIN unique) Prisma-direct. Return the granted list. Follow the exact registration/validation pattern of the neighbouring `move_terminal` tool.

- [ ] **Step 2: Run the MCP test suite (if present in the worktree)**

Run: `cd .worktrees/admin-mcp && npm run test:unit -- mcp` (adjust to the worktree's test script)
Expected: PASS.

- [ ] **Step 3: Commit (in the worktree branch)**

```bash
cd .worktrees/admin-mcp
git add scripts/mcp
git commit -m "feat(mcp): grant_venue_access tool"
```

---

## Task B8: Full suite + pre-deploy + manual smoke

- [ ] **Step 1: Format + lint**

Run: `npm run format && npm run lint:fix`

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green (new + existing).

- [ ] **Step 3: Pre-deploy simulation**

Run: `npm run pre-deploy`
Expected: PASS.

- [ ] **Step 4: Manual smoke (local DB) — confirm the persisted state**

Start `npm run dev`; with a superadmin cookie, `POST /api/v1/superadmin/venues/<venueId>/staff-access` `{ grants: [{ staffId, role: "MANAGER", pin: "1234" }] }`, then:

```bash
psql "$DATABASE_URL" -c 'SELECT "staffId", role, pin, active FROM "StaffVenue" WHERE "venueId" = '\''<venueId>'\'' ORDER BY role;'
```

Expected: the row exists with the role + PIN + active=true. Re-run the same grant → still one row (idempotent upsert).

- [ ] **Step 5: Commit any lint/format fixups**

```bash
git add -A && git commit -m "chore: format + lint for venue-access"
```

---

# PHASE 2 — avoqado-superadmin frontend

Follow `.impeccable.md`. Reuse `Combobox`, `Badge`, `Drawer`, `Button`, `Checkbox`. Mirror the existing `PickStep` / `MerchantPicker` in `TerminalMigrationDrawer.tsx` for layout/styling. Cookie auth, `withCredentials`. Tests: Vitest + MSW.

## Task S1: API client + role labels + hooks

**Files:**
- Modify: `src/features/terminals/api.ts`
- Create: `src/features/terminals/role-labels.ts`
- Create: `src/features/terminals/use-venue-access.ts`

- [ ] **Step 1: Add types + API calls in `api.ts`** (match backend response shapes)

```ts
export type StaffRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'CASHIER' | 'WAITER' | 'KITCHEN' | 'HOST' | 'VIEWER' | 'SUPERADMIN'

export interface AccessCandidate {
  staffId: string
  name: string
  email: string
  inSourceVenue: boolean
  currentRoleAtSource: StaffRole | null
  alreadyAtDestination: boolean
  currentRoleAtDestination: StaffRole | null
  suggestedPin: string | null
  rolesHeld: StaffRole[]
}

export interface VenueAccessGrant { staffId: string; role: StaffRole; pin?: string }

export async function fetchVenueAccessCandidates(venueId: string, sourceVenueId?: string): Promise<AccessCandidate[]> {
  const { data } = await api.get(`/superadmin/venues/${venueId}/staff-access/candidates`, {
    params: sourceVenueId ? { sourceVenueId } : undefined,
  })
  return data.candidates
}

export async function grantVenueAccess(venueId: string, grants: VenueAccessGrant[]): Promise<VenueAccessGrant[]> {
  const { data } = await api.post(`/superadmin/venues/${venueId}/staff-access`, { grants })
  return data.granted
}
```

- [ ] **Step 2: Role labels**

```ts
// src/features/terminals/role-labels.ts
import type { StaffRole } from './api'
export const ROLE_LABEL_ES: Record<StaffRole, string> = {
  SUPERADMIN: 'Superadmin', OWNER: 'Dueño', ADMIN: 'Administrador', MANAGER: 'Gerente',
  CASHIER: 'Cajero', WAITER: 'Mesero', KITCHEN: 'Cocina', HOST: 'Anfitrión', VIEWER: 'Solo ver',
}
// Roles an owner should be able to pick in the access wizard (exclude SUPERADMIN/OWNER by default).
export const ASSIGNABLE_ROLES: StaffRole[] = ['ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'HOST', 'VIEWER']
```

- [ ] **Step 3: Hooks**

```ts
// src/features/terminals/use-venue-access.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchVenueAccessCandidates, grantVenueAccess, type VenueAccessGrant } from './api'

export function useVenueAccessCandidates(venueId: string | null, sourceVenueId?: string, enabled = true) {
  return useQuery({
    queryKey: ['superadmin', 'venue-access', venueId, sourceVenueId],
    queryFn: () => fetchVenueAccessCandidates(venueId as string, sourceVenueId),
    enabled: !!venueId && enabled,
  })
}

export function useGrantVenueAccess() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ venueId, grants }: { venueId: string; grants: VenueAccessGrant[] }) => grantVenueAccess(venueId, grants),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ['superadmin', 'venue-access', vars.venueId] }),
  })
}
```

- [ ] **Step 4: Build** — `npm run build` (compiles).
- [ ] **Step 5: Commit** — `git add src/features/terminals/{api.ts,role-labels.ts,use-venue-access.ts} && git commit -m "feat(terminals): venue-access api + hooks"`

## Task S2: `StaffAccessStep` component

**Files:**
- Create: `src/features/terminals/StaffAccessStep.tsx`
- Test: `src/features/terminals/StaffAccessStep.test.tsx`

- [ ] **Step 1: Write the component**

Behavior (mirror `PickStep`/`MerchantPicker` styling from `TerminalMigrationDrawer.tsx`):
- Props: `{ destVenueId, sourceVenueId, destVenueName, onDone(granted), onSkip }`.
- Loads candidates via `useVenueAccessCandidates(destVenueId, sourceVenueId)`.
- A searchable list (reuse `Combobox` to add a person, or a checkbox list like `MerchantPicker`). Each selected person becomes a row with:
  - name + email,
  - a **role `Combobox`** defaulting to `currentRoleAtSource ?? currentRoleAtDestination ?? 'WAITER'`, options = union of `ASSIGNABLE_ROLES` and the person's `rolesHeld`, labels via `ROLE_LABEL_ES`,
  - a **PIN input** defaulting to `suggestedPin ?? ''` (numeric, 4–6 digits),
  - a one-line summary: `Le vas a dar acceso a {name} como {ROLE_LABEL_ES[role]}{pin ? ' con PIN ' + pin : ''}.`
- People with `alreadyAtDestination` show a muted `<Badge tone="muted">Ya tiene acceso</Badge>` (granting updates their role/PIN).
- Footer: primary `Button` "Dar acceso y continuar" → calls `useGrantVenueAccess`, then `onDone(granted)`. Secondary "Omitir" → `onSkip()` (no one carried over; the migration's `NO_STAFF_PIN` check still applies later).
- On grant error use `inspectApiError` + `toast.error` (PIN collision message surfaces verbatim).

- [ ] **Step 2: Write the test** (Vitest + MSW)

```tsx
// asserts: renders candidates from a mocked GET, pre-selects the source role label,
// posting calls the grant endpoint with { staffId, role, pin }, and a PIN-collision
// 400 shows the server message. Use renderWithProviders + server.use(http.get/post …).
```

- [ ] **Step 3: Run** — `npm run test -- StaffAccessStep` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(terminals): StaffAccessStep (grant access UI)"`

## Task S3: Insert the `staff` step into the migration wizard

**Files:**
- Modify: `src/features/terminals/TerminalMigrationDrawer.tsx`

- [ ] **Step 1:** Change `type Step = 'pick' | 'preflight' | 'progress'` → `'pick' | 'staff' | 'preflight' | 'progress'`. After `PickStep`'s "Verificar destino", go to `'staff'` first (not straight to preflight). Render `<StaffAccessStep destVenueId={toVenueId} sourceVenueId={terminal.venueId} destVenueName={destinationVenueName} onDone={() => { runPreflight(); }} onSkip={() => { runPreflight(); }} />`. `runPreflight()` calls the existing `handlePreflight` logic and sets step to `'preflight'`.
- [ ] **Step 2:** Keep the existing preflight/confirm/progress untouched. Because grants happened in the `staff` step, `NO_STAFF_PIN` will pass when someone with a PIN was carried over.
- [ ] **Step 3:** Update/extend the drawer's existing test for the new step order. Run `npm run test -- TerminalMigrationDrawer` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(terminals): add staff carry-over step to migration wizard"`

## Task S4: Standalone "Dar acceso" drawer

**Files:**
- Create: `src/features/terminals/GrantAccessDrawer.tsx`
- Modify: wherever terminal/venue actions live (e.g. `TerminalActionDrawer`) to add a "Dar acceso a una persona" action that opens it.

- [ ] **Step 1:** `GrantAccessDrawer` = a `Drawer` whose body is `<StaffAccessStep destVenueId={terminal.venueId} destVenueName={terminal.venue.name} onDone={close} onSkip={close} />` (no `sourceVenueId` → no pre-select, picker shows the whole org). Title: "Dar acceso a una persona".
- [ ] **Step 2:** Wire an entry point button in the terminal action menu.
- [ ] **Step 3:** Test it renders + grants. Run `npm run test -- GrantAccessDrawer` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(terminals): standalone grant-access drawer"`

## Task S5: Verify + CHANGELOG

- [ ] **Step 1:** `npm run check && npm run build` → green.
- [ ] **Step 2:** Add a `CHANGELOG.md` `[Unreleased] → Added` entry: "Traspaso de acceso de usuarios al migrar una terminal + acción 'Dar acceso a una persona'."
- [ ] **Step 3:** `impeccable:audit` on the new UI; fix any ≥ high severity.
- [ ] **Step 4: Commit** — `git commit -m "docs(changelog): venue-access carry-over"`

---

# PHASE 3 — avoqado-web-dashboard (org-owner)

Same feature in the org dashboard. Endpoints: `/dashboard/organizations/:orgId/venues/:venueId/staff-access*`. Mirror Phase 2; the org wizard step machine is `pickVenue → preflight → confirm → progress` (add `staff` after `pickVenue`).

## Task W1: API + hooks + role labels

**Files:**
- Create: `src/pages/Organization/components/use-org-venue-access.ts` (+ api fns colocated or in the existing org terminals api module).

- [ ] **Step 1:** Add `fetchOrgVenueAccessCandidates(orgId, venueId, sourceVenueId?)` → `GET /dashboard/organizations/${orgId}/venues/${venueId}/staff-access/candidates` and `grantOrgVenueAccess(orgId, venueId, grants)` → `POST …/staff-access`. Same `AccessCandidate` / `VenueAccessGrant` shapes as Phase 2.
- [ ] **Step 2:** `useOrgVenueAccessCandidates` + `useGrantOrgVenueAccess` (TanStack Query), invalidate the org terminals/team keys on success.
- [ ] **Step 3:** Reuse Spanish role labels from `src/utils/role-permissions.ts` if it exports them; else add a local `ROLE_LABEL_ES` map (same as Phase 2).
- [ ] **Step 4:** Build → commit `feat(org): venue-access api + hooks`.

## Task W2: `OrgStaffAccessStep`

**Files:**
- Create: `src/pages/Organization/components/OrgStaffAccessStep.tsx` (+ test)

- [ ] **Step 1:** Same UX as Phase 2's `StaffAccessStep`, using the org hooks + this repo's design primitives (shadcn-based). Props `{ orgId, destVenueId, sourceVenueId?, destVenueName, onDone, onSkip }`.
- [ ] **Step 2:** Test (Vitest + MSW): renders candidates, pre-selects source role, posts grants, surfaces PIN-collision message.
- [ ] **Step 3:** Commit `feat(org): OrgStaffAccessStep`.

## Task W3: Insert step into `OrgMigrateTerminalWizard`

**Files:**
- Modify: `src/pages/Organization/components/OrgMigrateTerminalWizard.tsx`

- [ ] **Step 1:** `type Step = 'pickVenue' | 'staff' | 'preflight' | 'confirm' | 'progress'`. After picking the venue, go to `'staff'`, render `<OrgStaffAccessStep orgId={orgId} destVenueId={toVenueId} sourceVenueId={terminal.venueId} destVenueName={…} onDone={goPreflight} onSkip={goPreflight} />`, then continue to the existing `preflight → confirm → progress`.
- [ ] **Step 2:** Update the wizard's tests for the new step. Run tests → PASS.
- [ ] **Step 3:** Commit `feat(org): carry-over step in migration wizard`.

## Task W4: Standalone entry from `OrgTerminalDrawer`

**Files:**
- Modify: `src/pages/Organization/components/OrgTerminalDrawer.tsx`
- Create: `src/pages/Organization/components/OrgGrantAccessDialog.tsx`

- [ ] **Step 1:** Add a "Dar acceso a una persona" action in the terminal drawer that opens `OrgGrantAccessDialog` = `OrgStaffAccessStep` with `destVenueId = terminal.venueId` (no `sourceVenueId`).
- [ ] **Step 2:** Test renders + grants. PASS.
- [ ] **Step 3:** Commit `feat(org): standalone grant-access from terminal drawer`.

## Task W5: Verify + CHANGELOG

- [ ] **Step 1:** Run the repo's check/build (lint + typecheck + tests + prod build) → green.
- [ ] **Step 2:** CHANGELOG `[Unreleased] → Added` entry.
- [ ] **Step 3:** Commit `docs(changelog): org venue-access carry-over`.

---

# Self-review notes (coverage)

- Spec §4 (flow) → S3/W3 (wizard step) + S4/W4 (standalone). ✓
- Spec §5.1 (reuse `assignToVenue`) → B1. ✓
- Spec §5.2 (batch + candidates + org wrappers + routes) → B2/B3/B5/B6. ✓
- Spec §5.3 (both frontends) → Phase 2 + Phase 3. ✓
- Spec §5.4 (MCP) → B7. ✓
- Spec §6 (atomic, no cross-tenant, PIN, audit, transfer-before-move) → B2 (atomic + audit), B1/B6 (org checks), B4 (PIN format), step order (S3/W3). ✓
- Spec §7 (edge cases): cross-org → B1 org check (greying is a UI nicety in S2/W2); PIN collision → B2 + surfaced in S2/W2; already-at-dest → B3 flag + upsert. ✓
- Spec §9 (tests) → test steps throughout. ✓

# Deploy order

Backend (Phase 1) → wait stable → avoqado-superadmin (Phase 2) + avoqado-web-dashboard (Phase 3). Endpoints are additive; no existing field removed/renamed.
