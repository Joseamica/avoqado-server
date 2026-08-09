const mockStaffFindUnique = jest.fn()
const mockEntitlementFindUnique = jest.fn()
const mockModuleFindUnique = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: (...args: unknown[]) => mockStaffFindUnique(...(args as [])) },
    organizationEntitlement: { findUnique: (...args: unknown[]) => mockEntitlementFindUnique(...(args as [])) },
    module: { findUnique: (...args: unknown[]) => mockModuleFindUnique(...(args as [])) },
  },
}))

import { masterCatalogAccessHttpStatus, resolveMasterCatalogAccess } from '@/services/master-catalog/masterCatalogAccess.service'
import { MASTER_CATALOG_DEFAULT_CONFIG, type CatalogActor } from '@/types/master-catalog'

const NOW = new Date('2026-08-08T18:00:00.000Z')
const ORGANIZATION_ID = 'org-pits'

const human = (overrides: Partial<Extract<CatalogActor, { type: 'HUMAN' }>> = {}): CatalogActor => ({
  type: 'HUMAN',
  staffId: 'staff-owner',
  impersonating: false,
  ...overrides,
})

const service = (servicePrincipalId = 'catalog-publication-worker'): CatalogActor => ({
  type: 'SERVICE',
  servicePrincipalId,
})

function activeStaff(role: 'OWNER' | 'ADMIN' | 'VIEWER' | 'MEMBER' = 'OWNER') {
  return {
    active: true,
    organizations: [{ role, isActive: true, leftAt: null }],
    venues: [],
  }
}

function activeSuperadmin() {
  return {
    active: true,
    organizations: [],
    venues: [{ id: 'staff-venue-superadmin', role: 'SUPERADMIN', active: true }],
  }
}

function activeEntitlement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entitlement-1',
    organizationId: ORGANIZATION_ID,
    featureCode: 'MASTER_CATALOG',
    status: 'ACTIVE',
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: null,
    ...overrides,
  }
}

function activeModule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'module-master-catalog',
    code: 'MASTER_CATALOG',
    active: true,
    scope: 'ORGANIZATION_ONLY',
    defaultConfig: MASTER_CATALOG_DEFAULT_CONFIG,
    organizationModules: [{ id: 'org-module-1', enabled: true, config: {} }],
    ...overrides,
  }
}

async function resolve(overrides: Partial<Parameters<typeof resolveMasterCatalogAccess>[0]> = {}) {
  return resolveMasterCatalogAccess({
    organizationId: ORGANIZATION_ID,
    principal: human(),
    capability: 'READ_CONTENT',
    requiredGate: 'CORE',
    ...overrides,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers().setSystemTime(NOW)
  mockStaffFindUnique.mockResolvedValue(activeStaff())
  mockEntitlementFindUnique.mockResolvedValue(activeEntitlement())
  mockModuleFindUnique.mockResolvedValue(
    activeModule({
      defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true },
    }),
  )
})

afterEach(() => jest.useRealTimers())

