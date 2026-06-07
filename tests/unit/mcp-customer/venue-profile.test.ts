import { registerVenueTools } from '../../../src/mcp/tools/venues'
import type { McpScope } from '../../../src/mcp/scope'

const mockVenueFind = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findMany: jest.fn(), findFirst: (...a: unknown[]) => mockVenueFind(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('venue_profile')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerVenueTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('venue_profile', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockVenueFind).not.toHaveBeenCalled()
  })

  it('returns the safe profile (no fiscal/KYC/credentials) for an in-scope venue', async () => {
    mockVenueFind.mockResolvedValueOnce({
      name: 'Avoqado Centro',
      slug: 'avoqado-centro',
      type: 'RESTAURANT',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      language: 'es',
      active: true,
      address: 'Av. Reforma 100',
      city: 'CDMX',
      state: 'CDMX',
      country: 'MX',
      zipCode: '06600',
      phone: '5555555555',
      email: 'hola@centro.mx',
      website: 'https://centro.mx',
    })
    const out = parse(await call({ venueId: 'v1' }))

    expect(out.found).toBe(true)
    expect(out.profile).toMatchObject({
      name: 'Avoqado Centro',
      type: 'RESTAURANT',
      currency: 'MXN',
      timezone: 'America/Mexico_City',
      address: { line: 'Av. Reforma 100', city: 'CDMX', zip: '06600' },
      contact: { phone: '5555555555', email: 'hola@centro.mx', website: 'https://centro.mx' },
    })
    // only id queried, by primary key
    expect((mockVenueFind.mock.calls[0][0] as { where: Record<string, unknown> }).where).toEqual({ id: 'v1' })
  })

  it('returns found:false when the venue row is missing', async () => {
    mockVenueFind.mockResolvedValueOnce(null)
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.found).toBe(false)
  })
})
