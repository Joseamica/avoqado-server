/**
 * H1A catalog authorization boundary.
 *
 * These cases protect the tenant decision that cannot be delegated to a venue
 * role or stale JWT claim: the route organization and current database rows are
 * authoritative on every request.
 */
import { OrgRole, StaffRole } from '@prisma/client'
import type { AuthContext } from '@/security'
import { authorizeCatalogRequest, findCatalogTenantChildOrThrow } from '@/services/master-catalog/catalogAuthorization.service'
import { MASTER_CATALOG_DEFAULT_CONFIG } from '@/types/master-catalog'

const ROUTE_ORGANIZATION_ID = 'org-route-pits'
const JWT_ORGANIZATION_ID = 'org-stale-token'
const STAFF_ID = 'staff-effective-user'
const NOW = new Date('2026-08-08T18:00:00.000Z')

const organizationFindUnique = jest.fn()
const staffFindUnique = jest.fn()
const entitlementFindUnique = jest.fn()
const moduleFindUnique = jest.fn()

const db = {
  organization: { findUnique: organizationFindUnique },
  staff: { findUnique: staffFindUnique },
  organizationEntitlement: { findUnique: entitlementFindUnique },
  module: { findUnique: moduleFindUnique },
}

function authContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: STAFF_ID,
    orgId: JWT_ORGANIZATION_ID,
    venueId: 'venue-from-stale-token',
    role: StaffRole.CASHIER,
    realUserId: STAFF_ID,
    realRole: StaffRole.CASHIER,
    isImpersonating: false,
    impersonation: null,
    ...overrides,
  }
}

function liveStaff(role: OrgRole = OrgRole.OWNER) {
  return {
    active: true,
    organizations: [{ role, isActive: true, leftAt: null }],
    venues: [],
  }
}

function liveSuperadmin() {
  return {
    active: true,
    organizations: [],
    venues: [{ id: 'staff-venue-superadmin', role: StaffRole.SUPERADMIN, active: true }],
  }
}

function activeEntitlement() {
  return {
    status: 'ACTIVE',
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: null,
  }
}

function activeModule() {
  return {
    active: true,
    scope: 'ORGANIZATION_ONLY',
    defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true },
    organizationModules: [{ enabled: true, config: {} }],
  }
}

function authorizeRead(context: AuthContext | null = authContext()) {
  return authorizeCatalogRequest({
    authContext: context,
    routeOrganizationId: ROUTE_ORGANIZATION_ID,
    capability: 'READ',
    requiredGate: 'CORE',
    prisma: db as never,
  })
}

