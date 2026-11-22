/**
 * Carril G (hz:fefa11b6:D4, D5): `sales_by_channel` — mismo permiso y mismo candado que la pantalla del Resumen de ventas, nombres
 * llanos en cada renglón, lo cobrado por adelantado aparte y el aviso del puente QR caído.
 */
import { rangoDelNegocio, registerSalesByChannelTools } from '../../../src/mcp/tools/salesByChannel'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'
import type { McpScope } from '../../../src/mcp/scope'

const mockPlanGate = jest.fn()
const mockGetSalesSummary = jest.fn()
const mockRequirePermission = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  getSalesSummary: (...a: unknown[]) => mockGetSalesSummary(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...a),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn().mockResolvedValue({ timezone: 'America/Mexico_City' }) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('sales_by_channel')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const fila = (key: string, netSales: number) => ({
  key,
  grossSales: netSales,
  discounts: 0,
  refunds: 0,
  netSales,
  tips: 0,
  platformFees: 0,
  tenderCommissions: 0,
  totalCollected: netSales,
  orderCount: 1,
  transactionCount: 1,
  refundCount: 0,
})

beforeAll(() => {
  registerSalesByChannelTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

it('es de lectura en el catálogo', () => {
  expect(TOOL_EFFECTS.sales_by_channel).toBe('read')
})

it('🔒 pide `reports:read` (el del Resumen de ventas, no `analytics:read`) y el candado ADVANCED_REPORTS', async () => {
  mockPlanGate.mockResolvedValue('Las ventas por canal no está incluido en el plan actual de este local (requiere ADVANCED_REPORTS).')
  const out = parse(await call({ venueId: 'v1' }))
  expect(mockRequirePermission).toHaveBeenCalledWith('reports:read', 'v1')
  expect(mockPlanGate).toHaveBeenCalledWith('v1', 'ADVANCED_REPORTS', expect.any(String))
  expect(out).toMatchObject({ ok: false, planRequired: true })
  expect(mockGetSalesSummary).not.toHaveBeenCalled()
})

it('pide el desglose y lo cobrado por adelantado, y devuelve cada renglón con su nombre llano', async () => {
  mockPlanGate.mockResolvedValue(null)
  mockGetSalesSummary.mockResolvedValue({
    summary: {
      netSales: 300,
      grossSales: 300,
      transactionCount: 2,
      packagesSoldOnline: 1200,
      packagesSoldOnlineCount: 1,
      reservationDeposits: 50,
      reservationDepositsCount: 1,
      reservationDepositsRefunded: 0,
    },
    byChannel: [fila('RAPPI', 200), fila('TABLES', 100)],
    byOrderType: [fila('DELIVERY', 200), fila('QUICK_PAYMENT', 100)],
  })
  const out = parse(await call({ venueId: 'v1', fromDate: '2026-11-01', toDate: '2026-11-07' }))
  expect(mockGetSalesSummary).toHaveBeenCalledWith('v1', expect.objectContaining({ includeChannelBreakdown: true, includePrepaid: true }))
  expect(out.byChannel.map((f: { label: string }) => f.label)).toEqual(['Rappi', 'Mesas'])
  expect(out.byOrderType.map((f: { label: string }) => f.label)).toEqual(['A domicilio', 'Cobro de un monto'])
  expect(out.headline).toMatchObject({ netSales: 300, transactionCount: 2, refundCount: 0 })
  expect(out.collectedInAdvanceNotSales).toMatchObject({
    packagesSoldOnline: { amount: 1200, count: 1 },
    reservationDeposits: { amount: 50, count: 1, refunded: 0 },
  })
  expect(out.legacyUnavailable).toBeUndefined()
})

it('con el puente de cobros QR viejos caído lo dice (las cifras pueden estar incompletas)', async () => {
  mockPlanGate.mockResolvedValue(null)
  mockGetSalesSummary.mockResolvedValue({ summary: { netSales: 0 }, byChannel: [], byOrderType: [], legacyUnavailable: true })
  const out = parse(await call({ venueId: 'v1' }))
  expect(out.legacyUnavailable).toBe(true)
  expect(typeof out.aviso).toBe('string')
})

describe('rangoDelNegocio (Codex r2 #7)', () => {
  it('sin fechas son hoy y los seis días anteriores, como el panel (no ocho)', () => {
    const r = rangoDelNegocio('America/Mexico_City') as { startDate: string; endDate: string }
    const dias = (new Date(r.endDate).getTime() - new Date(r.startDate).getTime()) / 86_400_000
    expect(Math.round(dias)).toBe(7)
  })

  it('las fechas van en días del negocio', () => {
    expect(rangoDelNegocio('America/Mexico_City', '2026-11-01', '2026-11-07')).toEqual({
      startDate: '2026-11-01T06:00:00.000Z',
      endDate: '2026-11-08T05:59:59.999Z',
    })
  })

  it('una fecha que no existe o al revés se rechaza en vez de moverse sola', () => {
    expect(rangoDelNegocio('America/Mexico_City', '2026-02-30')).toHaveProperty('error')
    expect(rangoDelNegocio('America/Mexico_City', '2026-11-07', '2026-11-01')).toHaveProperty('error')
  })

  it('la tool contesta el error sin consultar el reporte', async () => {
    mockPlanGate.mockResolvedValue(null)
    const out = parse(await call({ venueId: 'v1', fromDate: '2026-02-30' }))
    expect(out.ok).toBe(false)
    expect(mockGetSalesSummary).not.toHaveBeenCalled()
  })
})

it('🔴 los paquetes en otra moneda salen aparte y nunca se suman a los pesos (Codex r2 #5)', async () => {
  mockPlanGate.mockResolvedValue(null)
  mockGetSalesSummary.mockResolvedValue({
    summary: {
      netSales: 0,
      packagesSoldOnline: 1200,
      packagesSoldOnlineCount: 1,
      packagesSoldOnlineOtherCurrencies: [{ currency: 'USD', amount: 100, count: 1 }],
    },
    byChannel: [],
    byOrderType: [],
  })
  const out = parse(await call({ venueId: 'v1' }))
  expect(out.collectedInAdvanceNotSales.packagesSoldOnline).toEqual({ amount: 1200, count: 1, currency: 'MXN' })
  expect(out.collectedInAdvanceNotSales.packagesSoldOnlineOtherCurrencies).toEqual([{ currency: 'USD', amount: 100, count: 1 }])
})
