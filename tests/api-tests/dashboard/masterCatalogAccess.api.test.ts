import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import prisma from '@/utils/prismaClient'
import { getAuthStatus } from '@/controllers/dashboard/auth.dashboard.controller'
import { resolveMasterCatalogAccess } from '@/services/master-catalog/masterCatalogAccess.service'

jest.mock('jsonwebtoken')
jest.mock('@/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }))
jest.mock('@/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayNames: jest.fn(),
  DEFAULT_ROLE_DISPLAY_NAMES: {},
}))
jest.mock('@/services/master-catalog/masterCatalogAccess.service', () => ({
  resolveMasterCatalogAccess: jest.fn(),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn() },
    venueRolePermission: { findMany: jest.fn() },
    venue: { findMany: jest.fn() },
    organizationModule: { findMany: jest.fn() },
    onboardingProgress: { findUnique: jest.fn() },
  },
}))

const mockedPrisma = prisma as unknown as {
  staff: { findUnique: jest.Mock }
  venueRolePermission: { findMany: jest.Mock }
}
const mockedResolveAccess = jest.mocked(resolveMasterCatalogAccess)

function responseDouble() {
  const res: Partial<Response> & { payload?: unknown } = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn((payload: unknown) => {
    res.payload = payload
    return res
  }) as Response['json']
  res.clearCookie = jest.fn().mockReturnValue(res)
  res.setHeader = jest.fn().mockReturnValue(res)
  return res
}

function organizationMembership(organizationId: string, role: 'OWNER' | 'VIEWER') {
  return {
    organizationId,
    role,
    isActive: true,
    leftAt: null,
    isPrimary: role === 'OWNER',
    organization: {
      id: organizationId,
      name: organizationId === 'org-visible' ? 'PITS' : 'Legacy',
      email: 'owner@example.com',
      onboardingCompletedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
  }
}

describe('GET dashboard auth status master-catalog membership hint', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(jwt.verify as jest.Mock).mockReturnValue({ sub: 'staff-1' })
    mockedPrisma.venueRolePermission.findMany.mockResolvedValue([])
    mockedPrisma.staff.findUnique.mockResolvedValue({
      id: 'staff-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      emailVerified: true,
      photoUrl: null,
      phone: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastLoginAt: new Date('2026-08-09T00:00:00.000Z'),
      organizations: [organizationMembership('org-visible', 'OWNER'), organizationMembership('org-hidden', 'VIEWER')],
      venues: [],
    })
    mockedResolveAccess.mockImplementation(async input => ({
      organizationId: input.organizationId,
      orgRole: input.organizationId === 'org-visible' ? 'OWNER' : 'VIEWER',
      entitlementActive: input.organizationId === 'org-visible',
      moduleActive: input.organizationId === 'org-visible',
      config:
        input.organizationId === 'org-visible'
          ? {
              schemaVersion: 1,
              catalogCoreEnabled: true,
              identifiersEnabled: false,
              regionalPricingEnabled: false,
              governanceMode: 'ADVISORY',
            }
          : null,
      reasonCode: input.organizationId === 'org-visible' ? 'ACCESSIBLE' : 'ENTITLEMENT_MISSING',
      canRead: input.organizationId === 'org-visible',
      canMutateContent: input.organizationId === 'org-visible',
      canConfigureControlPlane: false,
    }))
  })

  it('returns only live organization memberships and derives visibility from the shared access authority', async () => {
    const req = { cookies: { accessToken: 'valid' } } as unknown as Request
    const res = responseDouble()

    await getAuthStatus(req, res as Response)

    expect(mockedPrisma.staff.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ organizations: expect.objectContaining({ where: { isActive: true, leftAt: null } }) }),
      }),
    )
    expect(mockedResolveAccess).toHaveBeenCalledTimes(2)
    expect((res.payload as { user: { organizationMemberships: unknown[] } }).user.organizationMemberships).toEqual([
      { organizationId: 'org-visible', organizationName: 'PITS', role: 'OWNER', masterCatalogVisible: true },
      { organizationId: 'org-hidden', organizationName: 'Legacy', role: 'VIEWER', masterCatalogVisible: false },
    ])
  })

  it('keeps the authenticated session and hides only the catalog when its visibility authority is unavailable', async () => {
    mockedResolveAccess.mockRejectedValueOnce(new Error('catalog dependency unavailable'))
    const req = { cookies: { accessToken: 'valid' } } as unknown as Request
    const res = responseDouble()

    await getAuthStatus(req, res as Response)

    expect(res.clearCookie).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect((res.payload as { authenticated: boolean; user: { organizationMemberships: unknown[] } }).authenticated).toBe(true)
    expect((res.payload as { user: { organizationMemberships: unknown[] } }).user.organizationMemberships[0]).toEqual({
      organizationId: 'org-visible',
      organizationName: 'PITS',
      role: 'OWNER',
      masterCatalogVisible: false,
    })
  })
})
