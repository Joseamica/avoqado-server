/**
 * Agregados en Postgres del puente legacy (2026-09-01, query-guard en producción).
 *
 * `aggregatePaymentsByMethod` y `aggregateTipsByProcessor` sustituyen, en las
 * herramientas del MCP, al `fetchPaymentsForAnalytics` que traía TODAS las filas del
 * rango sólo para sumarlas. Este archivo fija tres garantías:
 *  · El `where` es el MISMO que el de las filas (COMPLETED, sin reembolsos salvo que se
 *    pidan, órdenes no canceladas salvo que se pidan, ventana de fechas).
 *  · Un venue que NO es MindForm jamás toca la base legacy (mismo gate que el helper).
 *  · MindForm suma sus QR legacy encima de los grupos de Postgres, con las mismas reglas.
 *
 * Los números al centavo contra base real viven en
 * tests/integration/mcp/sales-aggregates.integration.test.ts.
 */
import {
  aggregatePaymentsByMethod,
  aggregateTipsByProcessor,
  MAX_CAJEROS_CON_NOMBRE,
} from '../../../../src/services/legacy/mergedPayments.service'

const MINDFORM = 'cmisvi38o001fhr2828ygmxi2'
const mockGroupBy = jest.fn()
const mockStaffFindMany = jest.fn()
const mockGetLegacy = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { groupBy: (...a: unknown[]) => mockGroupBy(...(a as [])) },
    staff: { findMany: (...a: unknown[]) => mockStaffFindMany(...(a as [])) },
  },
}))
jest.mock('@/services/legacy/qrPayments.legacy.service', () => ({
  MINDFORM_NEW_VENUE_ID: 'cmisvi38o001fhr2828ygmxi2',
  forEachLegacyPaymentPage: async (filters: unknown, consume: (rows: unknown[]) => unknown) => {
    const page = await mockGetLegacy(filters)
    return consume(page.rows)
  },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

const filters = { fromDate: new Date('2026-06-01T06:00:00.000Z'), toDate: new Date('2026-07-01T05:59:59.999Z') }

beforeEach(() => {
  jest.clearAllMocks()
  mockStaffFindMany.mockResolvedValue([])
  mockGetLegacy.mockResolvedValue({ rows: [] })
})

describe('aggregatePaymentsByMethod', () => {
  it('pide a Postgres UNA fila por método con el mismo where que las filas (defaults: sin reembolsos, sin canceladas)', async () => {
    mockGroupBy.mockResolvedValue([
      { method: 'CASH', _sum: { amount: '150.50', tipAmount: '10' }, _count: { _all: 2 } },
      { method: 'CREDIT_CARD', _sum: { amount: 99.99, tipAmount: 0 }, _count: { _all: 1 } },
    ])

    const out = await aggregatePaymentsByMethod('v1', filters)

    expect(mockGroupBy).toHaveBeenCalledTimes(1)
    const args = mockGroupBy.mock.calls[0][0]
    expect(args.by).toEqual(['method'])
    expect(args._sum).toEqual({ amount: true, tipAmount: true })
    expect(args.where).toEqual({
      venueId: 'v1',
      status: 'COMPLETED',
      createdAt: { gte: filters.fromDate, lte: filters.toDate },
      type: { not: 'REFUND' },
      order: { status: { not: 'CANCELLED' } },
    })
    expect(out).toEqual([
      { method: 'CASH', amount: 150.5, tips: 10, count: 2 },
      { method: 'CREDIT_CARD', amount: 99.99, tips: 0, count: 1 },
    ])
    expect(mockGetLegacy).not.toHaveBeenCalled() // gate: otros venues no tocan la base legacy
  })

  it('includeRefunds + excludeCancelledOrders=false quitan esos dos filtros (el "gross" del panel)', async () => {
    mockGroupBy.mockResolvedValue([])
    await aggregatePaymentsByMethod('v1', { ...filters, includeRefunds: true, excludeCancelledOrders: false })
    const where = mockGroupBy.mock.calls[0][0].where
    expect(where.type).toBeUndefined()
    expect(where.order).toBeUndefined()
    expect(where.status).toBe('COMPLETED')
  })

  it('una suma nula (grupo vacío) cuenta como 0, no como NaN', async () => {
    mockGroupBy.mockResolvedValue([{ method: 'OTHER', _sum: { amount: null, tipAmount: null }, _count: { _all: 0 } }])
    expect(await aggregatePaymentsByMethod('v1', filters)).toEqual([{ method: 'OTHER', amount: 0, tips: 0, count: 0 }])
  })

  it('MindForm: suma los QR legacy encima de los grupos, con las MISMAS reglas (COMPLETED, sin REFUND por default)', async () => {
    mockGroupBy.mockResolvedValue([{ method: 'CASH', _sum: { amount: 100, tipAmount: 5 }, _count: { _all: 1 } }])
    mockGetLegacy.mockResolvedValue({
      rows: [
        { id: 'l1', amount: '40', tipAmount: '4', method: 'CARD', type: 'REGULAR', status: 'COMPLETED', createdAt: new Date() },
        { id: 'l2', amount: '10', tipAmount: '0', method: 'CASH', type: 'REGULAR', status: 'COMPLETED', createdAt: new Date() },
        { id: 'l3', amount: '-5', tipAmount: '0', method: 'CASH', type: 'REFUND', status: 'COMPLETED', createdAt: new Date() }, // fuera
        { id: 'l4', amount: '99', tipAmount: '0', method: 'CASH', type: 'REGULAR', status: 'PENDING', createdAt: new Date() }, // fuera
      ],
    })

    const out = await aggregatePaymentsByMethod(MINDFORM, filters)

    expect(mockGetLegacy).toHaveBeenCalledTimes(1)
    expect(out).toEqual([
      { method: 'CASH', amount: 110, tips: 5, count: 2 },
      { method: 'CARD', amount: 40, tips: 4, count: 1 },
    ])
  })
})

describe('aggregateTipsByProcessor', () => {
  it('agrupa por cajero SÓLO pagos con propina > 0 y resuelve nombres con una consulta acotada', async () => {
    mockGroupBy.mockResolvedValue([
      { processedById: 'fatima', _sum: { tipAmount: '75.5' }, _count: { _all: 2 } },
      { processedById: null, _sum: { tipAmount: 20 }, _count: { _all: 1 } },
    ])
    mockStaffFindMany.mockResolvedValue([{ id: 'fatima', firstName: 'Fatima', lastName: 'Flores' }])

    const out = await aggregateTipsByProcessor('v1', filters)

    const args = mockGroupBy.mock.calls[0][0]
    expect(args.by).toEqual(['processedById'])
    expect(args.where).toMatchObject({ venueId: 'v1', status: 'COMPLETED', type: { not: 'REFUND' }, tipAmount: { gt: 0 } })
    // la consulta de nombres sólo pide los ids vistos y lleva un tope REAL
    expect(mockStaffFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['fatima'] } }, take: MAX_CAJEROS_CON_NOMBRE }),
    )
    expect(out).toEqual([
      { processedById: 'fatima', processedByName: 'Fatima Flores', tips: 75.5, payments: 2 },
      { processedById: null, processedByName: null, tips: 20, payments: 1 },
    ])
    expect(mockGetLegacy).not.toHaveBeenCalled()
  })

  it('sin cajeros con propina no consulta nombres', async () => {
    mockGroupBy.mockResolvedValue([{ processedById: null, _sum: { tipAmount: 3 }, _count: { _all: 1 } }])
    await aggregateTipsByProcessor('v1', filters)
    expect(mockStaffFindMany).not.toHaveBeenCalled()
  })

  it('MindForm: los QR legacy con propina caen en el cubo sin cajero; los de propina 0 no cuentan', async () => {
    mockGroupBy.mockResolvedValue([{ processedById: 'ana', _sum: { tipAmount: 10 }, _count: { _all: 1 } }])
    mockStaffFindMany.mockResolvedValue([{ id: 'ana', firstName: 'Ana', lastName: 'G' }])
    mockGetLegacy.mockResolvedValue({
      rows: [
        { id: 'l1', amount: '40', tipAmount: '4', method: 'CARD', type: 'REGULAR', status: 'COMPLETED', createdAt: new Date() },
        { id: 'l2', amount: '10', tipAmount: '0', method: 'CASH', type: 'REGULAR', status: 'COMPLETED', createdAt: new Date() },
      ],
    })

    const out = await aggregateTipsByProcessor(MINDFORM, filters)

    expect(out).toEqual([
      { processedById: 'ana', processedByName: 'Ana G', tips: 10, payments: 1 },
      { processedById: null, processedByName: null, tips: 4, payments: 1 },
    ])
  })
})
