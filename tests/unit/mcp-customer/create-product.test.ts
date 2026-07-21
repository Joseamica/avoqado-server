import { registerMenuTools } from '../../../src/mcp/tools/menu'
import type { McpScope } from '../../../src/mcp/scope'

const mockCreate = jest.fn()
const mockAudit = jest.fn()
const mockCatFindFirst = jest.fn()
const mockCatFindMany = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing products:create')
    },
  }),
}))
jest.mock('@/services/dashboard/product.dashboard.service', () => ({
  updateProduct: jest.fn(),
  createProduct: (...a: unknown[]) => mockCreate(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn(), findFirst: jest.fn() },
    menuCategory: {
      findFirst: (...a: unknown[]) => mockCatFindFirst(...(a as [])),
      findMany: (...a: unknown[]) => mockCatFindMany(...(a as [])),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('create_product')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerMenuTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('create_product (write)', () => {
  // `durationMinutes` is mandatory for bookable types — a service with no
  // duration is rejected up front (see create-product-duration.test.ts). These
  // tests target the other concerns, so they supply a valid one.
  const base = { venueId: 'v1', name: 'Corte de cabello', price: 250, type: 'service', category: 'Servicios', durationMinutes: 45 }

  it('rejects a venue outside the caller scope', async () => {
    await expect(call({ ...base, venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects when the caller lacks products:create', async () => {
    await expect(call({ ...base, venueId: 'no-perm' })).rejects.toThrow('Forbidden')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns the available categories (no create) when the category is not found', async () => {
    mockCatFindFirst.mockResolvedValueOnce(null)
    mockCatFindMany.mockResolvedValueOnce([{ name: 'Cortes' }, { name: 'Tintes' }])
    const out = parse(await call(base))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/Cortes, Tintes/)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('resolves the category, maps the type, auto-generates a SKU, creates + audits', async () => {
    mockCatFindFirst.mockResolvedValueOnce({ id: 'cat-1' })
    mockCreate.mockResolvedValueOnce({
      id: 'p-new',
      name: 'Corte de cabello',
      sku: 'CORTEDE-ABCDE',
      type: 'APPOINTMENTS_SERVICE',
      price: 250,
    })

    const out = parse(await call({ ...base, durationMinutes: 45 }))

    const dto = mockCreate.mock.calls[0][1] as Record<string, unknown>
    expect(dto).toMatchObject({ name: 'Corte de cabello', price: 250, type: 'APPOINTMENTS_SERVICE', categoryId: 'cat-1', duration: 45 })
    expect(typeof dto.sku).toBe('string') // auto-generated
    expect(out).toMatchObject({ ok: true, product: { id: 'p-new', type: 'APPOINTMENTS_SERVICE' } })
    expect(mockAudit.mock.calls[0][1]).toMatchObject({ action: 'PRODUCT_CREATED', entity: 'Product', entityId: 'p-new', venueId: 'v1' })
  })

  it('surfaces a service validation error as ok:false', async () => {
    mockCatFindFirst.mockResolvedValueOnce({ id: 'cat-1' })
    mockCreate.mockRejectedValueOnce(new Error('CLASS requires a capacity'))
    const out = parse(await call({ ...base, type: 'class' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/capacity/)
  })
})
