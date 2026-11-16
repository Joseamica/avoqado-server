/**
 * D15 (16-nov-2026) — las herramientas de ventas del MCP dicen cuándo no se pudieron leer los cobros QR legacy de Mindform.
 *
 * Antes: el servicio devolvía una suma parcial y la herramienta la presentaba como total. Ahora la respuesta trae
 * `legacyUnavailable: true` y un `aviso` en español para que el asistente lo diga. Sólo es texto de la respuesta: no cambia
 * nombres, descripciones ni entradas (las cuatro herramientas están en el catálogo certificado).
 */
import { registerSalesTools } from '../../../src/mcp/tools/sales'
import type { McpScope } from '../../../src/mcp/scope'

const mockPorMetodo = jest.fn()
const mockPropinasPorCajero = jest.fn()
const mockGrafica = jest.fn()
const mockResumen = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/legacy/mergedPayments.service', () => ({
  aggregatePaymentsByMethod: (...a: unknown[]) => mockPorMetodo(...(a as [])),
  aggregateGiftCardLoads: jest.fn().mockResolvedValue({ amount: 0, count: 0 }),
  aggregateTipsByProcessor: (...a: unknown[]) => mockPropinasPorCajero(...(a as [])),
}))
jest.mock('@/mcp/chartData', () => ({ getVenueChartData: (...a: unknown[]) => mockGrafica(...(a as [])) }))
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/sales-summary.dashboard.service'),
  getSalesSummary: (...a: unknown[]) => mockResumen(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v?: string) => ({ venueId: { in: [v ?? 'v1'] } }), requirePermission: jest.fn() }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn().mockResolvedValue({ timezone: 'America/Mexico_City' }) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = async (n: string, args: Record<string, unknown> = {}) => {
  const r = await handlers.get(n)!({ venueId: 'v1', fromDate: '2026-10-01', toDate: '2026-10-31', ...args }, {})
  return JSON.parse(r.content[0].text)
}

/** Lo que devuelve el servicio cuando el puente no contestó: su arreglo de siempre, marcado. */
const marcado = <T>(filas: T[]) => Object.assign(filas, { legacyUnavailable: true as const })
const AVISO = /cobros del sistema anterior de QR.*incompleto/

const REPORTE = {
  dateRange: { startDate: new Date('2026-10-01'), endDate: new Date('2026-10-31') },
  reportType: 'summary' as const,
  summary: {
    grossSales: 1000,
    items: 1000,
    serviceCosts: 0,
    discounts: 0,
    refunds: 0,
    netSales: 1000,
    deferredSales: 0,
    taxes: 0,
    tips: 0,
    platformFees: 0,
    staffCommissions: 0,
    commissions: 0,
    totalCollected: 1000,
    netProfit: 1000,
    transactionCount: 10,
  },
  filtered: false,
}

beforeAll(() => {
  registerSalesTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})

describe('sales_by_payment_method', () => {
  it('🔴 avisa si CUALQUIERA de sus dos sumas (cobrado o ventas) viene marcada', async () => {
    mockPorMetodo
      .mockResolvedValueOnce([{ method: 'CASH', amount: 100, tips: 0, count: 1 }]) // cobrado: completo
      .mockResolvedValueOnce(marcado([{ method: 'CASH', amount: 100, tips: 0, count: 1 }])) // ventas: parcial

    const out = await call('sales_by_payment_method')

    expect(out.legacyUnavailable).toBe(true)
    expect(out.aviso).toMatch(AVISO)
    expect(out.grossCollected.total).toBe(100) // sigue contestando lo que sí pudo leer
  })

  it('con el puente sano no dice nada', async () => {
    mockPorMetodo.mockResolvedValue([{ method: 'CASH', amount: 100, tips: 0, count: 1 }])
    const out = await call('sales_by_payment_method')
    expect(out).not.toHaveProperty('legacyUnavailable')
    expect(out).not.toHaveProperty('aviso')
  })
})

describe('staff_tips', () => {
  it('🔴 avisa cuando las propinas por cajero vienen marcadas', async () => {
    mockPropinasPorCajero.mockResolvedValue(marcado([{ processedById: null, processedByName: null, tips: 50, payments: 5 }]))

    const out = await call('staff_tips')

    expect(out.legacyUnavailable).toBe(true)
    expect(out.aviso).toMatch(AVISO)
    expect(out.total).toBe(50)
  })

  it('con el puente sano no dice nada', async () => {
    mockPropinasPorCajero.mockResolvedValue([{ processedById: null, processedByName: null, tips: 50, payments: 5 }])
    const out = await call('staff_tips')
    expect(out).not.toHaveProperty('legacyUnavailable')
    expect(out).not.toHaveProperty('aviso')
  })
})

describe('tips_over_time (Codex r1 #1)', () => {
  const serie = [{ createdAt: '2026-10-20T18:00:00.000Z', tips: [{ amount: 10 }] }]

  it('🔴 avisa cuando la serie de propinas viene marcada', async () => {
    mockGrafica.mockResolvedValue({ payments: serie, legacyUnavailable: true })

    const out = await call('tips_over_time')

    expect(out.legacyUnavailable).toBe(true)
    expect(out.aviso).toMatch(AVISO)
    expect(out.total).toBe(10)
  })

  it('con el puente sano no dice nada', async () => {
    mockGrafica.mockResolvedValue({ payments: serie })
    const out = await call('tips_over_time')
    expect(out).not.toHaveProperty('legacyUnavailable')
    expect(out).not.toHaveProperty('aviso')
  })
})

describe('export_sales_summary (Codex r1 #3)', () => {
  it('🔴 avisa arriba y también como primera fila del exporte', async () => {
    mockResumen.mockResolvedValue({ ...REPORTE, legacyUnavailable: true })

    const out = await call('export_sales_summary', { mode: 'summary' })

    expect(out.legacyUnavailable).toBe(true)
    expect(out.aviso).toMatch(AVISO)
    expect(out.rows[0]).toMatchObject({ section: 'aviso', label: expect.stringMatching(AVISO), amount: null })
    expect(out.rows.some((r: { label: string }) => r.label === 'Total cobrado')).toBe(true)
  })

  it('con el puente sano no dice nada', async () => {
    mockResumen.mockResolvedValue(REPORTE)
    const out = await call('export_sales_summary', { mode: 'summary' })
    expect(out).not.toHaveProperty('legacyUnavailable')
    expect(out.rows.some((r: { section: string }) => r.section === 'aviso')).toBe(false)
  })
})
