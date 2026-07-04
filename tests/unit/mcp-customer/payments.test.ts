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
  it('splits modern refunds (COMPLETED+REFUND, negative) out of completed instead of netting them in', () => {
    const s = buildPaymentsSummary([
      { status: 'COMPLETED', type: 'REGULAR', _count: { _all: 3 }, _sum: { amount: 300, tipAmount: 30, feeAmount: 9, netAmount: 291 } },
      // modern refund: status COMPLETED, type REFUND, NEGATIVE — the bug netted this into completed
      { status: 'COMPLETED', type: 'REFUND', _count: { _all: 1 }, _sum: { amount: -50, tipAmount: -5, feeAmount: 0, netAmount: -50 } },
      { status: 'FAILED', type: 'REGULAR', _count: { _all: 2 }, _sum: { amount: 0, tipAmount: 0, feeAmount: 0, netAmount: 0 } },
    ] as never)
    expect(s.count).toBe(6)
    // completed = TRUE sales revenue — the refund did NOT pollute it
    expect(s.completed).toEqual({ count: 3, gross: 300, tips: 30, processorFees: 9, net: 291 })
    // refund split into its own line, kept NEGATIVE (money out)
    expect(s.refunds).toEqual({ count: 1, amount: -50, tips: -5 })
    // byStatus: COMPLETED shows sales only; a synthetic REFUND bucket carries the refund
    expect(s.byStatus.COMPLETED).toEqual({ count: 3, amount: 300, tips: 30 })
    expect(s.byStatus.REFUND).toEqual({ count: 1, amount: -50, tips: -5 })
    expect(s.byStatus.FAILED.count).toBe(2)
    // net collected reconciles: completed.gross + refunds.amount = 300 + (-50) = 250
    expect(s.completed.gross + s.refunds.amount).toBe(250)
  })

  it('also puts legacy REFUNDED+REGULAR rows in the refunds bucket', () => {
    const s = buildPaymentsSummary([
      { status: 'REFUNDED', type: 'REGULAR', _count: { _all: 1 }, _sum: { amount: -25, tipAmount: 0, feeAmount: 0, netAmount: -25 } },
    ] as never)

    expect(s.refunds).toEqual({ count: 1, amount: -25, tips: 0 })
    expect(s.byStatus.REFUND).toEqual({ count: 1, amount: -25, tips: 0 })
    expect(s.byStatus.REFUNDED).toBeUndefined()
  })

  it('accumulates multiple type rows under one status (groupBy status×type yields several)', () => {
    const s = buildPaymentsSummary([
      { status: 'COMPLETED', type: 'REGULAR', _count: { _all: 2 }, _sum: { amount: 200, tipAmount: 20, feeAmount: 6, netAmount: 194 } },
      { status: 'COMPLETED', type: 'FAST', _count: { _all: 1 }, _sum: { amount: 100, tipAmount: 10, feeAmount: 3, netAmount: 97 } },
    ] as never)
    // both COMPLETED rows sum together instead of the second overwriting the first
    expect(s.completed).toEqual({ count: 3, gross: 300, tips: 30, processorFees: 9, net: 291 })
    expect(s.byStatus.COMPLETED).toEqual({ count: 3, amount: 300, tips: 30 })
  })

  it('handles null sums (a status with rows but no money) without NaN', () => {
    const s = buildPaymentsSummary([
      {
        status: 'PENDING',
        type: 'REGULAR',
        _count: { _all: 0 },
        _sum: { amount: null, tipAmount: null, feeAmount: null, netAmount: null },
      },
    ] as never)
    expect(s.byStatus.PENDING).toEqual({ count: 0, amount: 0, tips: 0 })
    expect(s.completed.gross).toBe(0)
    expect(s.refunds).toEqual({ count: 0, amount: 0, tips: 0 })
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
      { status: 'COMPLETED', type: 'REGULAR', _count: { _all: 2 }, _sum: { amount: 200, tipAmount: 20, feeAmount: 6, netAmount: 194 } },
      { status: 'REFUNDED', type: 'REGULAR', _count: { _all: 1 }, _sum: { amount: -50, tipAmount: 0, feeAmount: 0, netAmount: -50 } },
    ])
    mockFindMany.mockResolvedValueOnce([
      {
        id: 'pay1',
        status: 'REFUNDED',
        type: 'REGULAR',
        method: 'CREDIT_CARD',
        source: 'TPV',
        amount: -50,
        tipAmount: 0,
        feeAmount: 0,
        netAmount: -50,
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
    expect(out.summary.byStatus.REFUND.count).toBe(1)
    expect(out.summary.refunds).toEqual({ count: 1, amount: -50, tips: 0 })
    expect(out.summary.completed.gross).toBe(200)
    expect(out.payments[0]).toMatchObject({
      id: 'pay1',
      status: 'REFUNDED',
      type: 'REGULAR',
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

  it('status=refunded matches both modern and legacy refunds and exposes payment type', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockGroupBy.mockResolvedValueOnce([])
    mockFindMany.mockResolvedValueOnce([
      {
        id: 'refund-modern',
        status: 'COMPLETED',
        type: 'REFUND',
        method: 'CREDIT_CARD',
        source: 'TPV',
        amount: -50,
        tipAmount: -5,
        feeAmount: 0,
        netAmount: -50,
        cardBrand: 'VISA',
        processor: 'blumon',
        createdAt: new Date('2026-06-05T18:00:00Z'),
        processedBy: null,
        terminal: null,
        order: { orderNumber: 'A-1023' },
      },
    ])

    const out = parse(await call({ venueId: 'v1', status: 'refunded' }))
    const groupWhere = mockGroupBy.mock.calls[0][0].where
    const listArgs = mockFindMany.mock.calls[0][0]

    expect(groupWhere.OR).toEqual([{ type: 'REFUND' }, { status: 'REFUNDED' }])
    expect(listArgs.where.OR).toEqual([{ type: 'REFUND' }, { status: 'REFUNDED' }])
    expect(listArgs.select.type).toBe(true)
    expect(out.payments[0]).toMatchObject({ id: 'refund-modern', status: 'COMPLETED', type: 'REFUND' })
  })

  it('status=completed excludes modern refund rows', async () => {
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockGroupBy.mockResolvedValueOnce([])
    mockFindMany.mockResolvedValueOnce([])

    await call({ venueId: 'v1', status: 'completed' })

    expect(mockGroupBy.mock.calls[0][0].where).toMatchObject({ status: 'COMPLETED', type: { not: 'REFUND' } })
    expect(mockFindMany.mock.calls[0][0].where).toMatchObject({ status: 'COMPLETED', type: { not: 'REFUND' } })
  })
})
