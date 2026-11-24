/**
 * Carril F2 (hz:fefa11b6:D7): `compare_sales_periods` — el Resumen de ventas contra otro periodo con las mismas cifras y reglas que el
 * panel. Pro, `reports:read`, catálogo libre (no en el certificado), un solo reloj para «hoy» y el corte, anticipos en los dos lados.
 */
import { registerCompareSalesPeriodsTools } from '../../../src/mcp/tools/compareSalesPeriods'
import { TOOL_EFFECTS } from '../../../src/mcp/catalog'
import { DIRECTORY_TIERS } from '../../../src/mcp/directory/catalog'
import type { McpScope } from '../../../src/mcp/scope'

const mockGetSalesSummary = jest.fn()
const mockRequirePermission = jest.fn()
const mockBloqueada = jest.fn()

jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/sales-summary.dashboard.service'),
  getSalesSummary: (...a: unknown[]) => mockGetSalesSummary(...(a as [])),
}))
jest.mock('@/services/dashboard/salesSummaryPlanRange', () => ({
  comparacionBloqueadaPorPlan: (...a: unknown[]) => mockBloqueada(...a),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => ({ venueId: { in: [v] } }),
    requirePermission: (...a: unknown[]) => mockRequirePermission(...a),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn().mockResolvedValue({ timezone: 'GMT-6' }) } },
}))

const MINDFORM = 'cmisvi38o001fhr2828ygmxi2'
const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1', MINDFORM], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('compare_sales_periods')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
// lun 23-nov-2026, 2:00 p. m. en la Ciudad de México.
const AHORA = new Date('2026-11-23T20:00:00.000Z')

const resumen = (o: Record<string, unknown> = {}) => ({
  grossSales: 1000,
  netSales: 1000,
  totalCollected: 1000,
  transactionCount: 10,
  ...o,
})

beforeAll(() => {
  registerCompareSalesPeriodsTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.useFakeTimers({ now: AHORA, doNotFake: ['nextTick', 'setImmediate'] })
  jest.clearAllMocks()
  mockBloqueada.mockReset().mockResolvedValue(false)
  mockGetSalesSummary
    .mockReset()
    .mockResolvedValueOnce({
      summary: resumen({ grossSales: 1500, packagesSoldOnlineOtherCurrencies: [{ currency: 'USD', amount: 100, count: 1 }] }),
    })
    .mockResolvedValueOnce({ summary: resumen() })
})
afterEach(() => jest.useRealTimers())

it('es de lectura y va sólo al catálogo libre (no al certificado)', () => {
  expect(TOOL_EFFECTS.compare_sales_periods).toBe('read')
  expect(DIRECTORY_TIERS.flatMap(t => [...t.tools])).not.toContain('compare_sales_periods')
})

it('🔒 pide `reports:read`, como el Resumen de ventas', async () => {
  await call({ venueId: 'v1' })
  expect(mockRequirePermission).toHaveBeenCalledWith('reports:read', 'v1')
})

it('🔴 sin Pro: aviso de plan y no lee nada', async () => {
  mockBloqueada.mockResolvedValue(true)
  const out = parse(await call({ venueId: 'v1' }))
  expect(out).toEqual({ ok: false, planRequired: true, error: 'Comparar con otro periodo requiere el plan Pro.' })
  expect(mockGetSalesSummary).not.toHaveBeenCalled()
})

it('🔴 sin fechas: los 7 días que terminan hoy («GMT-6» = Ciudad de México), hasta la misma hora, con anticipos en los dos lados', async () => {
  const out = parse(await call({ venueId: 'v1' }))
  const [, actual] = mockGetSalesSummary.mock.calls[0]
  const [, otro] = mockGetSalesSummary.mock.calls[1]
  expect(actual).toMatchObject({ startDate: '2026-11-17T06:00:00.000Z', endDate: AHORA.toISOString(), includePrepaid: true })
  expect(otro).toMatchObject({ startDate: '2026-11-10T06:00:00.000Z', endDate: '2026-11-16T20:00:00.000Z', includePrepaid: true })
  expect(out).toMatchObject({
    compareTo: 'previous_period',
    timezone: 'America/Mexico_City',
    untilSameTime: true,
    current: { startDate: '2026-11-17T06:00:00.000Z', endDate: AHORA.toISOString() },
  })
  expect(out.lines.find((l: { key: string }) => l.key === 'grossSales')).toEqual({
    key: 'grossSales',
    label: 'Ventas brutas',
    current: 1500,
    compared: 1000,
    change: { difference: 500, percent: 50, isNew: false },
  })
  expect(out.packagesSoldOnlineOtherCurrencies).toEqual({ current: [{ currency: 'USD', amount: 100, count: 1 }], compared: [] })
})

it('🔴 el negocio del QR anterior: lo dice y no calcula el cambio; y avisa si el lado actual no pudo leer el puente', async () => {
  mockGetSalesSummary
    .mockReset()
    .mockResolvedValueOnce({ summary: resumen({ grossSales: 1500 }), legacyUnavailable: true })
    .mockResolvedValueOnce({ summary: resumen() })
  const out = parse(await call({ venueId: MINDFORM, fromDate: '2026-11-16', toDate: '2026-11-22' }))
  expect(out.excludesLegacyQr).toBe(true)
  expect(out.avisoQrAnterior).toMatch(/no incluye los cobros del QR anterior/)
  expect(out.legacyUnavailable).toBe(true)
  expect(out.lines.every((l: { change: unknown }) => l.change === null)).toBe(true)
})

it('🔴 lo que no se puede comparar se dice sin leer nada (ni el reporte de siempre): un periodo que no empieza y más de un año', async () => {
  mockGetSalesSummary.mockReset().mockResolvedValue({ summary: resumen() })
  const noEmpieza = parse(await call({ venueId: 'v1', fromDate: '2026-11-24', toDate: '2026-11-24', compareTo: 'previous_year' }))
  expect(noEmpieza).toEqual({ ok: false, error: 'Ese periodo todavía no empieza: no hay con qué compararlo.' })
  const largo = parse(await call({ venueId: 'v1', fromDate: '2025-01-01', toDate: '2026-11-23' }))
  expect(largo.ok).toBe(false)
  expect(largo.error).toMatch(/año o menos/)
  expect(mockGetSalesSummary).not.toHaveBeenCalled()
})
