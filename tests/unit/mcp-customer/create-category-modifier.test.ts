import { registerMenuTools } from '../../../src/mcp/tools/menu'
import type { McpScope } from '../../../src/mcp/scope'

const mockCat = jest.fn()
const mockMod = jest.fn()
const mockAudit = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing menu:create')
    },
  }),
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({ updateProduct: jest.fn(), createProduct: jest.fn() }))
jest.mock('@/services/dashboard/menu.dashboard.service', () => ({
  createMenuCategory: (...a: unknown[]) => mockCat(...(a as [])),
  createModifierGroup: (...a: unknown[]) => mockMod(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { product: { findMany: jest.fn(), findFirst: jest.fn() }, menuCategory: { findMany: jest.fn(), findFirst: jest.fn() } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerMenuTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('create_category', () => {
  it('rejects out-of-scope / no-perm', async () => {
    await expect(call('create_category', { venueId: 'foreign', name: 'X' })).rejects.toThrow('out of scope')
    await expect(call('create_category', { venueId: 'no-perm', name: 'X' })).rejects.toThrow('Forbidden')
    expect(mockCat).not.toHaveBeenCalled()
  })
  it('creates a category + audits', async () => {
    mockCat.mockResolvedValueOnce({ id: 'cat-1', name: 'Bebidas' })
    const out = parse(await call('create_category', { venueId: 'v1', name: 'Bebidas', description: 'Frías' }))
    expect(mockCat).toHaveBeenCalledWith('v1', expect.objectContaining({ name: 'Bebidas', description: 'Frías' }))
    expect(out).toMatchObject({ ok: true, category: { id: 'cat-1', name: 'Bebidas' } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'MENU_CATEGORY_CREATED', entityId: 'cat-1' })
  })
})

describe('create_modifier_group', () => {
  it('creates a group with its options (extraPrice -> price, default 0) + audits', async () => {
    mockMod.mockResolvedValueOnce({ id: 'mg-1', name: 'Extras' })
    const out = parse(
      await call('create_modifier_group', {
        venueId: 'v1',
        name: 'Extras',
        required: false,
        allowMultiple: true,
        options: [{ name: 'Queso extra', extraPrice: 15 }, { name: 'Sin cebolla' }],
      }),
    )
    const dto = mockMod.mock.calls[0][1] as { name: string; modifiers: Array<{ name: string; price: number }> }
    expect(dto.name).toBe('Extras')
    expect(dto.modifiers).toEqual([
      { name: 'Queso extra', price: 15 },
      { name: 'Sin cebolla', price: 0 },
    ])
    expect(out).toMatchObject({ ok: true, modifierGroup: { id: 'mg-1', options: 2 } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'MODIFIER_GROUP_CREATED', entityId: 'mg-1' })
  })
})
