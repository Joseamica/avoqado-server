/**
 * staffCapture.test.ts
 *
 * Verifies the logAction() audit calls added to the 9 audit-critical mutations
 * in staff.superadmin.service.ts fire with the correct action / entity /
 * entityId (target staff id) / staffId (the `performedBy` actor) arguments.
 *
 * Coverage (driven through each function's success path):
 *   - createStaff            → STAFF_CREATED
 *   - updateStaff            → STAFF_UPDATED
 *   - assignToOrganization   → STAFF_ROLE_ASSIGNED (org)
 *   - removeFromOrganization → STAFF_ROLE_REMOVED  (org)
 *   - deleteStaff            → STAFF_DELETED
 *   - resetPassword          → STAFF_PASSWORD_RESET (never logs the password)
 *
 * Strategy: mock prisma + bcrypt locally so we control DB / hashing results,
 * then assert logAction was called with the right shape. logAction itself is
 * already a jest.fn() from the global setup.ts:
 *   jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
 */

import { logAction } from '@/services/dashboard/activity-log.service'
import { OrgRole } from '@prisma/client'

// ── Local prisma mock (overrides the global one for this test file) ───────────
jest.mock('@/utils/prismaClient', () => {
  const models = {
    staff: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    organization: { findUnique: jest.fn() },
    staffOrganization: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      count: jest.fn(),
    },
    staffVenue: { findFirst: jest.fn(), update: jest.fn(), upsert: jest.fn() },
    venue: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  }
  return {
    __esModule: true,
    default: {
      ...models,
      // $transaction(cb) → run the callback with a tx client exposing the same models.
      $transaction: jest.fn((cb: any) => cb(models)),
    },
  }
})

