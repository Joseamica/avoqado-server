import { ModuleService } from '@/services/modules/module.service'

type Scope = 'BOTH' | 'ORGANIZATION_ONLY' | 'VENUE_ONLY'

function scopeAllows(condition: any, scope: Scope): boolean {
  if (!condition) return true
  if (typeof condition === 'string') return condition === scope
  if (Array.isArray(condition.in)) return condition.in.includes(scope)
  if (Array.isArray(condition.notIn)) return !condition.notIn.includes(scope)
  if (typeof condition.not === 'string') return condition.not !== scope
  return true
}

function moduleDefinition(scope: Scope, overrides: Record<string, unknown> = {}) {
  return {
    id: `module-${scope}`,
    code: scope === 'ORGANIZATION_ONLY' ? 'MASTER_CATALOG' : 'SERIALIZED_INVENTORY',
    name: 'Module test',
    description: null,
    scope,
    defaultConfig: { label: 'base' },
    presets: null,
    configSchema: null,
    active: true,
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    updatedAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides,
  }
}

function buildDb() {
  let lockedModule = moduleDefinition('BOTH')

  const db: any = {
    module: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(async ({ data }: any) => ({ id: 'module-created', scope: data.scope ?? 'BOTH', ...data })),
    },
    venue: {
      findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
      findMany: jest.fn().mockResolvedValue([{ id: 'venue-1', organizationId: 'org-1' }]),
    },
    venueModule: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(async ({ create }: any) => ({ id: 'venue-module-1', ...create })),
      update: jest.fn(async ({ data }: any) => ({ id: 'venue-module-1', ...data })),
    },
    organizationModule: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(async ({ create }: any) => ({ id: 'organization-module-1', ...create })),
      update: jest.fn(async ({ data }: any) => ({ id: 'organization-module-1', ...data })),
    },
    $queryRaw: jest.fn(async () => [lockedModule]),
    $transaction: jest.fn(async (callback: (tx: any) => unknown) => callback(db)),
    setLockedModule(module: ReturnType<typeof moduleDefinition>) {
      lockedModule = module
    },
  }

  return db
}

