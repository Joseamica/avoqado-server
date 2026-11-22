/**
 * Sales-summary export service: summary flattening + detailed where-clause.
 * getSalesSummary is mocked so we test the flattener shape, not the aggregation.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { payment: { count: jest.fn(), findMany: jest.fn() } },
}))
import prisma from '../../../../src/utils/prismaClient'
import * as svc from '../../../../src/services/dashboard/sales-summary.dashboard.service'
import { dondeHoraRealEntre } from '../../../../src/services/shared/horaRealDelAparato'

const paymentCount = (prisma as any).payment.count as jest.Mock
const paymentFindMany = (prisma as any).payment.findMany as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe('flattenSalesSummaryForExport', () => {
  const report: svc.SalesSummaryResponse = {
    dateRange: { startDate: new Date('2026-06-01'), endDate: new Date('2026-06-07') },
    reportType: 'summary',
    summary: {
      grossSales: 1000,
      items: 50,
      serviceCosts: 0,
      discounts: 100,
      refunds: 25,
      netSales: 875,
      deferredSales: 0,
      taxes: 140,
      tips: 60,
      platformFees: 12,
      staffCommissions: 0,
      commissions: 12,
      totalCollected: 935,
      netProfit: 863,
      transactionCount: 42,
    },
    byPaymentMethod: [{ method: 'CARD', amount: 700, count: 30, percentage: 70 }],
    filtered: false,
  }

  it('emits totals rows and the payment-method section when requested', () => {
    const { rows } = svc.flattenSalesSummaryForExport(report, ['totals', 'paymentMethods'])
    expect(rows.some(r => r.label === 'Ventas brutas' && r.amount === 1000)).toBe(true)
    expect(rows.some(r => r.section === 'paymentMethods' && r.label === 'CARD')).toBe(true)
  })

  // D13.4: la pantalla enseña «Comisiones a empleados» y «Ganancia neta»; el archivo no las traía.
  it('🔴 D13.4 · los totales traen «Comisiones a empleados» (restando) y «Ganancia neta», como la pantalla', () => {
    const { rows } = svc.flattenSalesSummaryForExport(
      { ...report, summary: { ...report.summary, staffCommissions: 40.5, netProfit: 822.5 } },
      ['totals'],
    )
    const fila = (label: string) => rows.find(r => r.section === 'totals' && r.label === label)
    expect(fila('Comisiones a empleados')).toMatchObject({ amount: -40.5, count: null })
    expect(fila('Ganancia neta')).toMatchObject({ amount: 822.5, count: null })
    // En el orden de la pantalla: las comisiones antes del total cobrado y la ganancia al final de la cascada.
    const orden = rows.map(r => r.label)
    expect(orden.indexOf('Comisiones a empleados')).toBeLessThan(orden.indexOf('Total cobrado'))
    expect(orden.indexOf('Ganancia neta')).toBe(orden.indexOf('Total cobrado') + 1)
  })

  it('omits sections the user did not request', () => {
    const { rows } = svc.flattenSalesSummaryForExport(report, ['totals'])
    expect(rows.some(r => r.section === 'paymentMethods')).toBe(false)
  })

  // D15 (Codex r1 #3): el aviso se veía en pantalla y desaparecía al descargar el mismo reporte.
  it('🔴 un reporte marcado `legacyUnavailable` lleva el aviso como PRIMERA fila, y las cifras siguen saliendo', () => {
    const { rows } = svc.flattenSalesSummaryForExport({ ...report, legacyUnavailable: true }, ['totals'])
    expect(rows[0]).toEqual({
      section: 'aviso',
      label: 'No pudimos leer todos los cobros del sistema anterior de QR. Este total puede estar incompleto: vuelve a intentar.',
      count: null,
      amount: null,
      percentage: null,
    })
    expect(rows.some(r => r.label === 'Ventas brutas' && r.amount === 1000)).toBe(true)
  })

  it('un reporte sin la marca no lleva ninguna fila de aviso', () => {
    const { rows } = svc.flattenSalesSummaryForExport(report, ['totals', 'paymentMethods'])
    expect(rows.some(r => r.section === 'aviso')).toBe(false)
  })
})

describe('detailed rows where-clause + cap', () => {
  /** Lo que el detallado filtra, sin el envoltorio de la hora real (D13.3). */
  const filtrosDe = (where: { AND: [Record<string, unknown>, unknown] }) => where.AND[0]

  it('countSalesSummaryDetailRows scopes to venue+date+COMPLETED and honors payment filter', async () => {
    paymentCount.mockResolvedValue(5)
    const total = await svc.countSalesSummaryDetailRows('v1', {
      startDate: '2026-06-01',
      endDate: '2026-06-07',
      paymentMethod: 'CASH',
    })
    expect(total).toBe(5)
    const where = filtrosDe(paymentCount.mock.calls[0][0].where)
    expect(where.venueId).toBe('v1')
    expect(where.status).toBe('COMPLETED')
    expect(where.method).toBe('CASH') // from buildPaymentWhereFilter('CASH')
  })

  // D13.3: la pantalla cuenta cada cobro por su hora REAL (la del aparato si se cobró sin red); el detallado lo elegía por la hora de
  // llegada, así que una venta sin red de las 23:50 que subió a las 00:10 salía en el archivo del día siguiente.
  it('🔴 D13.3 · el detallado elige por la hora real, como la pantalla (mismo filtro que dondeHoraRealEntre)', () => {
    const f = { startDate: '2026-11-11T06:00:00.000Z', endDate: '2026-11-12T05:59:59.999Z', paymentMethod: 'CASH' as const }
    const where = svc.buildSalesSummaryDetailWhere('v1', f)
    expect(where).toEqual(
      dondeHoraRealEntre(
        { venueId: 'v1', status: 'COMPLETED', ...svc.buildPaymentWhereFilter('CASH', undefined) },
        new Date(f.startDate),
        new Date(f.endDate),
      ),
    )
    // Y el cobro ya no se elige por la llegada a secas.
    expect(filtrosDe(where as never).createdAt).toBeUndefined()
  })

  it('fetchSalesSummaryDetailRows passes take=limit and a stable orderBy', async () => {
    paymentFindMany.mockResolvedValue([])
    await svc.fetchSalesSummaryDetailRows('v1', { startDate: '2026-06-01', endDate: '2026-06-07' }, 1000)
    const arg = paymentFindMany.mock.calls[0][0]
    expect(arg.take).toBe(1000)
    expect(arg.orderBy).toEqual({ createdAt: 'desc' })
    expect(filtrosDe(arg.where).status).toBe('COMPLETED')
    // D13.3: la columna «Fecha» necesita la hora del aparato y la zona del negocio.
    expect(arg.select.clientCreatedAt).toBe(true)
    expect(arg.select.venue).toEqual({ select: { timezone: true } })
  })

  it('threads staff (processedById) + shift (shiftId) + merchant into the WHERE when provided', async () => {
    paymentFindMany.mockResolvedValue([])
    await svc.fetchSalesSummaryDetailRows(
      'v1',
      {
        startDate: '2026-06-01',
        endDate: '2026-06-07',
        staffIds: ['staff-1', 'staff-2'],
        shiftId: 'shift-9',
        merchantAccountId: 'ma-7',
      },
      1000,
    )
    const where = filtrosDe(paymentFindMany.mock.calls[0][0].where)
    expect(where.processedById).toEqual({ in: ['staff-1', 'staff-2'] })
    expect(where.shiftId).toBe('shift-9')
    expect(where.merchantAccountId).toBe('ma-7')
  })

  it('omits staff/shift/merchant from the WHERE when not provided', async () => {
    paymentFindMany.mockResolvedValue([])
    await svc.fetchSalesSummaryDetailRows('v1', { startDate: '2026-06-01', endDate: '2026-06-07' }, 1000)
    const where = filtrosDe(paymentFindMany.mock.calls[0][0].where)
    expect(where.processedById).toBeUndefined()
    expect(where.shiftId).toBeUndefined()
    expect(where.merchantAccountId).toBeUndefined()
  })
})

