import { registerOrderTools } from '../../../src/mcp/tools/orders'
import type { McpScope } from '../../../src/mcp/scope'

const mockAggregate = jest.fn()
const mockFindMany = jest.fn()

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
  default: {
    order: {
      aggregate: (...a: unknown[]) => mockAggregate(...(a as [])),
      findMany: (...a: unknown[]) => mockFindMany(...(a as [])),
    },
    // recent_orders / find_order also register from this module
    serializedItem: { findFirst: jest.fn() },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('open_orders')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerOrderTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('open_orders', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockAggregate).not.toHaveBeenCalled()
  })

  it('filters to unpaid, non-cancelled orders and reports the total still owed', async () => {
    mockAggregate.mockResolvedValueOnce({ _count: { _all: 2 }, _sum: { remainingBalance: 730, total: 980, paidAmount: 250 } })
    mockFindMany.mockResolvedValueOnce([
      {
        id: 'o1',
        orderNumber: 'A-1001',
        type: 'DINE_IN',
        status: 'PREPARING',
        paymentStatus: 'PARTIAL',
        total: 480,
        paidAmount: 250,
        remainingBalance: 230,
        covers: 4,
        createdAt: new Date('2026-06-05T17:30:00Z'),
        table: { number: '12' },
        venue: { name: 'Centro' },
        _count: { items: 6 },
      },
    ])
    const out = parse(await call({ venueId: 'v1' }))

    // the WHERE must constrain both paymentStatus and exclude cancelled/deleted
    const whereArg = (mockFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where
    expect(whereArg).toMatchObject({
      venueId: { in: ['v1'] },
      paymentStatus: { in: ['PENDING', 'PARTIAL'] },
      status: { notIn: ['CANCELLED', 'DELETED'] },
    })
    expect(out.outstanding).toEqual({ openOrders: 2, totalOwed: 730, grossTotal: 980, alreadyPaid: 250 })
    expect(out.orders[0]).toMatchObject({ orderNumber: 'A-1001', table: '12', covers: 4, balance: 230, items: 6, paymentStatus: 'PARTIAL' })
  })

  // C3 de la B (soporte por WhatsApp) saca la definición de «cuenta abierta» a `openOrdersWhere`: la salida y el filtro no cambian.
  it('answers exactly as before, with the same filter (no date) for the aggregate and the list (case 19)', async () => {
    mockAggregate.mockResolvedValueOnce({ _count: { _all: 2 }, _sum: { remainingBalance: 730, total: 980, paidAmount: 250 } })
    mockFindMany.mockResolvedValueOnce([
      {
        id: 'o1',
        orderNumber: 'A-1001',
        type: 'DINE_IN',
        status: 'PREPARING',
        paymentStatus: 'PARTIAL',
        total: 480,
        paidAmount: 250,
        remainingBalance: 230,
        covers: 4,
        createdAt: new Date('2026-06-05T17:30:00Z'),
        table: { number: '12' },
        venue: { name: 'Centro' },
        _count: { items: 6 },
      },
      {
        id: 'o2',
        orderNumber: 'A-1002',
        type: 'TAKEOUT',
        status: 'PENDING',
        paymentStatus: 'PENDING',
        total: 500,
        paidAmount: 0,
        remainingBalance: 500,
        covers: null,
        createdAt: new Date('2026-06-05T18:05:00Z'),
        table: null,
        venue: null,
        _count: { items: 2 },
      },
    ])
    const out = parse(await call({ venueId: 'v1', limit: 10 }))
    expect(out).toEqual({
      count: 2,
      outstanding: { openOrders: 2, totalOwed: 730, grossTotal: 980, alreadyPaid: 250 },
      orders: [
        {
          id: 'o1',
          orderNumber: 'A-1001',
          venue: 'Centro',
          table: '12',
          covers: 4,
          type: 'DINE_IN',
          status: 'PREPARING',
          paymentStatus: 'PARTIAL',
          total: 480,
          paid: 250,
          balance: 230,
          items: 6,
          openedAt: '2026-06-05T17:30:00.000Z',
        },
        {
          id: 'o2',
          orderNumber: 'A-1002',
          venue: null,
          table: null,
          covers: null,
          type: 'TAKEOUT',
          status: 'PENDING',
          paymentStatus: 'PENDING',
          total: 500,
          paid: 0,
          balance: 500,
          items: 2,
          openedAt: '2026-06-05T18:05:00.000Z',
        },
      ],
    })
    const where = {
      venueId: { in: ['v1'] },
      paymentStatus: { in: ['PENDING', 'PARTIAL'] },
      status: { notIn: ['CANCELLED', 'DELETED'] },
    }
    expect(mockAggregate.mock.calls[0][0]).toEqual({
      where,
      _count: { _all: true },
      _sum: { remainingBalance: true, total: true, paidAmount: true },
    })
    const listArgs = mockFindMany.mock.calls[0][0] as { where: unknown; orderBy: unknown; take: unknown }
    expect([listArgs.where, listArgs.orderBy, listArgs.take]).toEqual([where, { createdAt: 'asc' }, 10])
  })
})
