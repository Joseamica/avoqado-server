/**
 * Org OWNER-scoped terminal migration — security guard tests.
 *
 * These are money-critical, permission-sensitive endpoints: an org OWNER may
 * migrate a terminal ONLY from a venue they own TO another venue within the
 * SAME org. The guarantee has two layers:
 *
 *   1. `requireOrgOwner` route middleware (tested at the bottom) — explicit,
 *      active OWNER row in StaffOrganization for THIS org.
 *   2. The `*ForOrg` service wrappers (tested here) — DB-backed ownership
 *      validators that MUST run, and MUST pass, BEFORE the shared migration
 *      service is ever called.
 *
 * We mock the shared terminal-migration service so we can assert it is/ isn't
 * reached, and we drive the (intentionally private) ownership validators via
 * the prisma mock — exercising the REAL validator logic rather than a stub, so
 * a regression in a validator's org check is caught here.
 */

// --- Mock prisma (drives the real ownership validators) ---------------------
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    terminal: { findUnique: jest.fn() },
    venue: { findFirst: jest.fn(), findMany: jest.fn() },
    merchantAccount: { findMany: jest.fn() },
    staffOrganization: { findFirst: jest.fn() },
  },
}))

// --- Mock the shared migration service (the thing the wrappers delegate to) --
const migratePreflightMock = jest.fn()
const migrateExecuteMock = jest.fn()
const migrateStatusMock = jest.fn()
const migrateCancelMock = jest.fn()
jest.mock('@/services/dashboard/terminal-migration.service', () => ({
  __esModule: true,
  migratePreflight: (...args: any[]) => migratePreflightMock(...args),
  migrateExecute: (...args: any[]) => migrateExecuteMock(...args),
  migrateStatus: (...args: any[]) => migrateStatusMock(...args),
  migrateCancel: (...args: any[]) => migrateCancelMock(...args),
}))

import * as orgTerminals from '@/services/organization-dashboard/orgTerminals.service'
import prisma from '@/utils/prismaClient'
import { ForbiddenError } from '@/errors/AppError'

const prismaMock = prisma as unknown as {
  terminal: { findUnique: jest.Mock }
  venue: { findFirst: jest.Mock; findMany: jest.Mock }
  merchantAccount: { findMany: jest.Mock }
  staffOrganization: { findFirst: jest.Mock }
}

const ORG_ID = 'org-1'
const OTHER_ORG_ID = 'org-2'
const TERMINAL_ID = 'term-1'
const TO_VENUE_ID = 'venue-dest-1'

/** Terminal whose venue belongs to ORG_ID — passes validateTerminalInOrg. */
function terminalInOrg() {
  return {
    id: TERMINAL_ID,
    venue: { id: 'venue-src-1', name: 'Origen', slug: 'origen', organizationId: ORG_ID },
  }
}

/** Terminal whose venue belongs to a DIFFERENT org — fails validateTerminalInOrg. */
function terminalInOtherOrg() {
  return {
    id: TERMINAL_ID,
    venue: { id: 'venue-x', name: 'Ajeno', slug: 'ajeno', organizationId: OTHER_ORG_ID },
  }
}