describe('resolveMasterCatalogAccess — explicit commercial and rollout gates', () => {
  it('grants a current entitlement plus active organization rollout and CORE config', async () => {
    const access = await resolve()

    expect(access).toEqual({
      organizationId: ORGANIZATION_ID,
      orgRole: 'OWNER',
      entitlementActive: true,
      moduleActive: true,
      config: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true },
      reasonCode: 'ACCESSIBLE',
      canRead: true,
      canMutateContent: false,
      canConfigureControlPlane: false,
    })
  })

  it.each([
    ['missing', null, 'ENTITLEMENT_MISSING'],
    ['revoked', activeEntitlement({ status: 'REVOKED' }), 'ENTITLEMENT_INACTIVE'],
    ['not started', activeEntitlement({ startsAt: new Date(NOW.getTime() + 1) }), 'ENTITLEMENT_INACTIVE'],
    ['expired exactly now', activeEntitlement({ endsAt: NOW }), 'ENTITLEMENT_INACTIVE'],
  ])('fails closed for a %s entitlement', async (_label, entitlement, reasonCode) => {
    mockEntitlementFindUnique.mockResolvedValue(entitlement)

    const access = await resolve()

    expect(access.reasonCode).toBe(reasonCode)
    expect(access.canRead).toBe(false)
    expect(access.canMutateContent).toBe(false)
  })

  it.each([
    ['starts exactly now', { startsAt: NOW, endsAt: null }],
    ['ends one millisecond later', { endsAt: new Date(NOW.getTime() + 1) }],
  ])('treats the entitlement as current when it %s', async (_label, dates) => {
    mockEntitlementFindUnique.mockResolvedValue(activeEntitlement(dates))

    expect((await resolve()).reasonCode).toBe('ACCESSIBLE')
  })

  it.each([
    ['definition is missing', null, 'MODULE_MISSING'],
    ['organization assignment is missing', activeModule({ organizationModules: [] }), 'MODULE_MISSING'],
    ['definition is inactive', activeModule({ active: false }), 'MODULE_INACTIVE'],
    ['definition is BOTH-scoped', activeModule({ scope: 'BOTH' }), 'MODULE_INACTIVE'],
    ['definition is VENUE_ONLY', activeModule({ scope: 'VENUE_ONLY' }), 'MODULE_INACTIVE'],
    ['organization assignment is inactive', activeModule({ organizationModules: [{ enabled: false, config: {} }] }), 'MODULE_INACTIVE'],
  ])('fails closed when the module %s', async (_label, moduleDefinition, reasonCode) => {
    mockModuleFindUnique.mockResolvedValue(moduleDefinition)

    const access = await resolve()

    expect(access.reasonCode).toBe(reasonCode)
    expect(access.canRead).toBe(false)
  })

  it.each([
    ['has no effective config', activeModule({ defaultConfig: null }), 'CONFIG_MISSING'],
    [
      'has an unknown schema version',
      activeModule({ defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, schemaVersion: 2 } }),
      'CONFIG_INVALID',
    ],
    ['stores malformed JSON', activeModule({ defaultConfig: ['not-an-object'] }), 'CONFIG_INVALID'],
    [
      'contains an unknown field',
      activeModule({ defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true, surprise: true } }),
      'CONFIG_INVALID',
    ],
  ])('fails closed when it %s', async (_label, moduleDefinition, reasonCode) => {
    mockModuleFindUnique.mockResolvedValue(moduleDefinition)

    const access = await resolve()

    expect(access.reasonCode).toBe(reasonCode)
    expect(access.config).toBeNull()
  })

  it.each([
    ['CORE', { catalogCoreEnabled: false, identifiersEnabled: true, regionalPricingEnabled: true }],
    ['IDENTIFIERS', { catalogCoreEnabled: true, identifiersEnabled: false, regionalPricingEnabled: true }],
    ['IDENTIFIERS', { catalogCoreEnabled: false, identifiersEnabled: true, regionalPricingEnabled: true }],
    ['REGIONAL_PRICING', { catalogCoreEnabled: true, identifiersEnabled: true, regionalPricingEnabled: false }],
    ['REGIONAL_PRICING', { catalogCoreEnabled: false, identifiersEnabled: true, regionalPricingEnabled: true }],
  ] as const)('returns GATE_DISABLED when %s does not have its complete dependency chain', async (requiredGate, gates) => {
    mockModuleFindUnique.mockResolvedValue(activeModule({ defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, ...gates } }))

    const access = await resolve({ requiredGate })

    expect(access.reasonCode).toBe('GATE_DISABLED')
    expect(access.canRead).toBe(false)
  })

  it.each([
    ['CORE', { catalogCoreEnabled: true, identifiersEnabled: false, regionalPricingEnabled: false }],
    ['IDENTIFIERS', { catalogCoreEnabled: true, identifiersEnabled: true, regionalPricingEnabled: false }],
    ['REGIONAL_PRICING', { catalogCoreEnabled: true, identifiersEnabled: false, regionalPricingEnabled: true }],
  ] as const)('grants %s only when its explicit flags are enabled', async (requiredGate, gates) => {
    mockModuleFindUnique.mockResolvedValue(activeModule({ defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, ...gates } }))

    expect((await resolve({ requiredGate })).reasonCode).toBe('ACCESSIBLE')
  })

  it.each([null, undefined])('inherits a valid module default when the organization override is %s', async config => {
    mockModuleFindUnique.mockResolvedValue(
      activeModule({
        defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true },
        organizationModules: [{ id: 'org-module-1', enabled: true, config }],
      }),
    )

    const access = await resolve()

    expect(access.reasonCode).toBe('ACCESSIBLE')
    expect(access.config).toEqual({ ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true })
  })

  it('merges a valid partial organization override over the v1 default', async () => {
    mockModuleFindUnique.mockResolvedValue(
      activeModule({
        defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true },
        organizationModules: [{ id: 'org-module-1', enabled: true, config: { identifiersEnabled: true } }],
      }),
    )

    const access = await resolve({ requiredGate: 'IDENTIFIERS' })

    expect(access.reasonCode).toBe('ACCESSIBLE')
    expect(access.config).toEqual({
      ...MASTER_CATALOG_DEFAULT_CONFIG,
      catalogCoreEnabled: true,
      identifiersEnabled: true,
    })
  })

  it.each([
    ['an array', []],
    ['a string', 'invalid'],
    ['an unknown field', { surprise: true }],
    ['an unknown schema version', { schemaVersion: 2 }],
    ['a wrong primitive type', { catalogCoreEnabled: 'yes' }],
  ])('rejects %s organization override rather than normalizing it away', async (_label, config) => {
    mockModuleFindUnique.mockResolvedValue(
      activeModule({
        defaultConfig: { ...MASTER_CATALOG_DEFAULT_CONFIG, catalogCoreEnabled: true },
        organizationModules: [{ id: 'org-module-1', enabled: true, config }],
      }),
    )

    const access = await resolve()

    expect(access.reasonCode).toBe('CONFIG_INVALID')
    expect(access.config).toBeNull()
  })

  it('does not consult venue or tier inheritance to manufacture MASTER_CATALOG access', async () => {
    const db = {
      staff: { findUnique: mockStaffFindUnique },
      organizationEntitlement: { findUnique: mockEntitlementFindUnique },
      module: { findUnique: mockModuleFindUnique },
      get venueFeature(): never {
        throw new Error('VenueFeature must not grant organization access')
      },
      get venueModule(): never {
        throw new Error('VenueModule must not grant organization access')
      },
      get feature(): never {
        throw new Error('Paid tier/demo/grandfathering must not grant organization access')
      },
    }

    const access = await resolve({ prisma: db as never })

    expect(access.reasonCode).toBe('ACCESSIBLE')
  })
})

