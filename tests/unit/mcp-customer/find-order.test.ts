import { registerOrderTools } from '../../../src/mcp/tools/orders'
import type { McpScope } from '../../../src/mcp/scope'

const mockSerializedFind = jest.fn()
const mockOrderFind = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => (v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }),
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    serializedItem: { findFirst: (...a: unknown[]) => mockSerializedFind(...(a as [])) },
    order: { findFirst: (...a: unknown[]) => mockOrderFind(...(a as [])), findMany: jest.fn(), aggregate: jest.fn() },
    venue: { findUnique: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('find_order')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerOrderTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('find_order by serial — case-insensitive (regression 2026-06-09)', () => {
  it('resolves the order even when the serial case differs from what is stored', async () => {
    // stored lower-cased; caller searches UPPERCASE
    mockSerializedFind.mockResolvedValueOnce({ orderItem: { orderId: 'ord-1' } })
    mockOrderFind.mockResolvedValueOnce({
      id: 'ord-1',
      orderNumber: 'SN00003',
      status: 'COMPLETED',
      venue: { name: 'Wellness' },
      items: [],
      payments: [],
    })

    const out = parse(await call({ serialNumber: 'JHHHHHHHHHHHGGGGGGGG' }))

    const where = (mockSerializedFind.mock.calls[0][0] as { where: { serialNumber: { in: string[] } } }).where
    expect(where.serialNumber.in).toEqual(expect.arrayContaining(['JHHHHHHHHHHHGGGGGGGG', 'jhhhhhhhhhhhgggggggg']))
    expect(out.found).toBe(true)
    expect(out.order.orderNumber).toBe('SN00003')
  })

  it('returns found:false for a serial that maps to no order', async () => {
    mockSerializedFind.mockResolvedValueOnce(null)
    const out = parse(await call({ serialNumber: 'NOPE' }))
    expect(out.found).toBe(false)
    expect(mockOrderFind).not.toHaveBeenCalled()
  })
})

describe('find_order by orderNumber — the human identifier operators have (2026-06-26)', () => {
  it('resolves an order by its human number, case-insensitive AND scoped to your venues', async () => {
    // call 1: resolve number → id (within scope); call 2: fetch the full order
    mockOrderFind.mockResolvedValueOnce({ id: 'ord-9' }).mockResolvedValueOnce({
      id: 'ord-9',
      orderNumber: 'ORD-5454',
      status: 'COMPLETED',
      total: 358,
      venue: { name: 'Mobanq' },
      items: [],
      payments: [],
    })

    const out = parse(await call({ orderNumber: 'ord-5454' })) // lower-case input
    const lookupWhere = (mockOrderFind.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(lookupWhere.orderNumber).toEqual({ equals: 'ord-5454', mode: 'insensitive' }) // case-insensitive
    expect(lookupWhere.venueId).toEqual({ in: ['v1'] }) // scoped — can't probe other venues' numbers
    expect(out.found).toBe(true)
    expect(out.order.orderNumber).toBe('ORD-5454')
    expect(out.order.total).toBe(358)
  })

  it('unknown order number → found:false, never fetches the full order', async () => {
    mockOrderFind.mockResolvedValueOnce(null) // no order with that number in scope
    const out = parse(await call({ orderNumber: 'ORD-DOES-NOT-EXIST' }))
    expect(out.found).toBe(false)
    expect(out.reason).toMatch(/No order found with number/)
    expect(mockOrderFind).toHaveBeenCalledTimes(1) // resolution only, no second fetch
  })

  it('no identifier at all → asks for one (orderNumber listed first)', async () => {
    const out = parse(await call({}))
    expect(out.found).toBe(false)
    expect(out.reason).toBe('Pass orderNumber, orderId, or serialNumber')
  })
})