describe('orgTerminals migration wrappers — ownership guards', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    migratePreflightMock.mockResolvedValue({ canProceed: true })
    migrateExecuteMock.mockResolvedValue({ commandId: 'cmd-1' })
    migrateStatusMock.mockResolvedValue({ confirmed: false })
    migrateCancelMock.mockResolvedValue({ cancelled: true })
  })

  // ---------------------------------------------------------------- preflight
  describe('migratePreflightForOrg', () => {
    it('validates terminal-in-org AND venue-in-org BEFORE calling migratePreflight', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOrg())
      prismaMock.venue.findFirst.mockResolvedValue({ id: TO_VENUE_ID, name: 'Destino' })

      await orgTerminals.migratePreflightForOrg(ORG_ID, TERMINAL_ID, TO_VENUE_ID)

      // both ownership checks ran
      expect(prismaMock.terminal.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: TERMINAL_ID } }))
      expect(prismaMock.venue.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: TO_VENUE_ID, organizationId: ORG_ID }) }),
      )
      // and they ran BEFORE the migration service
      const terminalOrder = prismaMock.terminal.findUnique.mock.invocationCallOrder[0]
      const venueOrder = prismaMock.venue.findFirst.mock.invocationCallOrder[0]
      const migrateOrder = migratePreflightMock.mock.invocationCallOrder[0]
      expect(terminalOrder).toBeLessThan(migrateOrder)
      expect(venueOrder).toBeLessThan(migrateOrder)
      expect(migratePreflightMock).toHaveBeenCalledWith(TERMINAL_ID, TO_VENUE_ID)
    })

    it('throws ForbiddenError and does NOT call migratePreflight when the terminal is in another org', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOtherOrg())

      await expect(orgTerminals.migratePreflightForOrg(ORG_ID, TERMINAL_ID, TO_VENUE_ID)).rejects.toBeInstanceOf(ForbiddenError)

      expect(prismaMock.venue.findFirst).not.toHaveBeenCalled() // short-circuited on the first guard
      expect(migratePreflightMock).not.toHaveBeenCalled()
    })

    it('throws ForbiddenError and does NOT call migratePreflight when the destination venue is in another org', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOrg())
      prismaMock.venue.findFirst.mockResolvedValue(null) // venue not found within org

      await expect(orgTerminals.migratePreflightForOrg(ORG_ID, TERMINAL_ID, TO_VENUE_ID)).rejects.toBeInstanceOf(ForbiddenError)

      expect(migratePreflightMock).not.toHaveBeenCalled()
    })
  })

  // ------------------------------------------------------------------ execute
  describe('migrateExecuteForOrg', () => {
    const actor = { staffId: 'staff-1', ipAddress: '1.2.3.4', userAgent: 'jest' }

    it('validates terminal-in-org AND venue-in-org BEFORE calling migrateExecute', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOrg())
      prismaMock.venue.findFirst.mockResolvedValue({ id: TO_VENUE_ID, name: 'Destino' })

      await orgTerminals.migrateExecuteForOrg(ORG_ID, TERMINAL_ID, TO_VENUE_ID, actor)

      const terminalOrder = prismaMock.terminal.findUnique.mock.invocationCallOrder[0]
      const venueOrder = prismaMock.venue.findFirst.mock.invocationCallOrder[0]
      const migrateOrder = migrateExecuteMock.mock.invocationCallOrder[0]
      expect(terminalOrder).toBeLessThan(migrateOrder)
      expect(venueOrder).toBeLessThan(migrateOrder)
      expect(migrateExecuteMock).toHaveBeenCalledWith(TERMINAL_ID, TO_VENUE_ID, actor, undefined)
    })

    it('validates assigned merchants ∈ org BEFORE calling migrateExecute', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOrg())
      prismaMock.venue.findFirst.mockResolvedValue({ id: TO_VENUE_ID, name: 'Destino' })
      // getOrgVenueIds() → venue.findMany; then merchantAccount.findMany returns all requested ids as valid
      prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-src-1' }])
      prismaMock.merchantAccount.findMany.mockResolvedValue([{ id: 'merch-1' }])

      await orgTerminals.migrateExecuteForOrg(ORG_ID, TERMINAL_ID, TO_VENUE_ID, actor, ['merch-1'])

      expect(prismaMock.merchantAccount.findMany).toHaveBeenCalled()
      const merchantOrder = prismaMock.merchantAccount.findMany.mock.invocationCallOrder[0]
      const migrateOrder = migrateExecuteMock.mock.invocationCallOrder[0]
      expect(merchantOrder).toBeLessThan(migrateOrder)
      expect(migrateExecuteMock).toHaveBeenCalledWith(TERMINAL_ID, TO_VENUE_ID, actor, ['merch-1'])
    })

    it('throws ForbiddenError and does NOT call migrateExecute when a merchant is outside the org', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOrg())
      prismaMock.venue.findFirst.mockResolvedValue({ id: TO_VENUE_ID, name: 'Destino' })
      prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-src-1' }])
      // request 2 merchants but only 1 resolves as belonging to the org → ForbiddenError
      prismaMock.merchantAccount.findMany.mockResolvedValue([{ id: 'merch-1' }])

      await expect(
        orgTerminals.migrateExecuteForOrg(ORG_ID, TERMINAL_ID, TO_VENUE_ID, actor, ['merch-1', 'merch-foreign']),
      ).rejects.toBeInstanceOf(ForbiddenError)

      expect(migrateExecuteMock).not.toHaveBeenCalled()
    })

    it('throws ForbiddenError and does NOT call migrateExecute when the terminal is in another org', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOtherOrg())

      await expect(orgTerminals.migrateExecuteForOrg(ORG_ID, TERMINAL_ID, TO_VENUE_ID, actor)).rejects.toBeInstanceOf(ForbiddenError)

      expect(prismaMock.venue.findFirst).not.toHaveBeenCalled()
      expect(migrateExecuteMock).not.toHaveBeenCalled()
    })
  })

  // ------------------------------------------------------------------- status
  describe('migrateStatusForOrg', () => {
    it('validates terminal-in-org BEFORE calling migrateStatus', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOrg())

      await orgTerminals.migrateStatusForOrg(ORG_ID, TERMINAL_ID, 'cmd-1')

      const terminalOrder = prismaMock.terminal.findUnique.mock.invocationCallOrder[0]
      const migrateOrder = migrateStatusMock.mock.invocationCallOrder[0]
      expect(terminalOrder).toBeLessThan(migrateOrder)
      expect(migrateStatusMock).toHaveBeenCalledWith(TERMINAL_ID, 'cmd-1')
    })

    it('throws ForbiddenError and does NOT call migrateStatus when the terminal is in another org', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOtherOrg())

      await expect(orgTerminals.migrateStatusForOrg(ORG_ID, TERMINAL_ID, 'cmd-1')).rejects.toBeInstanceOf(ForbiddenError)

      expect(migrateStatusMock).not.toHaveBeenCalled()
    })
  })

  // ------------------------------------------------------------------- cancel
  describe('migrateCancelForOrg', () => {
    const actor = { staffId: 'staff-1' }

    it('validates terminal-in-org BEFORE calling migrateCancel', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOrg())

      await orgTerminals.migrateCancelForOrg(ORG_ID, TERMINAL_ID, actor)

      const terminalOrder = prismaMock.terminal.findUnique.mock.invocationCallOrder[0]
      const migrateOrder = migrateCancelMock.mock.invocationCallOrder[0]
      expect(terminalOrder).toBeLessThan(migrateOrder)
      expect(migrateCancelMock).toHaveBeenCalledWith(TERMINAL_ID, actor)
    })

    it('throws ForbiddenError and does NOT call migrateCancel when the terminal is in another org', async () => {
      prismaMock.terminal.findUnique.mockResolvedValue(terminalInOtherOrg())

      await expect(orgTerminals.migrateCancelForOrg(ORG_ID, TERMINAL_ID, actor)).rejects.toBeInstanceOf(ForbiddenError)

      expect(migrateCancelMock).not.toHaveBeenCalled()
    })
  })
})

