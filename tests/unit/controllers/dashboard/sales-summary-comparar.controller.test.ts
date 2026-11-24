/**
 * Carril F2 (hz:fefa11b6:D7): `compareTo` en el GET del Resumen de ventas. Una sola petición trae el reporte de siempre y la
 * comparación; lo que impide comparar va en `comparison.status` y el reporte sale igual. Sin `compareTo`, todo como hoy.
 * También: los 400 esperados (filtro de comercio) se registran como `warn`, no como `error` (re-revisión del carril F).
 */
import type { Request, Response } from 'express'

const mockGetSalesSummary = jest.fn()
const mockConfig = jest.fn()
const mockPlan = jest.fn()

jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/sales-summary.dashboard.service'),
  getSalesSummary: (...a: unknown[]) => mockGetSalesSummary(...a),
}))
jest.mock('@/services/organization-payment-config.service', () => ({
  ...jest.requireActual('@/services/organization-payment-config.service'),
  getEffectivePaymentConfig: (...a: unknown[]) => mockConfig(...a),
}))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: (...a: unknown[]) => mockPlan(...a) }))
jest.mock('@/services/access/rolVigente', () => ({ esSuperadminDeLaSesion: jest.fn().mockResolvedValue(false) }))

import logger from '@/config/logger'
import { salesSummaryExport, salesSummaryReport } from '@/controllers/dashboard/sales-summary.dashboard.controller'
import { MINDFORM_NEW_VENUE_ID } from '@/services/legacy/qrPayments.legacy.service'
import { prismaMock } from '@tests/__helpers__/setup'

// lun 23-nov-2026, 2:00 p. m. en la Ciudad de México.
const AHORA = new Date('2026-11-23T20:00:00.000Z')
const HOY = { startDate: '2026-11-23T06:00:00.000Z', endDate: '2026-11-24T05:59:59.999Z' }
const SEMANA_PASADA = { startDate: '2026-11-16T06:00:00.000Z', endDate: '2026-11-23T05:59:59.999Z' }

const resumen = (o: Record<string, unknown> = {}) => ({
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
  ...o,
})

const req = (query: Record<string, string>, venueId = 'v1') =>
  ({
    authContext: { venueId, userId: 'u1', orgId: 'o1', role: 'OWNER' },
    query: { ...HOY, ...query },
    headers: {},
    params: {},
  }) as unknown as Request

function makeRes() {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  res.setHeader = jest.fn(() => res)
  res.send = jest.fn(() => res)
  return res as unknown as Response & Record<string, jest.Mock>
}

async function pedir(query: Record<string, string>, venueId = 'v1') {
  const res = makeRes()
  const next = jest.fn()
  await salesSummaryReport(req(query, venueId), res, next)
  return { data: (res.json as unknown as jest.Mock).mock.calls[0]?.[0]?.data, next }
}

beforeEach(() => {
  jest.useFakeTimers({ now: AHORA, doNotFake: ['nextTick', 'setImmediate'] })
  jest.clearAllMocks()
  ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Mexico_City' })
  mockConfig.mockResolvedValue({ config: {} })
  mockPlan.mockResolvedValue(true)
  // 1ª llamada: el periodo actual; 2ª: el comparado.
  mockGetSalesSummary
    .mockReset()
    .mockResolvedValueOnce({ summary: resumen({ grossSales: 1200, totalCollected: 1200, transactionCount: 12 }), filtered: false })
    .mockResolvedValueOnce({ summary: resumen(), filtered: false })
})
afterEach(() => jest.useRealTimers())

