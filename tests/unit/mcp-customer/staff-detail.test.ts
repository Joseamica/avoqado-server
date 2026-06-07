import { registerStaffTools } from '../../../src/mcp/tools/staff'
import type { McpScope } from '../../../src/mcp/scope'

const mockStaffVenueFind = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return v ? { venueId: { in: [v] } } : { venueId: { in: ['v1', 'v2'] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staffVenue: { findMany: (...a: unknown[]) => mockStaffVenueFind(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1', 'v2'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('staff_detail')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerStaffTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('staff_detail', () => {
  it('rejects a venue outside the caller scope (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign', name: 'juan' })).rejects.toThrow('out of scope')
    expect(mockStaffVenueFind).not.toHaveBeenCalled()
  })

  it('returns the candidates (no detail) when several people match', async () => {
    mockStaffVenueFind.mockResolvedValueOnce([
      { staffId: 'st1', staff: { firstName: 'Juan', lastName: 'Pérez', active: true } },
      { staffId: 'st2', staff: { firstName: 'Juana', lastName: 'Díaz', active: true } },
    ])
    const out = parse(await call({ venueId: 'v1', name: 'ju' }))
    expect(out.ambiguous).toBe(true)
    expect(mockStaffVenueFind).toHaveBeenCalledTimes(1) // never fetched assignments
  })

  it('resolves one person and lists their role at each of the caller venues', async () => {
    mockStaffVenueFind
      .mockResolvedValueOnce([{ staffId: 'st1', staff: { firstName: 'Juan', lastName: 'Pérez', active: true } }])
      .mockResolvedValueOnce([
        { role: 'MANAGER', venue: { name: 'Centro' } },
        { role: 'WAITER', venue: { name: 'Norte' } },
      ])
    const out = parse(await call({ venueId: 'v1', name: 'juan' }))

    expect(out).toMatchObject({ found: true, staff: { name: 'Juan Pérez', active: true } })
    expect(out.venues).toEqual([
      { venue: 'Centro', role: 'MANAGER' },
      { venue: 'Norte', role: 'WAITER' },
    ])
    // assignments query is scoped to all caller venues, pinned to the resolved staffId
    expect((mockStaffVenueFind.mock.calls[1][0] as { where: Record<string, unknown> }).where).toMatchObject({
      staffId: 'st1',
      venueId: { in: ['v1', 'v2'] },
    })
  })
})