// bcrypt is used to hash passwords on create / reset
jest.mock('bcryptjs', () => ({
  __esModule: true,
  default: { hash: jest.fn().mockResolvedValue('hashed-pw') },
  hash: jest.fn().mockResolvedValue('hashed-pw'),
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import prisma from '@/utils/prismaClient'
import bcrypt from 'bcryptjs'
import {
  createStaff,
  updateStaff,
  assignToOrganization,
  removeFromOrganization,
  deleteStaff,
  resetPassword,
} from '@/services/superadmin/staff.superadmin.service'

const mockPrisma = prisma as any
const mockLogAction = logAction as jest.MockedFunction<typeof logAction>

/** Recursively reset every jest.fn() under the prisma mock so persistent
 *  mockResolvedValue/mockResolvedValueOnce state never leaks between tests
 *  (jest.clearAllMocks clears calls but NOT implementations). */
function resetPrismaMock(obj: any) {
  for (const key of Object.keys(obj)) {
    const v = obj[key]
    if (typeof v === 'function' && 'mockReset' in v) v.mockReset()
    else if (v && typeof v === 'object') resetPrismaMock(v)
  }
}

const ACTOR_ID = 'actor-superadmin-1'
const TARGET_STAFF_ID = 'staff-target-1'
const ORG_ID = 'org-1'

/** Minimal hydrated staff row returned by getStaffById (we don't assert on it). */
function makeStaffDetail() {
  return { id: TARGET_STAFF_ID, email: 'target@example.com', organizations: [], venues: [] }
}

describe('staff.superadmin.service — ActivityLog capture + performedBy actor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetPrismaMock(mockPrisma)
    // Re-establish implementations wiped by resetPrismaMock / clearAllMocks.
    mockPrisma.$transaction.mockImplementation((cb: any) =>
      cb({
        staff: mockPrisma.staff,
        organization: mockPrisma.organization,
        staffOrganization: mockPrisma.staffOrganization,
        staffVenue: mockPrisma.staffVenue,
        venue: mockPrisma.venue,
      }),
    )
    ;(bcrypt.hash as jest.Mock).mockResolvedValue('hashed-pw')
  })

  // ===========================================================================
  // createStaff → STAFF_CREATED
  // ===========================================================================
  it('createStaff logs STAFF_CREATED with the actor and the new staff id', async () => {
    // email uniqueness check → none
    mockPrisma.staff.findUnique
      .mockResolvedValueOnce(null) // existing email check
      .mockResolvedValueOnce(makeStaffDetail()) // getStaffById at the end
    mockPrisma.organization.findUnique.mockResolvedValue({ id: ORG_ID })
    mockPrisma.staff.create.mockResolvedValue({ id: TARGET_STAFF_ID, email: 'target@example.com' })
    mockPrisma.staffOrganization.create.mockResolvedValue({})

    await createStaff(
      {
        email: 'target@example.com',
        firstName: 'Tar',
        lastName: 'Get',
        organizationId: ORG_ID,
        orgRole: OrgRole.MEMBER,
      },
      ACTOR_ID,
    )

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: ACTOR_ID,
        action: 'STAFF_CREATED',
        entity: 'Staff',
        entityId: TARGET_STAFF_ID,
        data: expect.objectContaining({ email: 'target@example.com', organizationId: ORG_ID, orgRole: OrgRole.MEMBER }),
      }),
    )
  })

  // ===========================================================================
  // updateStaff → STAFF_UPDATED
  // ===========================================================================
  it('updateStaff logs STAFF_UPDATED with the actor, target id, and the change payload', async () => {
    mockPrisma.staff.findUnique
      .mockResolvedValueOnce({ id: TARGET_STAFF_ID, email: 'target@example.com' }) // existence check
      .mockResolvedValueOnce(makeStaffDetail()) // getStaffById
    mockPrisma.staff.update.mockResolvedValue({ id: TARGET_STAFF_ID, email: 'target@example.com' })

    await updateStaff(TARGET_STAFF_ID, { firstName: 'NewName', active: false }, ACTOR_ID)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: ACTOR_ID,
        action: 'STAFF_UPDATED',
        entity: 'Staff',
        entityId: TARGET_STAFF_ID,
        data: { changes: { firstName: 'NewName', active: false } },
      }),
    )
  })

  // ===========================================================================
  // assignToOrganization → STAFF_ROLE_ASSIGNED (org)
  // ===========================================================================
  it('assignToOrganization logs STAFF_ROLE_ASSIGNED with org context and the actor', async () => {
    mockPrisma.staff.findUnique
      .mockResolvedValueOnce({ id: TARGET_STAFF_ID }) // staff existence
      .mockResolvedValueOnce(makeStaffDetail()) // getStaffById
    mockPrisma.organization.findUnique.mockResolvedValue({ id: ORG_ID })
    mockPrisma.staffOrganization.findFirst.mockResolvedValue(null) // no primary yet
    mockPrisma.staffOrganization.upsert.mockResolvedValue({})

    await assignToOrganization(TARGET_STAFF_ID, ORG_ID, OrgRole.ADMIN, ACTOR_ID)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: ACTOR_ID,
        action: 'STAFF_ROLE_ASSIGNED',
        entity: 'Staff',
        entityId: TARGET_STAFF_ID,
        data: { organizationId: ORG_ID, role: OrgRole.ADMIN },
      }),
    )
  })

  // ===========================================================================
  // removeFromOrganization → STAFF_ROLE_REMOVED (org)
  // ===========================================================================
  it('removeFromOrganization logs STAFF_ROLE_REMOVED with org context and the actor', async () => {
    mockPrisma.staffOrganization.findUnique.mockResolvedValue({ role: OrgRole.MEMBER, isActive: true })
    mockPrisma.venue.findMany.mockResolvedValue([]) // no venues in org → skip cascade
    mockPrisma.staff.findUnique.mockResolvedValue(makeStaffDetail()) // getStaffById

    await removeFromOrganization(TARGET_STAFF_ID, ORG_ID, ACTOR_ID)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: ACTOR_ID,
        action: 'STAFF_ROLE_REMOVED',
        entity: 'Staff',
        entityId: TARGET_STAFF_ID,
        data: { organizationId: ORG_ID, role: OrgRole.MEMBER },
      }),
    )
  })

  // ===========================================================================
  // deleteStaff → STAFF_DELETED
  // ===========================================================================
  it('deleteStaff logs STAFF_DELETED with the actor and the deleted staff id', async () => {
    mockPrisma.staff.findUnique.mockResolvedValue({ id: TARGET_STAFF_ID, email: 'target@example.com' })
    mockPrisma.staff.delete.mockResolvedValue({})

    await deleteStaff(TARGET_STAFF_ID, ACTOR_ID, ACTOR_ID)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: ACTOR_ID,
        action: 'STAFF_DELETED',
        entity: 'Staff',
        entityId: TARGET_STAFF_ID,
        data: { email: 'target@example.com' },
      }),
    )
  })

  // ===========================================================================
  // resetPassword → STAFF_PASSWORD_RESET (NEVER logs the password)
  // ===========================================================================
  it('resetPassword logs STAFF_PASSWORD_RESET with empty data (no password leaked)', async () => {
    mockPrisma.staff.findUnique.mockResolvedValue({ id: TARGET_STAFF_ID, email: 'target@example.com' })
    mockPrisma.staff.update.mockResolvedValue({})

    await resetPassword(TARGET_STAFF_ID, 'super-secret-new-password', ACTOR_ID)

    expect(mockLogAction).toHaveBeenCalledTimes(1)
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: ACTOR_ID,
        action: 'STAFF_PASSWORD_RESET',
        entity: 'Staff',
        entityId: TARGET_STAFF_ID,
        data: {},
      }),
    )

    // Defensive: the password must never appear anywhere in the logged payload.
    const loggedArg = JSON.stringify(mockLogAction.mock.calls[0][0])
    expect(loggedArg).not.toContain('super-secret-new-password')
    expect(loggedArg).not.toContain('hashed-pw')
  })

  // ===========================================================================
  // REGRESSION: actor defaults to null when no performedBy is threaded
  // ===========================================================================
  it('defaults the actor to null when performedBy is omitted (back-compat)', async () => {
    mockPrisma.staff.findUnique
      .mockResolvedValueOnce({ id: TARGET_STAFF_ID, email: 'target@example.com' })
      .mockResolvedValueOnce(makeStaffDetail())
    mockPrisma.staff.update.mockResolvedValue({ id: TARGET_STAFF_ID, email: 'target@example.com' })

    await updateStaff(TARGET_STAFF_ID, { firstName: 'X' }) // no performedBy

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: null, action: 'STAFF_UPDATED', entityId: TARGET_STAFF_ID }),
    )
  })
})
