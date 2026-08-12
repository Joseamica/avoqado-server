const mockModuleUpsert = jest.fn()
const mockVenueModuleUpsert = jest.fn()
const mockQueryRaw = jest.fn()
const mockTransaction = jest.fn()

const transactionClient = {
  module: { upsert: (...args: unknown[]) => mockModuleUpsert(...(args as [])) },
  venueModule: { upsert: (...args: unknown[]) => mockVenueModuleUpsert(...(args as [])) },
  $queryRaw: (...args: unknown[]) => mockQueryRaw(...(args as [])),
}

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    // Exposing the old direct delegates makes the RED behavioral: only the
    // missing transaction/scope guard fails, not an artificial undefined mock.
    module: { upsert: (...args: unknown[]) => mockModuleUpsert(...(args as [])) },
    venueModule: { upsert: (...args: unknown[]) => mockVenueModuleUpsert(...(args as [])) },
    $transaction: (...args: unknown[]) => mockTransaction(...(args as [])),
  },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { getSalesGoals } from '@/services/dashboard/commission/sales-goal.service'

function moduleDefinition(scope: 'BOTH' | 'ORGANIZATION_ONLY') {
  return {
    id: 'module-commissions',
    code: 'COMMISSIONS',
    name: 'Commissions',
    description: 'Staff commission and sales goal tracking',
    scope,
    defaultConfig: {},
    presets: null,
    configSchema: null,
    active: true,
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    updatedAt: new Date('2026-08-08T00:00:00.000Z'),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockModuleUpsert.mockResolvedValue(moduleDefinition('BOTH'))
  mockQueryRaw.mockResolvedValue([moduleDefinition('BOTH')])
  mockVenueModuleUpsert.mockResolvedValue({
    id: 'venue-module-commissions',
    venueId: 'venue-1',
    moduleId: 'module-commissions',
    enabled: true,
    config: { salesGoals: [] },
  })
  mockTransaction.mockImplementation(async (callback: (tx: typeof transactionClient) => unknown) => callback(transactionClient))
})

describe('sales-goal COMMISSIONS assignment — scope-safe writer', () => {
  it('creates/preserves the VenueModule under the shared module lock in one transaction', async () => {
    const goals = await getSalesGoals('venue-1')

    expect(goals).toEqual([])
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockQueryRaw).toHaveBeenCalledTimes(1)
    expect(mockVenueModuleUpsert).toHaveBeenCalledWith({
      where: { venueId_moduleId: { venueId: 'venue-1', moduleId: 'module-commissions' } },
      update: {},
      create: {
        venueId: 'venue-1',
        moduleId: 'module-commissions',
        enabled: true,
        config: { salesGoals: [] },
        enabledBy: 'system',
      },
    })
  })

  it('revalidates locked scope and refuses a concurrent ORGANIZATION_ONLY transition loser', async () => {
    mockQueryRaw.mockResolvedValue([moduleDefinition('ORGANIZATION_ONLY')])

    await expect(getSalesGoals('venue-1')).rejects.toThrow(/ORGANIZATION_ONLY/i)

    expect(mockVenueModuleUpsert).not.toHaveBeenCalled()
  })
})