describe('resolveMasterCatalogAccess — live principals and capabilities', () => {
  it.each([
    ['inactive Staff', { ...activeStaff(), active: false }],
    ['inactive membership', { ...activeStaff(), organizations: [{ role: 'OWNER', isActive: false, leftAt: null }] }],
    ['left membership', { ...activeStaff(), organizations: [{ role: 'OWNER', isActive: true, leftAt: NOW }] }],
    ['missing membership', { ...activeStaff(), organizations: [] }],
  ])('denies an %s from content', async (_label, staff) => {
    mockStaffFindUnique.mockResolvedValue(staff)

    const access = await resolve()

    expect(access.reasonCode).toBe('ROLE_DENIED')
    expect(access.canRead).toBe(false)
  })

  it.each(['OWNER', 'ADMIN', 'VIEWER'] as const)('allows %s to read when all explicit gates pass', async role => {
    mockStaffFindUnique.mockResolvedValue(activeStaff(role))

    const access = await resolve()

    expect(access.reasonCode).toBe('ACCESSIBLE')
    expect(access.canRead).toBe(true)
    expect(access.orgRole).toBe(role)
  })

  it.each(['OWNER', 'ADMIN'] as const)('allows %s to mutate content when not impersonating', async role => {
    mockStaffFindUnique.mockResolvedValue(activeStaff(role))

    const access = await resolve({ capability: 'MUTATE_CONTENT' })

    expect(access.reasonCode).toBe('ACCESSIBLE')
    expect(access.canMutateContent).toBe(true)
  })

  it('allows only a non-impersonating OWNER to manage profiles', async () => {
    mockStaffFindUnique.mockResolvedValue(activeStaff('OWNER'))
    const owner = await resolve({ capability: 'MANAGE_PROFILE' })

    mockStaffFindUnique.mockResolvedValue(activeStaff('ADMIN'))
    const admin = await resolve({ capability: 'MANAGE_PROFILE' })

    mockStaffFindUnique.mockResolvedValue(activeStaff('OWNER'))
    const impersonatedOwner = await resolve({ principal: human({ impersonating: true }), capability: 'MANAGE_PROFILE' })

    expect(owner.reasonCode).toBe('ACCESSIBLE')
    expect(owner.canMutateContent).toBe(true)
    expect(admin.reasonCode).toBe('ROLE_DENIED')
    expect(impersonatedOwner.reasonCode).toBe('ROLE_DENIED')
  })

  it.each([
    ['VIEWER', human()],
    ['MEMBER', human()],
    ['OWNER', human({ impersonating: true })],
  ] as const)('denies %s from mutating content in the supplied principal state', async (role, principal) => {
    mockStaffFindUnique.mockResolvedValue(activeStaff(role))

    const access = await resolve({ principal, capability: 'MUTATE_CONTENT' })

    expect(access.reasonCode).toBe('ROLE_DENIED')
    expect(access.canMutateContent).toBe(false)
  })

  it('keeps impersonation read-only when the effective membership may read', async () => {
    const access = await resolve({ principal: human({ impersonating: true }), capability: 'READ_CONTENT' })

    expect(access.reasonCode).toBe('ACCESSIBLE')
    expect(access.canRead).toBe(true)
    expect(access.canMutateContent).toBe(false)
  })

  it('allows only an explicit SERVICE principal to run service jobs', async () => {
    const serviceAccess = await resolve({ principal: service(), capability: 'RUN_SERVICE_JOB' })
    const humanAccess = await resolve({ capability: 'RUN_SERVICE_JOB' })
    const serviceRead = await resolve({ principal: service(), capability: 'READ_CONTENT' })

    expect(serviceAccess.reasonCode).toBe('ACCESSIBLE')
    expect(serviceAccess.canMutateContent).toBe(true)
    expect(humanAccess.reasonCode).toBe('ROLE_DENIED')
    expect(serviceRead.reasonCode).toBe('ROLE_DENIED')
  })

  it.each(['', '   '])('rejects an empty SERVICE principal id (%j)', async servicePrincipalId => {
    const access = await resolve({ principal: service(servicePrincipalId), capability: 'RUN_SERVICE_JOB' })

    expect(access.reasonCode).toBe('ROLE_DENIED')
    expect(access.canMutateContent).toBe(false)
  })

  it('lets a live non-impersonating SUPERADMIN inspect bootstrap state without manufacturing content access', async () => {
    mockStaffFindUnique.mockResolvedValue(activeSuperadmin())
    mockEntitlementFindUnique.mockResolvedValue(null)
    mockModuleFindUnique.mockResolvedValue(activeModule())

    const access = await resolve({ capability: 'CONFIGURE_CONTROL_PLANE' })

    expect(access.reasonCode).toBe('ENTITLEMENT_MISSING')
    expect(access.moduleActive).toBe(true)
    expect(access.config).toEqual(MASTER_CATALOG_DEFAULT_CONFIG)
    expect(access.canConfigureControlPlane).toBe(true)
    expect(access.canRead).toBe(false)
    expect(access.canMutateContent).toBe(false)
    expect(masterCatalogAccessHttpStatus(access)).toBe(200)
  })

  it.each([
    ['inactive Staff', { ...activeSuperadmin(), active: false }, human()],
    ['no live SUPERADMIN assignment', activeStaff('OWNER'), human()],
    ['impersonation session', activeSuperadmin(), human({ impersonating: true })],
  ])('denies control-plane bootstrap for an %s', async (_label, staff, principal) => {
    mockStaffFindUnique.mockResolvedValue(staff)

    const access = await resolve({ principal, capability: 'CONFIGURE_CONTROL_PLANE' })

    expect(access.reasonCode).toBe('ROLE_DENIED')
    expect(access.canConfigureControlPlane).toBe(false)
  })

  it('does not give a SUPERADMIN implicit organization content access', async () => {
    mockStaffFindUnique.mockResolvedValue(activeSuperadmin())

    const access = await resolve({ capability: 'MUTATE_CONTENT' })

    expect(access.reasonCode).toBe('ROLE_DENIED')
    expect(access.canMutateContent).toBe(false)
  })

  it('does not leak entitlement state when the HUMAN principal is role-denied', async () => {
    mockStaffFindUnique.mockResolvedValue(activeStaff('MEMBER'))
    mockEntitlementFindUnique.mockResolvedValue(null)

    const access = await resolve()

    expect(access.reasonCode).toBe('ROLE_DENIED')
  })
})

describe('resolveMasterCatalogAccess — dependency failures', () => {
  it('reports DEPENDENCY_UNAVAILABLE and maps it to 503 instead of disguising it as authorization', async () => {
    mockEntitlementFindUnique.mockRejectedValue(new Error('P1001 database unavailable'))

    const access = await resolve()

    expect(access.reasonCode).toBe('DEPENDENCY_UNAVAILABLE')
    expect(access.canRead).toBe(false)
    expect(access.canMutateContent).toBe(false)
    expect(access.canConfigureControlPlane).toBe(false)
    expect(masterCatalogAccessHttpStatus(access)).toBe(503)
  })

  it('also maps a failed control-plane state inspection to 503', async () => {
    mockStaffFindUnique.mockResolvedValue(activeSuperadmin())
    mockModuleFindUnique.mockRejectedValue(new Error('P2024 pool timeout'))

    const access = await resolve({ capability: 'CONFIGURE_CONTROL_PLANE' })

    expect(access.reasonCode).toBe('DEPENDENCY_UNAVAILABLE')
    expect(access.canConfigureControlPlane).toBe(false)
    expect(masterCatalogAccessHttpStatus(access)).toBe(503)
  })
})
