/**
 * Tarjetas 1b · S0.1 (Bloque 0, «la tubería») + L1 (Q20): la cuenta de tarjetas es una orden, pero no una venta de mercancía. Con la 1b
 * las cajas venden tarjetas, y sin el filtro entraban en «Ventas por artículo» (panel y `GET /mobile/…/reports/sales-by-item`), en la
 * tendencia semanal de Inicio y en el desempeño del personal (`SharedQueryService.getStaffPerformance`).
 *
 * El mismo cajero vende una tarjeta de $500 (cobrada en efectivo) y abre una cuenta de mercancía de $100 que sigue sin pagar.
 *
 * Correr: source ~/.claude/worktrees/tarjetas-1b/urls-tarjetas-1b.sh && TZ=UTC npx jest --selectProjects=integration --runInBand \
 *   --runTestsByPath tests/integration/giftCards/ventasPorArticulo.integration.test.ts
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import prisma from '@/utils/prismaClient'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { getChartData } from '@/services/dashboard/generalStats.dashboard.service'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import { crearCuentaDeMercancia, crearNegocioDePrueba, limpiarNegocioDePrueba, sembrarVentaDeTarjetas } from './sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

describe('Reportes sin la cuenta de tarjetas (Bloque 0.1 + L1)', () => {
  let venueId: string
  let desde: Date
  let hasta: Date

  beforeAll(async () => {
    const negocio = await crearNegocioDePrueba('vpa')
    venueId = negocio.venueId
    desde = new Date(Date.now() - 60 * 60_000)
    hasta = new Date(Date.now() + 60 * 60_000)
    await sembrarVentaDeTarjetas({ ...negocio, montos: [500], metodo: 'CASH' })
    const { orderId } = await crearCuentaDeMercancia({ venueId, staffId: negocio.staffId, total: 100 })
    // Abierta y sin pagar, pero ya no borrador: la tendencia semanal deja fuera las PENDING (`ORDER_NOT_DISCARDED`).
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED' } })
  })

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  const porArticulo = (reportType: 'summary' | 'days') =>
    getSalesByItem(venueId, {
      startDate: desde.toISOString(),
      endDate: hasta.toISOString(),
      reportType,
      groupBy: 'none',
      timezone: 'America/Mexico_City',
    })

  it('ventas por artículo: el resumen no trae «Tarjeta de regalo» ni su dinero', async () => {
    const r = await porArticulo('summary')
    expect(r.items.map(i => i.productName)).not.toContain('Tarjeta de regalo')
    expect(r.totals.grossSales).toBe(100)
    expect(r.totals.itemsSold).toBe(1)
  })

  it('ventas por artículo por periodo («days») tampoco la suma', async () => {
    const r = await porArticulo('days')
    expect(r.byPeriod!.reduce((s, p) => s + p.grossSales, 0)).toBe(100)
  })

  it('weekly-trends no suma la cuenta de tarjetas', async () => {
    const semana = (await getChartData(venueId, 'weekly-trends', { fromDate: desde.toISOString(), toDate: hasta.toISOString() })) as Array<{
      currentWeek: number
    }>
    expect(semana.reduce((s, d) => s + d.currentWeek, 0)).toBe(100)
  })

  it('getStaffPerformance no cuenta la venta de tarjetas como orden ni dinero del empleado', async () => {
    const [yo] = await SharedQueryService.getStaffPerformance(venueId, { from: desde, to: hasta }, 5)
    expect(yo.totalOrders).toBe(1)
    expect(yo.totalRevenue).toBe(0) // la cuenta de mercancía está sin pagar: el dinero de la tarjeta ya no suma
  })
})
