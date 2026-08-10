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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
      updateMany: jest.fn(),
    },
    staffVenue: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
    staffPasskey: { deleteMany: jest.fn() },
    deviceToken: { deleteMany: jest.fn() },
    mcpAuthCode: { deleteMany: jest.fn() },
    mcpRefreshToken: { updateMany: jest.fn() },
    oAuthState: { deleteMany: jest.fn() },
    googleOAuthSession: { deleteMany: jest.fn() },
    googleCalendarConnection: { deleteMany: jest.fn() },
    venue: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
  }
  return {
    __esModule: true,
    default: {
      ...models,
      $queryRaw: jest.fn(),
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
import { isH1ProvenanceConstraint } from '@/services/superadmin/staffDeletion.service'

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
        staffPasskey: mockPrisma.staffPasskey,
        deviceToken: mockPrisma.deviceToken,
        mcpAuthCode: mockPrisma.mcpAuthCode,
        mcpRefreshToken: mockPrisma.mcpRefreshToken,
        oAuthState: mockPrisma.oAuthState,
        googleOAuthSession: mockPrisma.googleOAuthSession,
        googleCalendarConnection: mockPrisma.googleCalendarConnection,
        $queryRaw: mockPrisma.$queryRaw,
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
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: TARGET_STAFF_ID, email: 'target@example.com' }]).mockResolvedValueOnce([])
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
    expect(mockPrisma.mcpAuthCode.deleteMany).toHaveBeenCalledWith({ where: { staffId: TARGET_STAFF_ID } })
    expect(mockPrisma.mcpRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { staffId: TARGET_STAFF_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
    expect(mockPrisma.oAuthState.deleteMany).toHaveBeenCalledWith({ where: { userId: TARGET_STAFF_ID } })
    expect(mockPrisma.googleOAuthSession.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ authUserId: TARGET_STAFF_ID }, { staffId: TARGET_STAFF_ID }] },
    })
  })

  it('retains and anonymizes a Staff with immutable H1 provenance in one transaction', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ id: TARGET_STAFF_ID, email: 'target@example.com' }])
      .mockResolvedValueOnce([{ hasProvenance: true }])
    mockPrisma.staff.update.mockResolvedValue({})

    await expect(deleteStaff(TARGET_STAFF_ID, ACTOR_ID, ACTOR_ID)).resolves.toEqual({ success: true, retainedForAudit: true })

    expect(mockPrisma.staff.delete).not.toHaveBeenCalled()
    expect(mockPrisma.staff.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TARGET_STAFF_ID },
        data: expect.objectContaining({
          active: false,
          password: null,
          googleId: null,
          phone: null,
          resetToken: null,
          resetTokenExpiry: null,
          resetTokenUsedAt: null,
          posRawData: expect.anything(),
        }),
      }),
    )
    expect(mockPrisma.staffOrganization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { staffId: TARGET_STAFF_ID, isActive: true } }),
    )
    expect(mockPrisma.staffVenue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { staffId: TARGET_STAFF_ID, active: true },
        data: expect.objectContaining({ active: false, pin: null, posStaffId: null }),
      }),
    )
    expect(mockPrisma.staffPasskey.deleteMany).toHaveBeenCalledWith({ where: { staffId: TARGET_STAFF_ID } })
    expect(mockPrisma.deviceToken.deleteMany).toHaveBeenCalledWith({ where: { staffId: TARGET_STAFF_ID } })
    expect(mockPrisma.mcpAuthCode.deleteMany).toHaveBeenCalledWith({ where: { staffId: TARGET_STAFF_ID } })
    expect(mockPrisma.mcpRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { staffId: TARGET_STAFF_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
    expect(mockPrisma.googleCalendarConnection.deleteMany).toHaveBeenCalledWith({ where: { staffId: TARGET_STAFF_ID } })
    expect(mockPrisma.oAuthState.deleteMany).toHaveBeenCalledWith({ where: { userId: TARGET_STAFF_ID } })
    expect(mockPrisma.googleOAuthSession.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ authUserId: TARGET_STAFF_ID }, { staffId: TARGET_STAFF_ID }] },
    })
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STAFF_RETAINED_FOR_AUDIT', entityId: TARGET_STAFF_ID, data: { retainedForAudit: true } }),
    )
    expect(JSON.stringify(mockLogAction.mock.calls)).not.toContain('target@example.com')
  })

  it('does not reach anonymization when retained credential revocation fails in the transaction', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ id: TARGET_STAFF_ID, email: 'target@example.com' }])
      .mockResolvedValueOnce([{ hasProvenance: true }])
    mockPrisma.mcpRefreshToken.updateMany.mockRejectedValue(new Error('credential revoke failed'))

    await expect(deleteStaff(TARGET_STAFF_ID, ACTOR_ID, ACTOR_ID)).rejects.toThrow('credential revoke failed')

    expect(mockPrisma.staff.update).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('does not reach retained anonymization when OAuth session invalidation fails in the transaction', async () => {
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ id: TARGET_STAFF_ID, email: 'target@example.com' }])
      .mockResolvedValueOnce([{ hasProvenance: true }])
    mockPrisma.googleOAuthSession.deleteMany.mockRejectedValue(new Error('oauth session cleanup failed'))

    await expect(deleteStaff(TARGET_STAFF_ID, ACTOR_ID, ACTOR_ID)).rejects.toThrow('oauth session cleanup failed')

    expect(mockPrisma.staff.update).not.toHaveBeenCalled()
    expect(mockPrisma.staff.delete).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
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