describe('ModuleService — venue scope isolation', () => {
  it('keeps a disabled venue override authoritative over an enabled organization module', async () => {
    const db = buildDb()
    db.venueModule.findMany.mockResolvedValue([{ venueId: 'venue-1', enabled: false }])
    db.organizationModule.findMany.mockResolvedValue([{ organizationId: 'org-1' }])
    const service = new ModuleService(db)

    expect((await service.venuesWithModule(['venue-1'], 'SERIALIZED_INVENTORY')).has('venue-1')).toBe(false)
    expect(await service.anyVenueHasModule(['venue-1'], 'SERIALIZED_INVENTORY')).toBe(false)
  })

  it.each(['BOTH', 'VENUE_ONLY'] as const)('keeps a direct %s VenueModule assignment available to venue callers', async scope => {
    const db = buildDb()
    db.venueModule.findFirst.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, scope) ? { enabled: true } : null,
    )
    const service = new ModuleService(db)

    expect(await service.isModuleEnabled('venue-1', 'SERIALIZED_INVENTORY')).toBe(true)
  })

  it('does not inherit a stale VENUE_ONLY OrganizationModule in scalar or bulk venue reads', async () => {
    const db = buildDb()
    db.venueModule.findFirst.mockResolvedValue(null)
    db.venueModule.findMany.mockResolvedValue([])
    db.organizationModule.findFirst.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'VENUE_ONLY') ? { enabled: true } : null,
    )
    db.organizationModule.findMany.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'VENUE_ONLY') ? [{ organizationId: 'org-1' }] : [],
    )
    const service = new ModuleService(db)

    expect(await service.isModuleEnabled('venue-1', 'SERIALIZED_INVENTORY')).toBe(false)
    expect((await service.venuesWithModule(['venue-1'], 'SERIALIZED_INVENTORY')).size).toBe(0)
    expect(await service.anyVenueHasModule(['venue-1'], 'SERIALIZED_INVENTORY')).toBe(false)
  })

  it('returns false for ORGANIZATION_ONLY even if a forbidden VenueModule row exists', async () => {
    const db = buildDb()
    db.venueModule.findFirst.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'ORGANIZATION_ONLY') ? { enabled: true } : null,
    )
    db.organizationModule.findFirst.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'ORGANIZATION_ONLY') ? { enabled: true } : null,
    )
    const service = new ModuleService(db)

    expect(await service.isModuleEnabled('venue-1', 'MASTER_CATALOG')).toBe(false)
  })

  it('bulk venue resolution excludes ORGANIZATION_ONLY at both explicit and inherited levels', async () => {
    const db = buildDb()
    db.venueModule.findMany.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'ORGANIZATION_ONLY') ? [{ venueId: 'venue-1', enabled: true }] : [],
    )
    db.organizationModule.findMany.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'ORGANIZATION_ONLY') ? [{ organizationId: 'org-1' }] : [],
    )
    const service = new ModuleService(db)

    expect((await service.venuesWithModule(['venue-1'], 'MASTER_CATALOG')).size).toBe(0)
    expect(await service.anyVenueHasModule(['venue-1'], 'MASTER_CATALOG')).toBe(false)
  })

  it('empty bulk input remains query-free', async () => {
    const db = buildDb()
    const service = new ModuleService(db)

    expect((await service.venuesWithModule([], 'SERIALIZED_INVENTORY')).size).toBe(0)
    expect(await service.anyVenueHasModule([], 'SERIALIZED_INVENTORY')).toBe(false)
    expect(db.venueModule.findMany).not.toHaveBeenCalled()
  })

  it('returns null config for ORGANIZATION_ONLY instead of leaking its defaults into a venue', async () => {
    const db = buildDb()
    db.module.findFirst.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.scope, 'ORGANIZATION_ONLY') ? moduleDefinition('ORGANIZATION_ONLY') : null,
    )
    db.venueModule.findFirst.mockResolvedValue({ enabled: true, config: { label: 'venue' } })
    db.organizationModule.findFirst.mockResolvedValue({ enabled: true, config: { label: 'organization' } })
    const service = new ModuleService(db)

    expect(await service.getModuleConfig('venue-1', 'MASTER_CATALOG')).toBeNull()
  })

  it('does not use a stale VENUE_ONLY OrganizationModule as venue config', async () => {
    const db = buildDb()
    db.module.findFirst.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.scope, 'VENUE_ONLY') ? moduleDefinition('VENUE_ONLY') : null,
    )
    db.venueModule.findFirst.mockResolvedValue(null)
    db.organizationModule.findFirst.mockResolvedValue({ enabled: true, config: { label: 'stale-organization' } })
    const service = new ModuleService(db)

    expect(await service.getModuleConfig('venue-1', 'SERIALIZED_INVENTORY')).toBeNull()
  })

  it('excludes ORGANIZATION_ONLY from the TPV enabled module payload', async () => {
    const db = buildDb()
    const forbidden = moduleDefinition('ORGANIZATION_ONLY')
    db.venueModule.findMany.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'ORGANIZATION_ONLY') ? [{ module: forbidden, config: {}, enabled: true }] : [],
    )
    db.organizationModule.findMany.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'ORGANIZATION_ONLY') ? [{ module: forbidden, config: {}, enabled: true }] : [],
    )
    const service = new ModuleService(db)

    expect(await service.getEnabledModules('venue-1')).toEqual([])
    expect(await service.getEnabledModuleCodes('venue-1')).toEqual([])
  })

  it('excludes a stale VENUE_ONLY OrganizationModule from TPV module payloads', async () => {
    const db = buildDb()
    const forbiddenInheritance = moduleDefinition('VENUE_ONLY')
    db.venueModule.findMany.mockResolvedValue([])
    db.organizationModule.findMany.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'VENUE_ONLY')
        ? [{ module: forbiddenInheritance, config: {}, enabled: true, organizationId: 'org-1' }]
        : [],
    )
    const service = new ModuleService(db)

    expect(await service.getEnabledModules('venue-1')).toEqual([])
    expect(await service.getEnabledModuleCodes('venue-1')).toEqual([])
  })

  it.each(['enableModule', 'disableModule', 'updateModuleConfig'] as const)(
    '%s rejects an ORGANIZATION_ONLY module instead of writing a VenueModule',
    async method => {
      const db = buildDb()
      db.setLockedModule(moduleDefinition('ORGANIZATION_ONLY'))
      db.module.findUnique.mockResolvedValue(moduleDefinition('ORGANIZATION_ONLY'))
      db.venueModule.findUnique.mockResolvedValue({ id: 'venue-module-1' })
      const service = new ModuleService(db)

      const operation =
        method === 'enableModule'
          ? service.enableModule('venue-1', 'MASTER_CATALOG', 'staff-1')
          : method === 'disableModule'
            ? service.disableModule('venue-1', 'MASTER_CATALOG')
            : service.updateModuleConfig('venue-1', 'MASTER_CATALOG', {})

      await expect(operation).rejects.toThrow(/organization/i)
      expect(db.venueModule.upsert).not.toHaveBeenCalled()
      expect(db.venueModule.update).not.toHaveBeenCalled()
    },
  )
})