// ===========================================================================
// requireOrgOwner middleware — OWNER gate (route layer)
// ===========================================================================

import { requireOrgOwner } from '@/routes/dashboard/organizationDashboard.routes'

function makeRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

describe('requireOrgOwner middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('calls next() when the requester is an active OWNER of the org', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1' })
    const req: any = { params: { orgId: ORG_ID }, authContext: { userId: 'staff-1', role: 'OWNER' } }
    const res = makeRes()
    const next = jest.fn()

    await requireOrgOwner(req, res, next)

    expect(prismaMock.staffOrganization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ staffId: 'staff-1', organizationId: ORG_ID, isActive: true, role: 'OWNER' }),
      }),
    )
    expect(next).toHaveBeenCalledWith()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('returns 403 when the requester is NOT an OWNER of the org', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    const req: any = { params: { orgId: ORG_ID }, authContext: { userId: 'staff-1', role: 'ADMIN' } }
    const res = makeRes()
    const next = jest.fn()

    await requireOrgOwner(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }))
    expect(next).not.toHaveBeenCalled()
  })

  it('bypasses the OWNER check for SUPERADMIN (no DB lookup, calls next)', async () => {
    const req: any = { params: { orgId: ORG_ID }, authContext: { userId: 'super-1', role: 'SUPERADMIN' } }
    const res = makeRes()
    const next = jest.fn()

    await requireOrgOwner(req, res, next)

    expect(prismaMock.staffOrganization.findFirst).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
    expect(res.status).not.toHaveBeenCalled()
  })
})
