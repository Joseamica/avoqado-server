import { registerPaymentTools, buildPaymentsSummary, conCostoPendiente } from '../../../src/mcp/tools/payments'
import type { McpScope } from '../../../src/mcp/scope'

const mockVenueFind = jest.fn()
const mockGroupBy = jest.fn()
const mockFindMany = jest.fn()
const mockCount = jest.fn()

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
      count: (...a: unknown[]) => mockCount(...(a as [])),
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
beforeEach(() => {
  jest.clearAllMocks()
  mockCount.mockResolvedValue(0)
})

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
        internationalityStatus: 'UNKNOWN',
        internationalitySource: 'LEGACY',
        issuerCountryCode: null,
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
      internationalityShadow: {
        status: 'UNKNOWN',
        source: 'LEGACY',
        issuerCountryCode: null,
        authoritativeForMoney: false,
      },
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

describe('Codex R1 · P2: el costo PENDIENTE (Payment nacido del webhook) se declara, no se publica como definitivo', () => {
  it('conCostoPendiente (pura): cuenta los pendientes y marca el neto como provisional sólo si hay alguno', () => {
    const base = buildPaymentsSummary([
      { status: 'COMPLETED', type: 'REGULAR', _count: { _all: 2 }, _sum: { amount: 200, tipAmount: 0, feeAmount: 3, netAmount: 197 } },
    ] as never)
    expect(conCostoPendiente(base, 0).completed).toMatchObject({ count: 2, net: 197, costPendingCount: 0, netProvisional: false })
    expect(conCostoPendiente(base, 1).completed).toMatchObject({ count: 2, net: 197, costPendingCount: 1, netProvisional: true })
    // Un conteo ilegible (mock viejo, NaN) nunca se publica como número: cae a 0 y no provisional.
    expect(conCostoPendiente(base, Number.NaN).completed).toMatchObject({ costPendingCount: 0, netProvisional: false })
  })

  it('list_payments cuenta los COMPLETED con `costPending` en la base (mismo `where` del listado) y lo expone en el resumen', async () => {
    mockVenueFind.mockResolvedValue({ id: 'v1', timezone: 'America/Mexico_City' })
    mockGroupBy.mockResolvedValueOnce([
      { status: 'COMPLETED', type: 'REGULAR', _count: { _all: 3 }, _sum: { amount: 300, tipAmount: 0, feeAmount: 0, netAmount: 300 } },
    ])
    mockFindMany.mockResolvedValueOnce([])
    mockCount.mockResolvedValueOnce(2)

    const r = parse(await call({ venueId: 'v1', from: '2026-09-01', to: '2026-09-13' }))

    expect(mockCount).toHaveBeenCalledTimes(1)
    const countWhere = mockCount.mock.calls[0][0].where
    expect(countWhere).toMatchObject({
      venueId: { in: ['v1'] },
      status: 'COMPLETED',
      processorData: { path: ['costPending'], equals: true },
    })
    // El conteo acota por la MISMA ventana que el listado: sin eso contaría pendientes de otros días.
    expect(countWhere.createdAt).toEqual(mockGroupBy.mock.calls[0][0].where.createdAt)
    expect(r.summary.completed).toMatchObject({ count: 3, net: 300, costPendingCount: 2, netProvisional: true })
  })

  // Codex R12-16: el agregado dice cuántos netos son provisionales, pero no CUÁLES. Cada fila lleva su propio `costPending`
  // (y `feeProvisional`): una fila «$100 / fee $0» convergida y otra que sigue esperando se distinguen una por una.
  it('list_payments marca POR PAGO cuál sigue con el costo pendiente (fee/net provisionales) y cuál ya convergió', async () => {
    mockVenueFind.mockResolvedValue({ id: 'v1', timezone: 'America/Mexico_City' })
    mockGroupBy.mockResolvedValueOnce([
      { status: 'COMPLETED', type: 'REGULAR', _count: { _all: 2 }, _sum: { amount: 200, tipAmount: 0, feeAmount: 3, netAmount: 197 } },
    ])
    const fila = (id: string, feeAmount: number, netAmount: number, processorData: unknown) => ({
      id,
      status: 'COMPLETED',
      type: 'REGULAR',
      method: 'CREDIT_CARD',
      source: 'TPV',
      amount: 100,
      tipAmount: 0,
      feeAmount,
      netAmount,
      cardBrand: 'VISA',
      internationalityStatus: null,
      internationalitySource: null,
      issuerCountryCode: null,
      processor: 'angelpay',
      createdAt: new Date('2026-09-13T12:00:00Z'),
      processedBy: null,
      terminal: null,
      order: { orderNumber: 'ORD-1' },
      processorData,
    })
    mockFindMany.mockResolvedValueOnce([
      fila('pendiente', 0, 100, { costPending: true, pricing: {} }),
      fila('convergido', 3, 97, { costPending: false, pricing: {} }),
      fila('legacy', 0, 100, null),
    ])
    mockCount.mockResolvedValueOnce(1)

    const r = parse(await call({ venueId: 'v1', from: '2026-09-01', to: '2026-09-13' }))

    // La selección pide `processorData` (de ahí sale la marca), pero la salida NO lo expone entero: sólo la marca.
    expect(mockFindMany.mock.calls[0][0].select).toMatchObject({ processorData: true })
    const porId = Object.fromEntries(r.payments.map((p: { id: string }) => [p.id, p]))
    expect(porId.pendiente).toMatchObject({ processorFee: 0, net: 100, costPending: true, feeProvisional: true })
    expect(porId.convergido).toMatchObject({ processorFee: 3, net: 97, costPending: false, feeProvisional: false })
    expect(porId.legacy).toMatchObject({ processorFee: 0, net: 100, costPending: false, feeProvisional: false })
    expect(porId.pendiente).not.toHaveProperty('processorData')
  })
})