describe('ModuleService — organization scope isolation', () => {
  it('keeps ORGANIZATION_ONLY available to organization reads', async () => {
    const db = buildDb()
    const allowed = moduleDefinition('ORGANIZATION_ONLY')
    db.organizationModule.findFirst.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'ORGANIZATION_ONLY') ? { enabled: true } : null,
    )
    db.organizationModule.findMany.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'ORGANIZATION_ONLY') ? [{ module: allowed, config: {}, enabled: true }] : [],
    )
    const service = new ModuleService(db)

    expect(await service.isModuleEnabledForOrganization('org-1', 'MASTER_CATALOG')).toBe(true)
    expect(await service.getOrganizationModules('org-1')).toEqual([
      { code: 'MASTER_CATALOG', scope: 'ORGANIZATION_ONLY', config: { label: 'base' }, enabled: true },
    ])
  })

  it('excludes VENUE_ONLY from organization reads', async () => {
    const db = buildDb()
    const forbidden = moduleDefinition('VENUE_ONLY')
    db.organizationModule.findFirst.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'VENUE_ONLY') ? { enabled: true } : null,
    )
    db.organizationModule.findMany.mockImplementation(async ({ where }: any) =>
      scopeAllows(where.module?.scope, 'VENUE_ONLY') ? [{ module: forbidden, config: {}, enabled: true }] : [],
    )
    const service = new ModuleService(db)

    expect(await service.isModuleEnabledForOrganization('org-1', 'SERIALIZED_INVENTORY')).toBe(false)
    expect(await service.getOrganizationModules('org-1')).toEqual([])
  })

  it.each(['enableModuleForOrganization', 'disableModuleForOrganization', 'updateOrganizationModuleConfig'] as const)(
    '%s rejects a VENUE_ONLY module instead of writing an OrganizationModule',
    async method => {
      const db = buildDb()
      db.setLockedModule(moduleDefinition('VENUE_ONLY'))
      db.module.findUnique.mockResolvedValue(moduleDefinition('VENUE_ONLY'))
      db.organizationModule.findUnique.mockResolvedValue({ id: 'organization-module-1' })
      const service = new ModuleService(db)

      const operation =
        method === 'enableModuleForOrganization'
          ? service.enableModuleForOrganization('org-1', 'SERIALIZED_INVENTORY', 'staff-1')
          : method === 'disableModuleForOrganization'
            ? service.disableModuleForOrganization('org-1', 'SERIALIZED_INVENTORY')
            : service.updateOrganizationModuleConfig('org-1', 'SERIALIZED_INVENTORY', {})

      await expect(operation).rejects.toThrow(/venue/i)
      expect(db.organizationModule.upsert).not.toHaveBeenCalled()
      expect(db.organizationModule.update).not.toHaveBeenCalled()
    },
  )
})

describe('ModuleService — additive module definition contract', () => {
  it('defaults existing create callers to BOTH while allowing an explicit scope', async () => {
    const db = buildDb()
    const service = new ModuleService(db)

    const legacy = await service.createModule({ code: 'LEGACY_MODULE', name: 'Legacy', defaultConfig: {} })
    const organizationOnly = await service.createModule({
      code: 'MASTER_CATALOG',
      name: 'Master catalog',
      defaultConfig: {},
      scope: 'ORGANIZATION_ONLY',
    })

    expect(legacy.scope).toBe('BOTH')
    expect(organizationOnly.scope).toBe('ORGANIZATION_ONLY')
  })

  it('locks and revalidates BOTH before creating a venue assignment', async () => {
    const db = buildDb()
    db.setLockedModule(moduleDefinition('BOTH'))
    const service = new ModuleService(db)

    const assignment = await service.enableModule('venue-1', 'SERIALIZED_INVENTORY', 'staff-1')

    expect(assignment.enabled).toBe(true)
    expect(db.$queryRaw).toHaveBeenCalled()
  })

  it('locks and revalidates BOTH before creating an organization assignment', async () => {
    const db = buildDb()
    db.setLockedModule(moduleDefinition('BOTH'))
    const service = new ModuleService(db)

    const assignment = await service.enableModuleForOrganization('org-1', 'SERIALIZED_INVENTORY', 'staff-1')

    expect(assignment.enabled).toBe(true)
    expect(db.$queryRaw).toHaveBeenCalled()
  })
})
