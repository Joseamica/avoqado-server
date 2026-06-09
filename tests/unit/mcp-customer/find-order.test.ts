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
