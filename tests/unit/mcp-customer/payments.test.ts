import { Prisma } from '@prisma/client'
import { registerPaymentTools, buildPaymentsSummary, conCostoPendiente, conCargasDeTarjetas } from '../../../src/mcp/tools/payments'
import type { McpScope } from '../../../src/mcp/scope'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'
import { DIRECTORY_TIERS } from '../../../src/mcp/directory/catalog'
import { MINDFORM_NEW_VENUE_ID } from '../../../src/services/legacy/qrPayments.legacy.service'
import logger from '../../../src/config/logger'

const mockVenueFind = jest.fn()
const mockGroupBy = jest.fn()
const mockFindMany = jest.fn()
const mockCount = jest.fn()
const mockAggregate = jest.fn()
const mockRequirePermission = jest.fn()
const mockTienePermiso = jest.fn()
const mockFindByAmount = jest.fn()
const mockCfdiFind = jest.fn()
const mockPlanGate = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (...a: unknown[]) => mockRequirePermission(...a),
    tienePermiso: (...a: unknown[]) => mockTienePermiso(...a),
  }),
}))
// Task 12: la búsqueda por monto es de mentira; la factura usa la regla real (`invoiceStateOfOrders`) sobre `cfdi.findMany` de mentira.
jest.mock('@/services/dashboard/paymentByAmount.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/paymentByAmount.dashboard.service'),
  findPaymentsByAmount: (...a: unknown[]) => mockFindByAmount(...a),
}))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...a) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenueFind(...(a as [])) },
    payment: {
      groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])),
      findMany: (...a: unknown[]) => mockFindMany(...(a as [])),
      count: (...a: unknown[]) => mockCount(...(a as [])),
      aggregate: (...a: unknown[]) => mockAggregate(...(a as [])),
    },
    cfdi: { findMany: (...a: unknown[]) => mockCfdiFind(...a) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const schemas = new Map<
  string,
  Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } }>
