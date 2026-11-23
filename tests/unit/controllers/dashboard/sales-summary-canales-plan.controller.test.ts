/**
 * Carril G (hz:fefa11b6:D4), decisión del founder del 22-nov («A»): «Ventas por canal» y «Por tipo de pedido» van en TODOS los
 * planes, como el agrupar por origen o canal de Square y el channel-mix del Inicio. Un negocio en plan Gratis que pide el desglose
 * lo recibe; el candado de ADVANCED_REPORTS sigue sólo para el desglose por comercio y la proyección de depósitos.
 */
import type { Request, Response } from 'express'

const mockGetSalesSummary = jest.fn()
const mockFeatureAccess = jest.fn()

jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  getSalesSummary: (...a: unknown[]) => mockGetSalesSummary(...a),
}))
jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: (...a: unknown[]) => mockFeatureAccess(...a),
}))
jest.mock('@/services/access/rolVigente', () => ({ esSuperadminDeLaSesion: jest.fn().mockResolvedValue(false) }))

import { salesSummaryReport } from '@/controllers/dashboard/sales-summary.dashboard.controller'
import { prismaMock } from '@tests/__helpers__/setup'

const fila = (key: string) => ({
  key,
  grossSales: 100,
  discounts: 0,
  refunds: 0,
  netSales: 100,
  tips: 0,
  platformFees: 0,
  tenderCommissions: 0,
  totalCollected: 100,
  orderCount: 1,
  transactionCount: 1,
  refundCount: 0,
})

function makeRes() {
  const res: Record<string, jest.Mock> = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res as unknown as Response & { json: jest.Mock }
}

const req = (query: Record<string, string>) =>
  ({
    authContext: { venueId: 'v-gratis', userId: 'u1', orgId: 'o1', role: 'OWNER' },
    query: { startDate: '2026-11-22T06:00:00.000Z', endDate: '2026-11-23T05:59:59.999Z', ...query },
    headers: {},
    params: {},
  }) as unknown as Request

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Mexico_City' })
  // Plan Gratis: sin ADVANCED_REPORTS.
  mockFeatureAccess.mockResolvedValue(false)
  mockGetSalesSummary.mockImplementation(async (_v: string, f: { includeChannelBreakdown?: boolean }) => ({
    summary: { netSales: 100 },
    ...(f.includeChannelBreakdown ? { byChannel: [fila('COUNTER')], byOrderType: [fila('DINE_IN')] } : {}),
  }))
})

it('🔴 un negocio en plan Gratis recibe byChannel y byOrderType (sin candado)', async () => {
  const res = makeRes()
  await salesSummaryReport(req({ includeChannelBreakdown: 'true', includePrepaid: 'true' }), res, jest.fn())
  expect(mockGetSalesSummary).toHaveBeenCalledWith(
    'v-gratis',
    expect.objectContaining({ includeChannelBreakdown: true, includePrepaid: true }),
  )
  const { data } = res.json.mock.calls[0][0]
  expect(data.byChannel).toEqual([expect.objectContaining({ key: 'COUNTER' })])
  expect(data.byOrderType).toEqual([expect.objectContaining({ key: 'DINE_IN' })])
  expect(data).not.toHaveProperty('channelBreakdownLocked')
})

it('el desglose por comercio y la proyección de depósitos siguen siendo de Pro', async () => {
  const res = makeRes()
  await salesSummaryReport(
    req({ includeChannelBreakdown: 'true', includeMerchantBreakdown: 'true', includeSettlementProjection: 'true' }),
    res,
    jest.fn(),
  )
  expect(mockGetSalesSummary).toHaveBeenCalledWith(
    'v-gratis',
    expect.objectContaining({ includeChannelBreakdown: true, includeMerchantBreakdown: false, includeSettlementProjection: false }),
  )
})

it('sin pedir el desglose no se consulta el plan', async () => {
  await salesSummaryReport(req({}), makeRes(), jest.fn())
  expect(mockFeatureAccess).not.toHaveBeenCalled()
  expect(mockGetSalesSummary).toHaveBeenCalledWith('v-gratis', expect.objectContaining({ includeChannelBreakdown: false }))
})