describe('página por keyset (exportes en segundo plano)', () => {
  const corte = new Date('2026-11-03T18:00:00.000Z')
  const keyset = { OR: [{ createdAt: { lt: corte } }] }

  it('fetchSalesSummaryDetailPage: where = [filtros, corte, keyset], orden estable y tope', async () => {
    paymentFindMany.mockResolvedValue([])
    await svc.fetchSalesSummaryDetailPage('v1', { startDate: '2026-10-01', endDate: '2026-10-31' }, corte, keyset as any, 500)
    const arg = paymentFindMany.mock.calls[0][0]
    expect(arg.where.AND[0]).toEqual(svc.buildSalesSummaryDetailWhere('v1', { startDate: '2026-10-01', endDate: '2026-10-31' }))
    expect(arg.where.AND[1]).toEqual({ createdAt: { lte: corte } })
    expect(arg.where.AND[2]).toBe(keyset)
    expect(arg.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(arg.take).toBe(500)
    expect(arg.select).toBe(svc.SALES_SUMMARY_DETAIL_SELECT)
  })
  it('countSalesSummaryDetailRowsHasta cuenta con el corte', async () => {
    paymentCount.mockResolvedValue(7)
    expect(await svc.countSalesSummaryDetailRowsHasta('v1', { startDate: '2026-10-01', endDate: '2026-10-31' }, corte)).toBe(7)
    expect(paymentCount.mock.calls[0][0].where.AND[1]).toEqual({ createdAt: { lte: corte } })
  })
})