>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('list_payments')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerPaymentTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as never)
        schemas.set(a[0] as string, a[2] as never)
      },
    } as never,
    scope,
  )
})
beforeEach(() => {
  jest.clearAllMocks()
  mockCount.mockResolvedValue(0)
  mockAggregate.mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } }) // sin ventas de tarjetas de regalo
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

  // D3 (10-nov-2026) · Codex r1-4: la respuesta dice si la clasificación por país DECIDIÓ la tarifa de ese cobro.
  it('D3: `authoritativeForMoney` es true sólo desde la versión 2 y con país conocido; lo viejo y lo UNKNOWN siguen siendo observación', async () => {
    const fila = (id: string, extra: Record<string, unknown>) => ({
      id,
      status: 'COMPLETED',
      type: 'REGULAR',
      method: 'CREDIT_CARD',
      source: 'TPV',
      amount: 100,
      tipAmount: 0,
      feeAmount: 3,
      netAmount: 97,
      cardBrand: 'VISA',
      processor: 'angelpay',
      createdAt: new Date('2026-11-10T18:00:00Z'),
      processedBy: null,
      terminal: null,
      order: null,
      ...extra,
    })
    mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
    mockGroupBy.mockResolvedValueOnce([])
    mockFindMany.mockResolvedValueOnce([
      fila('decidio', {
        internationalityStatus: 'INTERNATIONAL',
        internationalitySource: 'EMV_5F28',
        issuerCountryCode: '840',
        internationalityClassificationVersion: 2,
      }),
      fila('vieja', {
        internationalityStatus: 'INTERNATIONAL',
        internationalitySource: 'EMV_5F28',
        issuerCountryCode: '840',
        internationalityClassificationVersion: 1,
      }),
      fila('sin-pais', {
        internationalityStatus: 'UNKNOWN',
        internationalitySource: 'LEGACY',
        issuerCountryCode: null,
        internationalityClassificationVersion: 2,
      }),
      fila('solo-procesador', {
        internationalityStatus: 'INTERNATIONAL',
        internationalitySource: 'PROCESSOR',
        issuerCountryCode: 'US',
        internationalityClassificationVersion: 2,
      }),
      fila('bin-verificado', {
        internationalityStatus: 'DOMESTIC',
        internationalitySource: 'BIN_REGISTRY',
        issuerCountryCode: '484',
        internationalityClassificationVersion: 2,
      }),
    ])
    const out = parse(await call({ venueId: 'v1', status: 'all' }))
    const porId = Object.fromEntries(out.payments.map((p: any) => [p.id, p.internationalityShadow.authoritativeForMoney]))
    expect(porId).toEqual({ decidio: true, vieja: false, 'sin-pais': false, 'solo-procesador': false, 'bin-verificado': true })
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

// Pendientes 1a · tarea 1: la lista de cobros es dinero (la venta de tarjetas de regalo se queda), pero su resumen dice cuánto del bruto es eso.
describe('list_payments · tarjetas de regalo vendidas dentro del bruto', () => {
  const base = () =>
    buildPaymentsSummary([
      { status: 'COMPLETED', type: 'REGULAR', _count: { _all: 3 }, _sum: { amount: 1000, tipAmount: 0, feeAmount: 0, netAmount: 1000 } },
    ])

  it('conCargasDeTarjetas (pura): con alguna carga dice cuántas y cuánto, y la nota; sin ninguna, ceros y sin nota', () => {
    const con = conCargasDeTarjetas(base(), { count: 1, amount: 500 })
    expect(con.giftCardLoads).toEqual({ count: 1, amount: 500 })
    // Dice lo que de verdad cuenta: TODO cobro de cuentas de tarjetas (abonos incluidos), antes de sus devoluciones.
    expect(con.note).toBe(
      'completed.gross incluye $500.00 cobrados en cuentas de tarjetas de regalo (abonos incluidos; sus devoluciones van en refunds); eso no es venta.',
    )
    // El monto, con el formateador de pesos del resto del MCP (separador de miles).
    expect(conCargasDeTarjetas(base(), { count: 2, amount: 1500 }).note).toContain('$1,500.00')
    expect(con.completed.gross).toBe(1000) // el bruto es dinero: no se toca

    const sin = conCargasDeTarjetas(base(), { count: 0, amount: 0 })
    expect(sin.giftCardLoads).toEqual({ count: 0, amount: 0 })
    expect(sin).not.toHaveProperty('note')
    // Un conteo ilegible nunca se publica como número.
    expect(conCargasDeTarjetas(base(), { count: Number.NaN, amount: 50 }).giftCardLoads).toEqual({ count: 0, amount: 0 })
  })

  it('list_payments agrega las cargas con el MISMO filtro del listado y sólo de cuentas de tarjetas (COMPLETED, no reembolsos)', async () => {
    mockVenueFind.mockResolvedValue({ id: 'v1', timezone: 'America/Mexico_City' })
    mockGroupBy.mockResolvedValueOnce([
      { status: 'COMPLETED', type: 'REGULAR', _count: { _all: 3 }, _sum: { amount: 1000, tipAmount: 0, feeAmount: 0, netAmount: 1000 } },
    ])
    mockFindMany.mockResolvedValueOnce([])
    mockAggregate.mockResolvedValueOnce({ _sum: { amount: 500 }, _count: { _all: 1 } })

    const r = parse(await call({ venueId: 'v1' }))

    expect(r.summary.giftCardLoads).toEqual({ count: 1, amount: 500 })
    expect(r.summary.note).toContain('$500.00')
    expect(r.summary.completed.gross).toBe(1000)
    const { where } = mockAggregate.mock.calls[0][0]
    expect(where.AND[0]).toEqual(mockGroupBy.mock.calls[0][0].where) // el mismo filtro que el resumen
    expect(where.AND[1]).toEqual({
      status: 'COMPLETED',
      type: { not: 'REFUND' },
      order: { items: { some: { giftCardId: { not: null } } } },
    })
  })
})

// Task 12 (la B, MCP en sync): la tool de C2 + C7, sólo en el modo libre.
describe('find_payment_by_amount', () => {
  const find = (args: Record<string, unknown>) => handlers.get('find_payment_by_amount')!(args, {})
  const row = (over: Record<string, unknown> = {}) => ({
    createdAt: new Date('2026-11-01T20:05:00Z'),
    amount: new Prisma.Decimal('800.00'),
    tipAmount: new Prisma.Decimal('50.00'),
    method: 'CREDIT_CARD',
    cardBrand: 'VISA',
    last4: '4242',
    tenderSystemKind: null,
    status: 'COMPLETED',
    orderId: 'ord-secret-1',
    ...over,
  })
  it('find_payment_by_amount is registered, read-only and outside the certified catalog', () => {
    expect(handlers.has('find_payment_by_amount')).toBe(true)
    expect(TOOL_EFFECTS.find_payment_by_amount).toBe('read')
    expect(DIRECTORY_TIERS.flatMap(tier => [...tier.tools])).not.toContain('find_payment_by_amount')
  })

  it('rejects a venue out of scope before reading, and asks for payments:read', async () => {
    await expect(find({ venueId: 'foreign', amount: 850 })).rejects.toThrow('out of scope')
    mockRequirePermission.mockImplementationOnce(() => {
      throw new Error('Missing permission payments:read for venue v1')
    })
    await expect(find({ venueId: 'v1', amount: 850 })).rejects.toThrow('payments:read')
    expect(mockRequirePermission).toHaveBeenCalledWith('payments:read', 'v1')
    expect(mockVenueFind).not.toHaveBeenCalled()
    expect(mockFindByAmount).not.toHaveBeenCalled()
    expect(mockCfdiFind).not.toHaveBeenCalled()
  })

  it('passes the venue, the exact amount and one day, and returns pesos and the card brand without any card digit or reference', async () => {
    mockTienePermiso.mockReturnValue(false) // sin facturas: el campo no viene
    // El día que cambia la hora en Tijuana: 1-nov-2026 dura 25 h (PDT → PST) y 8-mar-2026 dura 23 h (PST → PDT). La zona del PROCESO no
    // cambia dentro de jest (`process.env.TZ` va en un sandbox): este archivo se corre con TZ=UTC (producción), TZ=America/Tijuana y
    // TZ=America/Santiago, que se salta la medianoche del 6-sep-2026 (00:00 → 01:00): un día armado con la medianoche del proceso se
    // corre una hora ahí.
    const days = [
      {
        tz: 'America/Tijuana',
        date: '2026-11-01',
        from: '2026-11-01T07:00:00.000Z',
        to: '2026-11-02T07:59:59.999Z',
        hours: 25,
        at: '2026-11-01T20:05:00Z',
        time: '12:05',
      },
      {
        tz: 'America/Tijuana',
        date: '2026-03-08',
        from: '2026-03-08T08:00:00.000Z',
        to: '2026-03-09T06:59:59.999Z',
        hours: 23,
        at: '2026-03-08T20:05:00Z',
        time: '13:05',
      },
      {
        tz: 'America/Mexico_City',
        date: '2026-09-06',
        from: '2026-09-06T06:00:00.000Z',
        to: '2026-09-07T05:59:59.999Z',
        hours: 24,
        at: '2026-09-06T20:05:00Z',
        time: '14:05',
      },
    ]
    for (const day of days) {
      mockFindByAmount.mockClear()
      mockVenueFind.mockResolvedValueOnce({ timezone: day.tz })
      mockFindByAmount.mockResolvedValueOnce({ total: 1, rows: [row({ createdAt: new Date(day.at) })] })
      const out = parse(await find({ venueId: 'v1', amount: 850.5, date: day.date }))
      const [venueId, input] = mockFindByAmount.mock.calls[0]
      expect(venueId).toBe('v1')
      expect(input.amount.toFixed(2)).toBe('850.50')
      expect(input.take).toBe(5)
      expect(input.windows).toHaveLength(1)
      expect(input.windows[0].from.toISOString()).toBe(day.from)
      expect(input.windows[0].to.toISOString()).toBe(day.to)
      expect(Math.round((input.windows[0].to - input.windows[0].from) / 3_600_000)).toBe(day.hours)
      // Pesos como números, la hora de la sucursal; sin id del cobro, de la venta, folio ni referencia.
      expect(out).toEqual({
        amount: 850.5,
        date: day.date,
        total: 1,
        payments: [{ time: day.time, amount: 800, tip: 50, method: 'CREDIT_CARD', cardBrand: 'VISA', status: 'COMPLETED' }],
      })
      expect(JSON.stringify(out)).not.toContain('ord-secret')
      // Como `list_payments`: la marca sí, ningún dígito de la tarjeta (ni los últimos 4) va al proveedor de IA.
      for (const field of ['last4', 'maskedPan', 'cardNumber', 'pan', 'bin']) expect(out.payments[0]).not.toHaveProperty(field)
      expect(JSON.stringify(out)).not.toContain('4242')
    }
  })

  it('without date it searches today in the venue timezone, not in the process timezone', async () => {
    mockTienePermiso.mockReturnValue(false)
    // 06:30 UTC del 2-nov = 22:30 del 1-nov en Tijuana: «hoy» es el 1-nov.
    jest.useFakeTimers({ now: new Date('2026-11-02T06:30:00Z') })
    try {
      mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Tijuana' })
      mockFindByAmount.mockResolvedValueOnce({ total: 0, rows: [] })
      const out = parse(await find({ venueId: 'v1', amount: 850 }))
      expect(out).toEqual({ amount: 850, date: '2026-11-01', total: 0, payments: [] })
      expect(mockFindByAmount.mock.calls[0][1].windows[0].from.toISOString()).toBe('2026-11-01T07:00:00.000Z')
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects impossible dates and amounts out of range before reading', () => {
    const shape = schemas.get('find_payment_by_amount')!
    expect(shape.date.safeParse('2026-02-28').success).toBe(true)
    const feb30 = shape.date.safeParse('2026-02-30')
    expect(feb30.success).toBe(false)
    expect(feb30.error!.issues[0].message).toBe('Esa fecha no existe')
    expect(shape.date.safeParse('2026-13-40').success).toBe(false)
    expect(shape.date.safeParse('2026-2-3').success).toBe(false)
    expect(shape.amount.safeParse(0).success).toBe(false)
    expect(shape.amount.safeParse(10_000_000).success).toBe(false)
    expect(shape.amount.safeParse(9_999_999.99).success).toBe(true)
    // Más de 2 decimales se rechaza: 0.004 no se vuelve una búsqueda de $0.00, ni 850.505 una de $850.51.
    expect(shape.amount.safeParse(0.004).success).toBe(false)
    expect(shape.amount.safeParse(850.505).success).toBe(false)
    expect(shape.amount.safeParse(850.5).success).toBe(true)
    expect(shape.amount.safeParse(0.01).success).toBe(true)
  })

  it('invoice comes only with orders:read, cfdi:view and the CFDI feature; without any of them the field is absent and no invoice is read', async () => {
    const rows = [row({ orderId: 'o1' }), row({ orderId: 'o2' }), row({ orderId: 'o3' }), row({ orderId: 'o1' })]
    const ask = async (perms: string[], gate: string | null, found = { total: rows.length, rows }) => {
      jest.clearAllMocks()
      mockTienePermiso.mockImplementation((p: string, v: string) => v === 'v1' && perms.includes(p))
      mockPlanGate.mockResolvedValue(gate)
      mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
      mockFindByAmount.mockResolvedValueOnce(found)
      mockCfdiFind.mockResolvedValue([
        { orderId: 'o1', id: 'c1', replacesCfdiId: null, status: 'STAMPED', cancelStatus: null },
        { orderId: 'o2', id: 'c2', replacesCfdiId: null, status: 'STAMPED', cancelStatus: 'REQUESTED' },
      ])
      return parse(await find({ venueId: 'v1', amount: 850, date: '2026-11-17' }))
    }

    const all = await ask(['orders:read', 'cfdi:view'], null)
    expect(all.payments.map((p: { invoice: string }) => p.invoice)).toEqual(['VIGENTE', 'EN_CANCELACION', 'NONE', 'VIGENTE'])
    expect(mockCfdiFind).toHaveBeenCalledTimes(1)
    expect(mockCfdiFind.mock.calls[0][0].where).toMatchObject({ venueId: 'v1', orderId: { in: ['o1', 'o2', 'o3'] } })
    expect(mockPlanGate).toHaveBeenCalledWith('v1', 'CFDI', expect.any(String))
    expect(JSON.stringify(all)).not.toMatch(/c1|c2|o1|o2|o3/)

    const plan = 'La facturación no está incluida en el plan actual de este local (requiere CFDI).'
    const sixRows = { total: 6, rows: [row(), row(), row(), row(), row()] }
    for (const [perms, gate, found] of [
      [['cfdi:view'], null, undefined],
      [['orders:read'], null, undefined],
      [['orders:read', 'cfdi:view'], plan, undefined],
      [['orders:read', 'cfdi:view'], null, sixRows], // más de 5: no se lee ninguna factura (C7)
    ] as Array<[string[], string | null, typeof sixRows | undefined]>) {
      const out = await ask(perms, gate, found)
      expect(out.payments.length).toBeGreaterThan(0)
      for (const p of out.payments) expect(p).not.toHaveProperty('invoice')
      expect(mockCfdiFind).not.toHaveBeenCalled()
    }
  })

  it('if the plan gate throws, the payments are still listed without invoice, and only the error name is logged', async () => {
    class PoolTimeout extends Error {
      name = 'PoolTimeout'
    }
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
    try {
      mockTienePermiso.mockReturnValue(true)
      mockPlanGate.mockRejectedValueOnce(new PoolTimeout('timeout postgres://user:secreto@db/av'))
      mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
      mockFindByAmount.mockResolvedValueOnce({ total: 2, rows: [row({ orderId: 'o1' }), row({ orderId: 'o2' })] })
      const out = parse(await find({ venueId: 'v1', amount: 850, date: '2026-11-17' }))
      expect(out.total).toBe(2)
      expect(out.payments).toHaveLength(2)
      for (const p of out.payments) expect(p).not.toHaveProperty('invoice')
      expect(mockCfdiFind).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
      const logged = JSON.stringify(warn.mock.calls[0])
      expect(logged).toContain('PoolTimeout')
      expect(logged).not.toMatch(/secreto|postgres|timeout/)
    } finally {
      warn.mockRestore()
    }
  })

  it('says it does not include the old system QR payments only for the bridge venue', async () => {
    mockTienePermiso.mockReturnValue(false)
    for (const [venueId, note] of [
      [MINDFORM_NEW_VENUE_ID, 'No incluye los cobros QR del sistema anterior.'],
      ['v1', undefined],
    ] as Array<[string, string | undefined]>) {
      mockVenueFind.mockResolvedValueOnce({ timezone: 'America/Mexico_City' })
      mockFindByAmount.mockResolvedValueOnce({ total: 0, rows: [] })
      const out = parse(await find({ venueId, amount: 850, date: '2026-11-17' }))
      expect(out.note).toBe(note)
    }
  })
})
