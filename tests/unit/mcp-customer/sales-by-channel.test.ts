/**
 * Carril G (hz:fefa11b6:D4, D5): `sales_by_channel` — mismo permiso y mismo candado de rango que la pantalla del Resumen de ventas,
 * en TODOS los planes (decisión del founder del 22-nov), nombres llanos en cada renglón, lo cobrado por adelantado aparte y el
 * aviso del puente QR caído.
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
const mockRangoBloqueado = jest.fn().mockResolvedValue(false)
jest.mock('@/services/dashboard/salesSummaryPlanRange', () => ({
  RESPUESTA_RANGO_FUERA_DEL_PLAN: { message: 'El histórico de ventas requiere el plan Pro.' },
  rangoBloqueadoPorPlan: (...a: unknown[]) => mockRangoBloqueado(...a),
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
beforeEach(() => {
  jest.clearAllMocks()
  // Sin restos de un `mockResolvedValueOnce` de otra prueba.
  mockRangoBloqueado.mockReset().mockResolvedValue(false)
})

it('es de lectura en el catálogo', () => {
  expect(TOOL_EFFECTS.sales_by_channel).toBe('read')
})

it('🔒 pide `reports:read` (el del Resumen de ventas, no `analytics:read`)', async () => {
  mockGetSalesSummary.mockResolvedValue({ summary: { netSales: 10 }, byChannel: [], byOrderType: [] })
  await call({ venueId: 'v1' })
  expect(mockRequirePermission).toHaveBeenCalledWith('reports:read', 'v1')
})

describe('🔴 todos los planes (decisión del founder del 22-nov): sin candado de plan, con el candado de rango del panel', () => {
  it('un negocio en plan Gratis recibe byChannel y byOrderType de hoy', async () => {
    mockRangoBloqueado.mockResolvedValue(false)
    mockGetSalesSummary.mockResolvedValue({
      summary: { netSales: 10 },
      byChannel: [fila('COUNTER', 10)],
      byOrderType: [fila('DINE_IN', 10)],
    })
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
    const out = parse(await call({ venueId: 'v1', fromDate: hoy, toDate: hoy }))
    expect(mockPlanGate).not.toHaveBeenCalled()
    expect(out.byChannel).toEqual([expect.objectContaining({ key: 'COUNTER', label: 'Mostrador' })])
    expect(out.byOrderType).toEqual([expect.objectContaining({ key: 'DINE_IN' })])
  })

  it('sin fechas, en un negocio Gratis se le da «hoy» en vez de rechazarlo', async () => {
    mockRangoBloqueado.mockResolvedValueOnce(true).mockResolvedValue(false)
    mockGetSalesSummary.mockResolvedValue({ summary: { netSales: 10 }, byChannel: [], byOrderType: [] })
    const out = parse(await call({ venueId: 'v1' }))
    const { startDate, endDate } = mockGetSalesSummary.mock.calls[0][1]
    const dia = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
    expect(dia(startDate)).toBe(dia(endDate))
    expect(dia(endDate)).toBe(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }))
    expect(out.headline).toMatchObject({ netSales: 10 })
  })

  it('🔴 Codex r7 #1 · sólo con la fecha final de hoy, un negocio Gratis también recibe «hoy»', async () => {
    mockRangoBloqueado.mockResolvedValueOnce(true).mockResolvedValue(false)
    mockGetSalesSummary.mockResolvedValue({ summary: { netSales: 10 }, byChannel: [], byOrderType: [] })
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
    const out = parse(await call({ venueId: 'v1', toDate: hoy }))
    const { startDate } = mockGetSalesSummary.mock.calls[0][1]
    expect(new Date(startDate).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })).toBe(hoy)
    expect(out.headline).toMatchObject({ netSales: 10 })
  })

  it('🔴 Codex r8 #1 · sólo con una fecha final antigua, un negocio Gratis recibe el aviso de plan (no «inicio después del fin»)', async () => {
    mockRangoBloqueado.mockResolvedValueOnce(true)
    const out = parse(await call({ venueId: 'v1', toDate: '2026-11-01' }))
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockGetSalesSummary).not.toHaveBeenCalled()
  })

  it('sólo con una fecha final de otro día, un negocio Gratis recibe el aviso de plan', async () => {
    mockRangoBloqueado.mockResolvedValueOnce(true)
    const ayer = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })
    const out = parse(await call({ venueId: 'v1', toDate: ayer }))
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockGetSalesSummary).not.toHaveBeenCalled()
  })

  it('con fechas de histórico, un negocio Gratis recibe el mismo aviso de plan que el panel', async () => {
    mockRangoBloqueado.mockResolvedValueOnce(true)
    const out = parse(await call({ venueId: 'v1', fromDate: '2026-11-01', toDate: '2026-11-07' }))
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockGetSalesSummary).not.toHaveBeenCalled()
  })
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

  it('🔴 Codex r8 #1 · sólo con la fecha final son los siete días que terminan ese día (no un rango al revés)', () => {
    expect(rangoDelNegocio('America/Mexico_City', undefined, '2026-11-01')).toEqual({
      startDate: '2026-10-26T06:00:00.000Z',
      endDate: '2026-11-02T05:59:59.999Z',
    })
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

it('🔴 Codex r5 #1 · el superadmin en un negocio Gratis recibe «hoy», pero el histórico tiene el mismo candado de rango que el panel', async () => {
  const handlers3 = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  registerSalesByChannelTools(
    { tool: (...a: unknown[]) => handlers3.set(a[0] as string, a[a.length - 1] as never) } as never,
    { ...scope, isSuperAdmin: true } as McpScope,
  )
  mockRangoBloqueado.mockResolvedValueOnce(true)
  const out = parse(await handlers3.get('sales_by_channel')!({ venueId: 'v1', fromDate: '2026-11-01', toDate: '2026-11-07' }, {}))
  expect(out).toMatchObject({ ok: false, planRequired: true })
  expect(mockGetSalesSummary).not.toHaveBeenCalled()
})
