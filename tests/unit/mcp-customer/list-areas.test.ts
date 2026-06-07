import { registerTableTools } from '../../../src/mcp/tools/tables'
import type { McpScope } from '../../../src/mcp/scope'

const mockAreaFind = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { table: { findMany: jest.fn() }, area: { findMany: (...a: unknown[]) => mockAreaFind(...(a as [])) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('list_areas')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerTableTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('list_areas', () => {
  it('rejects a venue outside the caller scope (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockAreaFind).not.toHaveBeenCalled()
  })

  it('lists areas with their table counts', async () => {
    mockAreaFind.mockResolvedValueOnce([
      { name: 'Terraza', description: 'Al aire libre', _count: { tables: 8 } },
      { name: 'Barra', description: null, _count: { tables: 5 } },
    ])
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.count).toBe(2)
    expect(out.areas).toEqual([
      { name: 'Terraza', description: 'Al aire libre', tables: 8 },
      { name: 'Barra', description: null, tables: 5 },
    ])
  })
})
