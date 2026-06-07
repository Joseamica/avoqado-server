import { registerPaymentTools, buildPaymentsSummary } from '../../../src/mcp/tools/payments'
import type { McpScope } from '../../../src/mcp/scope'

const mockVenueFind = jest.fn()
const mockGroupBy = jest.fn()
const mockFindMany = jest.fn()

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
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenueFind(...(a as [])) },
    payment: {
      groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])),
      findMany: (...a: unknown[]) => mockFindMany(...(a as [])),
    },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('list_payments')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerPaymentTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('buildPaymentsSummary (pure)', () => {
  it('breaks totals down by status and isolates completed revenue/fees/net', () => {
    const s = buildPaymentsSummary([
      { status: 'COMPLETED', _count: { _all: 3 }, _sum: { amount: 300, tipAmount: 30, feeAmount: 9, netAmount: 291 } },
      { status: 'REFUNDED', _count: { _all: 1 }, _sum: { amount: 100, tipAmount: 0, feeAmount: 0, netAmount: 100 } },
      { status: 'FAILED', _count: { _all: 2 }, _sum: { amount: 0, tipAmount: 0, feeAmount: 0, netAmount: 0 } },
    ] as never)
    expect(s.count).toBe(6)
    expect(s.byStatus.COMPLETED).toEqual({ count: 3, amount: 300, tips: 30 })
    expect(s.byStatus.REFUNDED.count).toBe(1)
    expect(s.byStatus.FAILED.count).toBe(2)
    // Refunds/failed never pollute the "real revenue" figure
    expect(s.completed).toEqual({ count: 3, gross: 300, tips: 30, processorFees: 9, net: 291 })
  })

  it('handles null sums (a status with rows but no money) without NaN', () => {
    const s = buildPaymentsSummary([
      { status: 'PENDING', _count: { _all: 0 }, _sum: { amount: null, tipAmount: null, feeAmount: null, netAmount: null } },
    ] as never)
    expect(s.byStatus.PENDING).toEqual({ count: 0, amount: 0, tips: 0 })
    expect(s.completed.gross).toBe(0)
  })
})

describe('list_payments', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockVenueFind).not.toHaveBeenCalled()
    expect(mockGroupBy).not.toHaveBeenCalled()
  })

  it('returns a per-status summary + recent payments for an in-scope venue, surfacing refunds', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockGroupBy.mockResolvedValueOnce([
      { status: 'COMPLETED', _count: { _all: 2 }, _sum: { amount: 200, tipAmount: 20, feeAmount: 6, netAmount: 194 } },
      { status: 'REFUNDED', _count: { _all: 1 }, _sum: { amount: 50, tipAmount: 0, feeAmount: 0, netAmount: 50 } },
    ])
    mockFindMany.mockResolvedValueOnce([
      {
        id: 'pay1',
        status: 'REFUNDED',
        method: 'CREDIT_CARD',
        source: 'TPV',
        amount: 50,
        tipAmount: 0,
        feeAmount: 0,
        netAmount: 50,
        cardBrand: 'VISA',
        maskedPan: '4111******1111',
        processor: 'blumon',
        authorizationNumber: '502511',
        createdAt: new Date('2026-06-05T18:00:00Z'),
        processedBy: { firstName: 'Ana', lastName: 'López' },
        terminal: { name: 'Caja 1' },
        order: { orderNumber: 'A-1023' },
      },
    ])
    const out = parse(await call({ venueId: 'v1', status: 'all' }))
    expect(out.summary.byStatus.REFUNDED.count).toBe(1)
    expect(out.summary.completed.gross).toBe(200)
    expect(out.payments[0]).toMatchObject({
      id: 'pay1',
      status: 'REFUNDED',
      cardBrand: 'VISA',
      terminal: 'Caja 1',
      orderNumber: 'A-1023',
      processedBy: 'Ana López',
    })
    // sensitive fields must NOT leak to the LLM vendor
    expect(out.payments[0].card).toBeUndefined()
    expect(out.payments[0].authorization).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('4111')
    expect(mockGroupBy).toHaveBeenCalledTimes(1)
    expect(mockFindMany).toHaveBeenCalledTimes(1)
  })
})
