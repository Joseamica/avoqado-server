/**
 * C1 · «Ventas de hoy»: la plantilla y lo que la lectura le pide al panel, sin base. Lo que pasa con la base de verdad (paridad con el
 * panel, Cancún, el puente, la devolución sola) está en `tests/integration/support/data/salesToday.integration.test.ts`.
 */
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({ getSalesSummary: jest.fn() }))

import { getSalesSummary, type SalesSummaryMetrics } from '@/services/dashboard/sales-summary.dashboard.service'
import { MINDFORM_NEW_VENUE_ID } from '@/services/legacy/qrPayments.legacy.service'
import type { DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'
import { salesToday } from '@/services/support/data/capabilities/salesToday'

const scope: DataScope = {
  venueId: 'ckq7z1x2y0000abcd1234efgh',
  organizationId: 'org',
  venueName: 'Flautas Coyoacán',
  timezone: 'America/Mexico_City',
  day: '2026-11-12',
  kycVerified: true,
  now: new Date('2026-11-12T20:32:00Z'), // jueves 12-nov, 14:32 en la CDMX
  rows: 5,
  openOrdersDays: 7,
  depositGroups: 2000,
  depositTimeoutMs: 3000,
}
const summary = (over: Partial<SalesSummaryMetrics> = {}): SalesSummaryMetrics => ({
  grossSales: 12900,
  items: 12900,
  serviceCosts: 0,
  discounts: 200,
  refunds: 354.4,
  netSales: 12345.6,
  deferredSales: 0,
  taxes: 0,
  tips: 1020,
  platformFees: 0,
  staffCommissions: 0,
  commissions: 0,
  totalCollected: 13365.6,
  netProfit: 12345.6,
  transactionCount: 58,
  ...over,
})
const render = (s: SalesSummaryMetrics) => salesToday.render(scope, {}, s)

it('the template of the plan, exactly, and it passes the check', () => {
  const rendered = render(summary())
  expect(rendered.text).toBe(
    [
      'Ventas de hoy, jue 12-nov, en Flautas Coyoacán (corte 14:32):',
      'Ventas brutas $12,900.00 · Descuentos −$200.00 · Devoluciones −$354.40',
      '*Ventas netas $12,345.60*',
      'Propinas (aparte) $1,020.00 · 58 transacciones',
      'Es lo mismo que Reportes › Resumen de ventas.',
    ].join('\n'),
  )
  expect(checkRendered(rendered, scope.timezone)).toBe(true)
})

it('«1 transacción» in singular, a negative net with its minus, and zero as «$0.00»', () => {
  const rendered = render(summary({ grossSales: 0, discounts: 0, refunds: 150, netSales: -150, tips: 0, transactionCount: 1 }))
  expect(rendered.text.split('\n').slice(1, 4)).toEqual([
    'Ventas brutas $0.00 · Descuentos $0.00 · Devoluciones −$150.00',
    '*Ventas netas −$150.00*',
    'Propinas (aparte) $0.00 · 1 transacción',
  ])
  expect(checkRendered(rendered, scope.timezone)).toBe(true)
})

it.each(['grossSales', 'discounts', 'netSales'] as const)(
  'a missing %s throws (the orchestrator answers CHECK_FAILED), never «$0.00»',
  field => expect(() => render(summary({ [field]: null } as Partial<SalesSummaryMetrics>))).toThrow(),
)

describe('read', () => {
  const panel = getSalesSummary as jest.Mock
  beforeEach(() => panel.mockReset())

  it('asks the panel for the whole calendar day of the venue, without the commissions, and returns its summary', async () => {
    panel.mockResolvedValue({ summary: summary(), filtered: false })
    expect(await salesToday.read(scope, {})).toEqual(summary())
    expect(panel.mock.calls).toEqual([
      [
        scope.venueId,
        {
          startDate: '2026-11-12T06:00:00.000Z',
          endDate: '2026-11-13T05:59:59.999Z',
          groupBy: 'none',
          reportType: 'summary',
          timezone: 'America/Mexico_City',
          skipStaffCommissions: true,
        },
      ],
    ])
  })

  it('a summary marked legacyUnavailable is not returned: a plain error, with no amount in it', async () => {
    panel.mockResolvedValue({ summary: summary(), filtered: false, legacyUnavailable: true })
    const err = await salesToday.read(scope, {}).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).not.toMatch(/\d/)
  })
})

describe('params and notOffered', () => {
  it.each([null, 'today'] as const)('day %s is today', day =>
    expect(
      salesToday.params({ capability: 'sales_today', day, amount: null, time: null, otherVenue: false }, '¿cuánto vendí?', scope),
    ).toEqual({
      ok: true,
      value: {},
    }),
  )
  it.each(['yesterday', 'other'] as const)('day %s → SALES_TODAY_ONLY', day =>
    expect(
      salesToday.params({ capability: 'sales_today', day, amount: null, time: null, otherVenue: false }, '¿cuánto vendí ayer?', scope),
    ).toEqual({
      ok: false,
      refusal: 'SALES_TODAY_ONLY',
    }),
  )
  it('the bridge venue is not offered; any other is', () => {
    expect(salesToday.notOffered!({ ...scope, venueId: MINDFORM_NEW_VENUE_ID })).toBe('SALES_LEGACY_QR')
    expect(salesToday.notOffered!(scope)).toBeNull()
  })
})
