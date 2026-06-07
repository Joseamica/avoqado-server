import { registerMenuTools } from '../../../src/mcp/tools/menu'
import type { McpScope } from '../../../src/mcp/scope'

const mockCatFind = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({ updateProduct: jest.fn() }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn(), findFirst: jest.fn() },
    menuCategory: { findMany: (...a: unknown[]) => mockCatFind(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('menu_categories')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerMenuTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('menu_categories', () => {
  it('rejects a venue outside the caller scope (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockCatFind).not.toHaveBeenCalled()
  })

  it('lists active categories with product counts by default', async () => {
    mockCatFind.mockResolvedValueOnce([
      { name: 'Entradas', description: null, active: true, _count: { products: 7 } },
      { name: 'Bebidas', description: 'Frías y calientes', active: true, _count: { products: 15 } },
    ])
    const out = parse(await call({ venueId: 'v1' }))

    expect(out.count).toBe(2)
    expect(out.categories[1]).toEqual({ name: 'Bebidas', description: 'Frías y calientes', active: true, products: 15 })
    // default excludes inactive categories
    expect((mockCatFind.mock.calls[0][0] as { where: Record<string, unknown> }).where).toMatchObject({
      venueId: { in: ['v1'] },
      active: true,
    })
  })

  it('includes inactive categories when asked', async () => {
    mockCatFind.mockResolvedValueOnce([])
    await call({ venueId: 'v1', includeInactive: true })
    const where = (mockCatFind.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(where.active).toBeUndefined()
  })
})
