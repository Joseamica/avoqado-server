/**
 * Sales-summary export service: summary flattening + detailed where-clause.
 * getSalesSummary is mocked so we test the flattener shape, not the aggregation.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { payment: { count: jest.fn(), findMany: jest.fn() }, venue: { findUnique: jest.fn() } },
}))
import prisma from '../../../../src/utils/prismaClient'
import * as svc from '../../../../src/services/dashboard/sales-summary.dashboard.service'
import { dondeHoraRealEntre } from '../../../../src/services/shared/horaRealDelAparato'

const paymentCount = (prisma as any).payment.count as jest.Mock
const paymentFindMany = (prisma as any).payment.findMany as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock

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

  // Codex D13 r2 #6: la etiqueta de pantalla («21 nov, 10:00 a.m.») no trae el año y se repetía entre 2025 y 2026.
  describe('«Por periodo»: etiqueta con año, en la hora del negocio', () => {
    const periodo = (period: string, periodLabel: string, totalCollected: number) => ({
      period,
      periodLabel,
      metrics: { ...report.summary, totalCollected, transactionCount: 1 },
    })
    const conPeriodos = (reportType: svc.ReportType, byPeriod: ReturnType<typeof periodo>[]) => ({ ...report, reportType, byPeriod })

    it('🔴 por horas: dos años distintos no se confunden', () => {
      const { rows } = svc.flattenSalesSummaryForExport(
        conPeriodos('hours', [
          periodo('2025-11-21T16:00:00.000Z', '21 nov, 10:00 a.m.', 100),
          periodo('2026-11-21T16:00:00.000Z', '21 nov, 10:00 a.m.', 200),
        ]),
        ['byPeriod'],
        'America/Mexico_City',
      )
      expect(rows.map(r => [r.label, r.amount])).toEqual([
        ['2025-11-21 10:00', 100],
        ['2026-11-21 10:00', 200],
      ])
    })

    it('por día, semana y mes, en la zona del negocio (las 20:00 del 21 no pasan al 22)', () => {
      const una = (t: svc.ReportType, iso: string) =>
        svc.flattenSalesSummaryForExport(conPeriodos(t, [periodo(iso, 'x', 1)]), ['byPeriod'], 'America/Mexico_City').rows[0].label
      expect(una('days', '2026-11-21T06:00:00.000Z')).toBe('2026-11-21')
      expect(una('weeks', '2026-11-16T06:00:00.000Z')).toBe('Semana del 2026-11-16')
      expect(una('months', '2026-11-01T06:00:00.000Z')).toBe('2026-11')
      expect(una('hourlySum', '09:00')).toBe('09:00')
      expect(una('dailySum', 'monday')).toBe('Lunes')
    })

    it('la hora que se repite al atrasar el reloj (Tijuana, 1-nov): la segunda vez sale con su desfase', () => {
      const { rows } = svc.flattenSalesSummaryForExport(
        conPeriodos('hours', [periodo('2026-11-01T08:00:00.000Z', 'a', 1), periodo('2026-11-01T09:00:00.000Z', 'b', 2)]),
        ['byPeriod'],
        'America/Tijuana',
      )
      expect(rows.map(r => r.label)).toEqual(['2026-11-01 01:00', '2026-11-01 01:00 (UTC-08:00)'])
    })

    it('sin zona (llamadas viejas) deja la etiqueta de siempre', () => {
      const { rows } = svc.flattenSalesSummaryForExport(conPeriodos('days', [periodo('2026-11-21T06:00:00.000Z', 'sáb, 21 nov', 1)]), [
        'byPeriod',
      ])
      expect(rows[0].label).toBe('sáb, 21 nov')
    })
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
    // from buildPaymentWhereFilter('CASH'): el método, y (carril C2, D12) sólo dinero — sin medios de sistema ni cortesías de $0
    const delMetodo = where.AND as unknown[]
    expect(delMetodo[0]).toEqual({ method: 'CASH' })
    expect(JSON.stringify(delMetodo[1])).toContain('tipAmount')
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
    // D13.3: la columna «Fecha» necesita la hora del aparato; la zona NO se lee por fila (Codex r6: un texto largo se repetía).
    expect(arg.select.clientCreatedAt).toBe(true)
    expect(arg.select.venue).toBeUndefined()
  })

  it('🔴 D13.3 · cada fila lleva la zona del negocio leída UNA vez, como la lee el DASHBOARD para armar el rango', async () => {
    paymentFindMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }])
    for (const [guardada, zona] of [
      ['America/Tijuana', 'America/Tijuana'],
      ['+05:30', '+05:30'], // Codex r7: la pantalla arma el día en +05:30; la «Fecha» también
      ['GMT-6', 'America/Mexico_City'],
      ['x'.repeat(1000), 'America/Mexico_City'],
      [null, 'America/Mexico_City'],
    ]) {
      venueFindUnique.mockReset().mockResolvedValue({ timezone: guardada })
      const filas = await svc.fetchSalesSummaryDetailRows('v1', { startDate: '2026-06-01', endDate: '2026-06-07' }, 10)
      expect(filas.map(f => f.zona)).toEqual([zona, zona])
      expect(venueFindUnique).toHaveBeenCalledTimes(1)
    }
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