describe('H1 Staff provenance constraint recovery', () => {
  it('recognizes an exact raw PostgreSQL H1 Staff FK constraint', () => {
    expect(
      isH1ProvenanceConstraint({
        code: '23503',
        constraint: 'CatalogItem_createdById_fkey',
        detail: 'Key (id) remains referenced.',
        message: 'update or delete violates foreign key constraint',
      }),
    ).toBe(true)
  })

  it('does not relabel an unrelated legacy FK conflict as H1 provenance', () => {
    expect(
      isH1ProvenanceConstraint({
        code: '23503',
        constraint: 'Order_createdById_fkey',
        message: 'update or delete violates foreign key constraint',
      }),
    ).toBe(false)
  })

  it('recognizes the exact raw PostgreSQL H1 CHECK signature without broadening unrelated checks', () => {
    expect(isH1ProvenanceConstraint({ code: '23514', constraint: 'ActivityLog_actorStaffId_h1_guard', message: 'check violation' })).toBe(
      true,
    )
    expect(isH1ProvenanceConstraint({ code: '23514', constraint: 'Staff_email_format_check', message: 'check violation' })).toBe(false)
  })
})

describe('Staff offboarding credential inventory drift', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  const deletionService = readFileSync(join(process.cwd(), 'src/services/superadmin/staffDeletion.service.ts'), 'utf8')

  it.each([
    ['McpAuthCode', 'staffId', 'mcpAuthCode.deleteMany'],
    ['McpRefreshToken', 'staffId', 'mcpRefreshToken.updateMany'],
    ['OAuthState', 'userId', 'oAuthState.deleteMany'],
    ['GoogleOAuthSession', 'authUserId', 'googleOAuthSession.deleteMany'],
    ['GoogleOAuthSession', 'staffId', 'googleOAuthSession.deleteMany'],
    ['GoogleCalendarConnection', 'staffId', 'googleCalendarConnection.deleteMany'],
  ])('keeps schema authority %s.%s in the transactional cleanup inventory', (model, actorField, cleanupCall) => {
    const modelSource = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1]
    expect(modelSource).toBeDefined()
    expect(modelSource).toMatch(new RegExp(`\\b${actorField}\\b`))
    expect(deletionService).toContain(cleanupCall)
  })
})