function authorizeCommand(
  context: AuthContext | null = authContext(),
  commandCapability: 'MUTATE_CONTENT' | 'MANAGE_PROFILE' | 'CONFIGURE_CONTROL_PLANE' = 'MUTATE_CONTENT',
) {
  return authorizeCatalogRequest({
    authContext: context,
    routeOrganizationId: ROUTE_ORGANIZATION_ID,
    capability: 'COMMAND',
    commandCapability,
    requiredGate: 'CORE',
    prisma: db as never,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers().setSystemTime(NOW)
  organizationFindUnique.mockResolvedValue({ id: ROUTE_ORGANIZATION_ID })
  staffFindUnique.mockResolvedValue(liveStaff())
  entitlementFindUnique.mockResolvedValue(activeEntitlement())
  moduleFindUnique.mockResolvedValue(activeModule())
})

afterEach(() => jest.useRealTimers())

describe('authorizeCatalogRequest — route tenant and live role', () => {
  it('returns 401 before any database lookup when AuthContext is absent', async () => {
    await expect(authorizeRead(null)).rejects.toMatchObject({ statusCode: 401 })

    expect(organizationFindUnique).not.toHaveBeenCalled()
  })

  it('looks up the route organization before resolving access and returns 404 when it was deleted', async () => {
    organizationFindUnique.mockResolvedValue(null)

    await expect(authorizeRead()).rejects.toMatchObject({ statusCode: 404, message: 'Organización no encontrada' })

    expect(staffFindUnique).not.toHaveBeenCalled()
  })

  it('maps an organization lookup failure to 503 rather than an authorization denial', async () => {
    organizationFindUnique.mockRejectedValue(new Error('P1001 database unavailable'))

    await expect(authorizeRead()).rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' })
  })

  it('uses the route organization and effective user while ignoring stale JWT org, venue, and role claims', async () => {
    const result = await authorizeCommand(
      authContext({
        orgId: 'forged-token-org',
        venueId: 'forged-token-venue',
        role: StaffRole.VIEWER,
        realUserId: 'physical-superadmin-is-not-the-effective-member',
      }),
    )

    expect(result).toEqual({
      organizationId: ROUTE_ORGANIZATION_ID,
      actor: { type: 'HUMAN', staffId: STAFF_ID, impersonating: false },
      orgRole: OrgRole.OWNER,
    })
    expect(organizationFindUnique).toHaveBeenCalledWith({
      where: { id: ROUTE_ORGANIZATION_ID },
      select: { id: true },
    })
    expect(staffFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: STAFF_ID },
        select: expect.objectContaining({
          organizations: expect.objectContaining({
            where: { organizationId: ROUTE_ORGANIZATION_ID, isActive: true, leftAt: null },
          }),
        }),
      }),
    )
  })

  it.each([OrgRole.OWNER, OrgRole.ADMIN])('allows live %s membership to issue content commands', async role => {
    staffFindUnique.mockResolvedValue(liveStaff(role))

    await expect(authorizeCommand()).resolves.toMatchObject({ orgRole: role })
  })

  it('allows VIEWER to read but not issue commands', async () => {
    staffFindUnique.mockResolvedValue(liveStaff(OrgRole.VIEWER))

    await expect(authorizeRead()).resolves.toMatchObject({ orgRole: OrgRole.VIEWER })
    await expect(authorizeCommand()).rejects.toMatchObject({ statusCode: 403, code: 'ROLE_DENIED' })
  })

  it('denies MEMBER from both read and command access', async () => {
    staffFindUnique.mockResolvedValue(liveStaff(OrgRole.MEMBER))

    await expect(authorizeRead()).rejects.toMatchObject({ statusCode: 403, code: 'ROLE_DENIED' })
    await expect(authorizeCommand()).rejects.toMatchObject({ statusCode: 403, code: 'ROLE_DENIED' })
  })

  it.each([
    ['inactive Staff', { ...liveStaff(), active: false }],
    ['inactive membership', { ...liveStaff(), organizations: [{ role: OrgRole.OWNER, isActive: false, leftAt: null }] }],
    ['left membership', { ...liveStaff(), organizations: [{ role: OrgRole.OWNER, isActive: true, leftAt: NOW }] }],
    ['venue-only Staff', { ...liveStaff(), organizations: [] }],
  ])('denies %s even when the JWT still names the organization', async (_label, staff) => {
    staffFindUnique.mockResolvedValue(staff)

    await expect(authorizeRead()).rejects.toMatchObject({ statusCode: 403, code: 'ROLE_DENIED' })
  })

  it('keeps impersonation read-only under the effective organization membership', async () => {
    const impersonated = authContext({ isImpersonating: true, realUserId: 'staff-physical-superadmin' })

    await expect(authorizeRead(impersonated)).resolves.toMatchObject({
      actor: { type: 'HUMAN', staffId: STAFF_ID, impersonating: true },
    })
    await expect(authorizeCommand(impersonated)).rejects.toMatchObject({ statusCode: 403, code: 'ROLE_DENIED' })
  })

  it('allows only OWNER to manage validation profiles', async () => {
    staffFindUnique.mockResolvedValue(liveStaff(OrgRole.OWNER))
    await expect(authorizeCommand(authContext(), 'MANAGE_PROFILE')).resolves.toMatchObject({ orgRole: OrgRole.OWNER })

    staffFindUnique.mockResolvedValue(liveStaff(OrgRole.ADMIN))
    await expect(authorizeCommand(authContext(), 'MANAGE_PROFILE')).rejects.toMatchObject({
      statusCode: 403,
      code: 'ROLE_DENIED',
    })
  })

  it('does not grant SUPERADMIN implicit content access but permits explicit live control-plane bootstrap', async () => {
    staffFindUnique.mockResolvedValue(liveSuperadmin())
    entitlementFindUnique.mockResolvedValue(null)
    moduleFindUnique.mockResolvedValue(null)

    await expect(authorizeCommand()).rejects.toMatchObject({ statusCode: 403, code: 'ROLE_DENIED' })
    await expect(authorizeCommand(authContext(), 'CONFIGURE_CONTROL_PLANE')).resolves.toMatchObject({
      organizationId: ROUTE_ORGANIZATION_ID,
      actor: { type: 'HUMAN', staffId: STAFF_ID, impersonating: false },
    })
  })

  it('maps resolver dependency failure to 503 without leaking a misleading 403', async () => {
    moduleFindUnique.mockRejectedValue(new Error('P2024 pool timeout'))

    await expect(authorizeRead()).rejects.toMatchObject({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' })
  })

  it.each([
    ['missing entitlement', () => entitlementFindUnique.mockResolvedValue(null), 'ENTITLEMENT_MISSING'],
    [
      'disabled core gate',
      () =>
        moduleFindUnique.mockResolvedValue({
          ...activeModule(),
          defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: false },
        }),
      'GATE_DISABLED',
    ],
  ])('maps %s policy denial to 403 instead of 404/503', async (_label, arrange, reasonCode) => {
    arrange()

    await expect(authorizeRead()).rejects.toMatchObject({ statusCode: 403, code: reasonCode })
  })
})

describe('findCatalogTenantChildOrThrow — indistinguishable tenant-safe lookup', () => {
  it('uses one scoped id+organization lookup and returns an owned child', async () => {
    const findScoped = jest.fn().mockResolvedValue({ id: 'item-owned', organizationId: ROUTE_ORGANIZATION_ID })

    await expect(
      findCatalogTenantChildOrThrow({
        id: 'item-owned',
        organizationId: ROUTE_ORGANIZATION_ID,
        findScoped,
      }),
    ).resolves.toEqual({ id: 'item-owned', organizationId: ROUTE_ORGANIZATION_ID })
    expect(findScoped).toHaveBeenCalledWith({ id: 'item-owned', organizationId: ROUTE_ORGANIZATION_ID })
  })

  it.each(['item-missing', 'item-owned-by-another-org'])('returns the same 404 for %s', async id => {
    const findScoped = jest.fn().mockResolvedValue(null)

    await expect(findCatalogTenantChildOrThrow({ id, organizationId: ROUTE_ORGANIZATION_ID, findScoped })).rejects.toMatchObject({
      statusCode: 404,
      message: 'Recurso de catálogo no encontrado',
    })
  })

  it('maps child lookup infrastructure failure to 503 without exposing database details', async () => {
    const findScoped = jest.fn().mockRejectedValue(new Error('secret database host'))

    await expect(findCatalogTenantChildOrThrow({ id: 'item-1', organizationId: ROUTE_ORGANIZATION_ID, findScoped })).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
    })
  })
})
