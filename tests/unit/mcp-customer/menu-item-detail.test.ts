import { registerMenuTools } from '../../../src/mcp/tools/menu'
import type { McpScope } from '../../../src/mcp/scope'

const mockProductFindMany = jest.fn()
const mockProductFindFirst = jest.fn()

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
    product: {
      findMany: (...a: unknown[]) => mockProductFindMany(...(a as [])),
      findFirst: (...a: unknown[]) => mockProductFindFirst(...(a as [])),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('menu_item_detail')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerMenuTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('menu_item_detail', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign', name: 'x' })).rejects.toThrow('out of scope')
    expect(mockProductFindMany).not.toHaveBeenCalled()
  })

  it('returns the candidates (no detail fetch) when the name is ambiguous', async () => {
    mockProductFindMany.mockResolvedValueOnce([
      { id: 'p1', name: 'Hamburguesa Clásica', active: true, price: 120 },
      { id: 'p2', name: 'Hamburguesa BBQ', active: true, price: 150 },
    ])
    const out = parse(await call({ venueId: 'v1', name: 'hamburguesa' }))
    expect(out.found).toBe(false)
    expect(out.ambiguous).toBe(true)
    expect(mockProductFindFirst).not.toHaveBeenCalled()
  })

  it('computes real margin and maps modifier groups for a single match', async () => {
    mockProductFindMany.mockResolvedValueOnce([{ id: 'p1', name: 'Hamburguesa BBQ', active: true, price: 150 }])
    mockProductFindFirst.mockResolvedValueOnce({
      name: 'Hamburguesa BBQ',
      sku: 'BURG-BBQ',
      description: 'Con tocino',
      type: 'FOOD',
      price: 150,
      cost: 60,
      active: true,
      prepTime: 12,
      calories: 800,
      imageUrl: 'http://x/y.png',
      trackInventory: true,
      inventoryMethod: 'RECIPE',
      category: { name: 'Hamburguesas' },
      modifierGroups: [
        {
          group: {
            name: 'Extras',
            required: false,
            allowMultiple: true,
            minSelections: 0,
            maxSelections: 3,
            modifiers: [
              { name: 'Queso extra', price: 15 },
              { name: 'Tocino', price: 20 },
            ],
          },
        },
      ],
    })
    const out = parse(await call({ venueId: 'v1', name: 'bbq' }))

    expect(out.found).toBe(true)
    expect(out.item).toMatchObject({
      name: 'Hamburguesa BBQ',
      category: 'Hamburguesas',
      price: 150,
      cost: 60,
      hasImage: true,
      inventoryTracking: 'RECIPE',
    })
    expect(out.item.margin).toEqual({ amount: 90, percent: 60 })
    expect(out.item.modifierGroups[0]).toMatchObject({
      name: 'Extras',
      max: 3,
      options: [
        { name: 'Queso extra', extraPrice: 15 },
        { name: 'Tocino', extraPrice: 20 },
      ],
    })
  })

  it('returns margin: null (never estimated) when the item has no cost set', async () => {
    mockProductFindMany.mockResolvedValueOnce([{ id: 'p9', name: 'Agua', active: true, price: 25 }])
    mockProductFindFirst.mockResolvedValueOnce({
      name: 'Agua',
      sku: 'AGUA',
      description: null,
      type: 'BEVERAGE',
      price: 25,
      cost: null,
      active: true,
      prepTime: null,
      calories: null,
      imageUrl: null,
      trackInventory: false,
      inventoryMethod: null,
      category: { name: 'Bebidas' },
      modifierGroups: [],
    })
    const out = parse(await call({ venueId: 'v1', name: 'agua' }))
    expect(out.item.cost).toBeNull()
    expect(out.item.margin).toBeNull()
    expect(out.item.inventoryTracking).toBeNull()
  })
})
