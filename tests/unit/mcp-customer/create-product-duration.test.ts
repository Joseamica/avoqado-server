import { registerMenuTools } from '../../../src/mcp/tools/menu'
import type { McpScope } from '../../../src/mcp/scope'

// Regression: a salon built its menu through this tool and every service it
// created landed with duration = NULL, because durationMinutes was optional for
// every product type. Bookings then summed those services as ZERO minutes, so a
// 3-hour appointment was blocked on the calendar as 2 hours and the venue
// double-booked the slot behind it (Amaena, RES-PY45XU, 2026-07-20).
// A bookable service MUST carry a duration or the tool must refuse and ask.
const mockCreateProduct = jest.fn(async (_venueId: string, data: Record<string, unknown>) => ({
  id: 'p-new',
  name: data.name,
  sku: data.sku,
  type: data.type,
  price: data.price,
}))
const mockAudit = jest.fn()

jest.mock('@/services/dashboard/product.dashboard.service', () => ({
  createProduct: (...a: unknown[]) => mockCreateProduct(...(a as [string, Record<string, unknown>])),
  updateProduct: jest.fn(),
  getProduct: jest.fn(),
}))
jest.mock('@/services/dashboard/menu.dashboard.service', () => ({
  createMenuCategory: jest.fn(),
  createModifierGroup: jest.fn(),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...(a as [])) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    menuCategory: {
      findFirst: jest.fn(async () => ({ id: 'cat-1' })),
      findMany: jest.fn(async () => [{ name: 'Servicios' }]),
    },
    product: { findMany: jest.fn(async () => []) },
  },
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('create_product')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const base = { venueId: 'v1', name: 'Manicure + Pedicure Spa + Gel', price: 1000, category: 'Servicios' }

beforeAll(() => {
  registerMenuTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('create_product — duration is mandatory for bookable items', () => {
  // ── NEW BEHAVIOR ────────────────────────────────────────────────────────
  it.each(['service', 'class'])('refuses to create a %s without durationMinutes, and asks for it', async type => {
    const out = parse(await call({ ...base, type }))

    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/duraci[oó]n/i)
    expect(mockCreateProduct).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it('creates a service when durationMinutes is supplied, persisting it as duration', async () => {
    const out = parse(await call({ ...base, type: 'service', durationMinutes: 110 }))

    expect(out.ok).toBe(true)
    const [, data] = mockCreateProduct.mock.calls[0]
    expect(data.duration).toBe(110)
    expect(out.product.durationMinutes).toBe(110)
  })

  it('records the duration in the audit trail so a NULL never hides again', async () => {
    await call({ ...base, type: 'service', durationMinutes: 110 })

    expect(mockAudit).toHaveBeenCalledTimes(1)
    const [, entry] = mockAudit.mock.calls[0] as unknown as [unknown, { data: Record<string, unknown> }]
    expect(entry.data.durationMinutes).toBe(110)
  })

  // ── REGRESSION: non-bookable types must stay unaffected ─────────────────
  it.each(['product', 'food_or_beverage', 'digital', 'donation'])(
    'still creates a %s with no duration — only bookable items need one',
    async type => {
      const out = parse(await call({ ...base, name: 'Agua', price: 25, type }))

      expect(out.ok).toBe(true)
      expect(mockCreateProduct).toHaveBeenCalledTimes(1)
      const [, data] = mockCreateProduct.mock.calls[0]
      expect(data.duration).toBeUndefined()
    },
  )

  it('still rejects an unknown category before it ever looks at duration', async () => {
    const prisma = jest.requireMock('@/utils/prismaClient').default
    prisma.menuCategory.findFirst.mockResolvedValueOnce(null)

    const out = parse(await call({ ...base, type: 'service', durationMinutes: 110, category: 'No existe' }))

    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/categor[ií]a/i)
    expect(mockCreateProduct).not.toHaveBeenCalled()
  })
})
