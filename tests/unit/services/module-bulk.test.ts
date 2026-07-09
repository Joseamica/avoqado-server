const mockVenueModuleFindMany = jest.fn()
const mockVenueFindMany = jest.fn()
const mockOrgModuleFindMany = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueModule: { findMany: (...a: unknown[]) => mockVenueModuleFindMany(...(a as [])) },
    venue: { findMany: (...a: unknown[]) => mockVenueFindMany(...(a as [])) },
    organizationModule: { findMany: (...a: unknown[]) => mockOrgModuleFindMany(...(a as [])) },
  },
}))

import { moduleService } from '../../../src/services/modules/module.service'

beforeEach(() => jest.clearAllMocks())

describe('venuesWithModule — replicates isModuleEnabled precedence', () => {
  it('venue-level override OFF beats org-level ON (venue excluded)', async () => {
    mockVenueModuleFindMany.mockResolvedValue([{ venueId: 'v1', enabled: false }])
    mockVenueFindMany.mockResolvedValue([
      { id: 'v1', organizationId: 'o1' },
      { id: 'v2', organizationId: 'o1' },
    ])
    mockOrgModuleFindMany.mockResolvedValue([{ organizationId: 'o1' }])

    const set = await moduleService.venuesWithModule(['v1', 'v2'], 'SERIALIZED_INVENTORY')
    expect(set.has('v1')).toBe(false)
    expect(set.has('v2')).toBe(true)
    expect(await moduleService.anyVenueHasModule(['v1'], 'SERIALIZED_INVENTORY')).toBe(false)
    expect(await moduleService.anyVenueHasModule(['v1', 'v2'], 'SERIALIZED_INVENTORY')).toBe(true)
  })

  it('venue-level ON row wins even if org has no OrganizationModule', async () => {
    mockVenueModuleFindMany.mockResolvedValue([{ venueId: 'v1', enabled: true }])
    mockVenueFindMany.mockResolvedValue([{ id: 'v1', organizationId: 'o1' }])
    mockOrgModuleFindMany.mockResolvedValue([])
    const set = await moduleService.venuesWithModule(['v1'], 'SERIALIZED_INVENTORY')
    expect(set.has('v1')).toBe(true)
  })

  it('empty input → empty set / false, no queries', async () => {
    expect((await moduleService.venuesWithModule([], 'SERIALIZED_INVENTORY')).size).toBe(0)
    expect(await moduleService.anyVenueHasModule([], 'SERIALIZED_INVENTORY')).toBe(false)
    expect(mockVenueModuleFindMany).not.toHaveBeenCalled()
  })
})