describe('GET del Resumen de ventas con compareTo', () => {
  it('sin compareTo: una sola lectura, los filtros de siempre y sin `comparison` (regresión)', async () => {
    const { data } = await pedir({ includePrepaid: 'true' })
    expect(mockGetSalesSummary).toHaveBeenCalledTimes(1)
    expect(mockGetSalesSummary.mock.calls[0][1]).toMatchObject({ ...HOY, includePrepaid: true })
    expect(data.comparison).toBeUndefined()
  })

  it('🔴 compareTo con otro valor ⇒ 400 en español y no calcula', async () => {
    const { next } = await pedir({ compareTo: 'last_decade' })
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 })
    expect(next.mock.calls[0][0].message).toMatch(/compareTo no válido/)
    expect(mockGetSalesSummary).not.toHaveBeenCalled()
  })

  it('🔴 «Hoy» a la mitad: el actual se lee hasta T y el comparado (ayer) hasta la misma hora, liviano y sin el QR anterior', async () => {
    const { data } = await pedir({
      compareTo: 'previous_period',
      groupBy: 'paymentMethod',
      includeMerchantBreakdown: 'true',
      includePrepaid: 'true',
      reportType: 'days',
    })
    expect(mockGetSalesSummary).toHaveBeenCalledTimes(2)
    const [, actual] = mockGetSalesSummary.mock.calls[0]
    const [, otro] = mockGetSalesSummary.mock.calls[1]
    expect(actual).toMatchObject({ startDate: HOY.startDate, endDate: AHORA.toISOString(), groupBy: 'paymentMethod', reportType: 'days' })
    expect(otro).toEqual({
      startDate: '2026-11-22T06:00:00.000Z',
      endDate: '2026-11-22T20:00:00.000Z',
      groupBy: 'none',
      reportType: 'summary',
      timezone: 'America/Mexico_City',
      merchantAccountId: undefined,
      paymentMethod: undefined,
      cardType: undefined,
      includePrepaid: true,
      skipLegacyQr: true,
    })
    expect(data.comparison).toMatchObject({
      compareTo: 'previous_period',
      status: 'ok',
      asOf: AHORA.toISOString(),
      baseRange: { startDate: HOY.startDate, endDate: AHORA.toISOString() },
      dateRange: { startDate: '2026-11-22T06:00:00.000Z', endDate: '2026-11-22T20:00:00.000Z' },
      untilSameTime: true,
      matchedWeekday: false,
    })
    expect(data.comparison.changes.grossSales).toEqual({ difference: 200, percent: 20, isNew: false })
    expect(data.comparison.changes.transactionCount).toEqual({ difference: 2, percent: 20, isNew: false })
    expect(data.comparison.summary.grossSales).toBe(1000)
  })

  it('un periodo cerrado no se corta: «Semana pasada» contra 52 semanas antes', async () => {
    const { data } = await pedir({ ...SEMANA_PASADA, compareTo: 'previous_year' })
    expect(mockGetSalesSummary.mock.calls[0][1]).toMatchObject(SEMANA_PASADA)
    expect(data.comparison).toMatchObject({ status: 'ok', untilSameTime: false, matchedWeekday: true })
  })

  it('🔴 sin Pro: el reporte sale y `comparison.status` = plan, sin leer el comparado', async () => {
    mockPlan.mockResolvedValue(false)
    const { data } = await pedir({ compareTo: 'previous_period' })
    expect(mockGetSalesSummary).toHaveBeenCalledTimes(1)
    expect(data.summary.grossSales).toBe(1200)
    expect(data.comparison).toEqual({
      compareTo: 'previous_period',
      status: 'plan',
      message: 'Comparar con otro periodo requiere el plan Pro.',
    })
  })

  it('🔴 un periodo que no empieza ⇒ notStarted; más de un año ⇒ tooLong (el reporte sale igual)', async () => {
    let r = await pedir({ startDate: '2026-11-24T06:00:00.000Z', endDate: '2026-11-25T05:59:59.999Z', compareTo: 'previous_period' })
    expect(r.data.comparison.status).toBe('notStarted')
    mockGetSalesSummary.mockReset().mockResolvedValue({ summary: resumen(), filtered: false })
    r = await pedir({ startDate: '2000-01-01T06:00:00.000Z', compareTo: 'previous_year' })
    expect(r.data.comparison.status).toBe('tooLong')
    expect(mockGetSalesSummary).toHaveBeenCalledTimes(1)
  })

  it('🔴 el negocio del QR anterior: el comparado no lo trae, lo dice y no se calcula el cambio', async () => {
    const { data } = await pedir({ ...SEMANA_PASADA, compareTo: 'previous_period' }, MINDFORM_NEW_VENUE_ID)
    expect(mockGetSalesSummary.mock.calls[1][1]).toMatchObject({ skipLegacyQr: true })
    expect(data.comparison.excludesLegacyQr).toBe(true)
    expect(Object.values(data.comparison.changes).every(v => v === null)).toBe(true)
    expect(data.comparison.summary.grossSales).toBe(1000)
  })

  it('🔴 con el filtro «QR anterior»: `legacyQr` sin leer el comparado', async () => {
    const { data } = await pedir({ ...SEMANA_PASADA, compareTo: 'previous_period', paymentMethod: 'QR_LEGACY' }, MINDFORM_NEW_VENUE_ID)
    expect(mockGetSalesSummary).toHaveBeenCalledTimes(1)
    expect(data.comparison).toMatchObject({ status: 'legacyQr' })
  })
})

describe('los 400 esperados del filtro de comercio se registran como warn', () => {
  it('🔴 GET y exporte: un comercio de otro negocio ⇒ warn, no error', async () => {
    const warn = jest.spyOn(logger, 'warn')
    const error = jest.spyOn(logger, 'error')
    ;(prismaMock.payment.findFirst as jest.Mock).mockResolvedValue(null)
    const ajeno = 'clajenosse01234567890123a'
    await salesSummaryReport(req({ merchantAccountId: ajeno }), makeRes(), jest.fn())
    await salesSummaryExport(req({ merchantAccountId: ajeno, mode: 'summary', format: 'csv' }), makeRes(), jest.fn())
    expect(warn).toHaveBeenCalledWith(
      'Sales summary report rejected:',
      expect.objectContaining({ message: expect.stringMatching(/comercio/) }),
    )
    expect(warn).toHaveBeenCalledWith(
      'Sales summary export rejected:',
      expect.objectContaining({ message: expect.stringMatching(/comercio/) }),
    )
    expect(error).not.toHaveBeenCalledWith('Sales summary report error:', expect.anything())
    expect(error).not.toHaveBeenCalledWith('Sales summary export error:', expect.anything())
  })

  it('una falla de verdad (500) sigue siendo error', async () => {
    const error = jest.spyOn(logger, 'error')
    mockGetSalesSummary.mockReset().mockRejectedValue(new Error('se cayó la base'))
    await salesSummaryReport(req({}), makeRes(), jest.fn())
    expect(error).toHaveBeenCalledWith('Sales summary report error:', expect.any(Error))
  })
})
