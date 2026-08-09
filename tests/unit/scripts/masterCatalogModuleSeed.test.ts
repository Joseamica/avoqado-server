const mockModuleUpsert = jest.fn()
const mockModuleFindUnique = jest.fn()
const mockModuleCount = jest.fn()

const moduleDelegate = {
  upsert: (...args: unknown[]) => mockModuleUpsert(...(args as [])),
  findUnique: (...args: unknown[]) => mockModuleFindUnique(...(args as [])),
  count: (...args: unknown[]) => mockModuleCount(...(args as [])),
}

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    module: moduleDelegate,
    $transaction: (callback: (tx: { module: typeof moduleDelegate }) => unknown) => callback({ module: moduleDelegate }),
  },
}))

import { setupModules } from '@/../scripts/setup-modules'
import { MASTER_CATALOG_DEFAULT_CONFIG } from '@/types/master-catalog'

function materializeUpsert({ create }: any) {
  return {
    id: `module-${create.code.toLowerCase()}`,
    scope: create.scope ?? 'BOTH',
    active: true,
    ...create,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, 'log').mockImplementation(() => undefined)
  mockModuleUpsert.mockImplementation(async input => materializeUpsert(input))
  mockModuleFindUnique.mockResolvedValue(null)
  mockModuleCount.mockResolvedValue(6)
})

afterEach(() => jest.restoreAllMocks())

describe('setupModules — MASTER_CATALOG definition only', () => {
  it('stores the exact default-off v1 config as ORGANIZATION_ONLY without creating any assignment or grant', async () => {
    await setupModules()

    const masterCall = mockModuleUpsert.mock.calls.map(([input]) => input).find(input => input.where.code === 'MASTER_CATALOG')

    expect(masterCall).toEqual({
      where: { code: 'MASTER_CATALOG' },
      create: {
        code: 'MASTER_CATALOG',
        name: expect.any(String),
        description: expect.any(String),
        scope: 'ORGANIZATION_ONLY',
        defaultConfig: MASTER_CATALOG_DEFAULT_CONFIG,
        presets: {},
        configSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['schemaVersion', 'catalogCoreEnabled', 'identifiersEnabled', 'regionalPricingEnabled', 'governanceMode'],
          properties: {
            schemaVersion: { const: 1 },
            catalogCoreEnabled: { type: 'boolean' },
            identifiersEnabled: { type: 'boolean' },
            regionalPricingEnabled: { type: 'boolean' },
            governanceMode: { enum: ['OFF', 'ADVISORY', 'ENFORCED'] },
          },
        },
      },
      update: {
        name: expect.any(String),
        description: expect.any(String),
        defaultConfig: MASTER_CATALOG_DEFAULT_CONFIG,
        presets: {},
        configSchema: expect.any(Object),
      },
    })
    // The Prisma boundary cast must neither clone nor normalize the frozen
    // default-off config used by the resolver and later tasks.
    expect(masterCall.create.defaultConfig).toBe(MASTER_CATALOG_DEFAULT_CONFIG)
    expect(masterCall.update.defaultConfig).toBe(MASTER_CATALOG_DEFAULT_CONFIG)

    // The production seed mock intentionally exposes no entitlement or assignment delegates:
    // completing proves setup only touched Module definitions and kept rollout default-off.
    expect(mockModuleCount).toHaveBeenCalledTimes(1)
  })

  it('preserves BOTH as the database-compatible scope for all pre-existing module definitions', async () => {
    await setupModules()

    const createInputs = mockModuleUpsert.mock.calls.map(([input]) => input.create).filter(create => create.code !== 'MASTER_CATALOG')

    expect(createInputs.length).toBeGreaterThan(0)
    expect(createInputs.every(create => create.scope === undefined || create.scope === 'BOTH')).toBe(true)
  })

  it('reports an existing conflicting scope instead of silently rewriting it', async () => {
    mockModuleFindUnique.mockResolvedValue({ id: 'module-existing', code: 'MASTER_CATALOG', scope: 'BOTH' })

    await expect(setupModules()).rejects.toThrow(/MASTER_CATALOG.*scope.*BOTH.*ORGANIZATION_ONLY/i)

    const masterCall = mockModuleUpsert.mock.calls.map(([input]) => input).find(input => input.where.code === 'MASTER_CATALOG')
    expect(masterCall).toBeUndefined()
  })
})
