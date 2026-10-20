/**
 * Tarjetas 1b · S0.1 (Bloque 0, «la tubería») + L1 (Q20): la cuenta de tarjetas es una orden, pero no una venta de mercancía. Con la 1b
 * las cajas venden tarjetas, y sin el filtro entraban en «Ventas por artículo» (panel y `GET /mobile/…/reports/sales-by-item`), en la
 * tendencia semanal de Inicio y en el desempeño del personal (`SharedQueryService.getStaffPerformance`).
 *
 * El mismo cajero vende una tarjeta de $500 (cobrada en efectivo) y abre una cuenta de mercancía de $100 que sigue sin pagar.
 *
 * S0.1b (segundo bloque, negocio propio): mezcla de productos, varianza de costo y tasa de descuento. Esos reportes sólo leen
 * órdenes COMPLETED, así que ahí la cuenta de mercancía de $100 está terminada y su renglón apunta a un producto real.
 *
 * Correr: source ~/.claude/worktrees/tarjetas-1b/urls-tarjetas-1b.sh && TZ=UTC npx jest --selectProjects=integration --runInBand \
 *   --runTestsByPath tests/integration/giftCards/ventasPorArticulo.integration.test.ts
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { getChartData } from '@/services/dashboard/generalStats.dashboard.service'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import { getCostVarianceReport, getPMIXReport } from '@/services/dashboard/report.service'
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

describe('Mezcla de productos, varianza de costo y tasa de descuento sin la cuenta de tarjetas (S0.1b)', () => {
  let venueId: string
  let productId: string | undefined
  let categoryId: string | undefined
  let desde: Date
  let hasta: Date

  beforeAll(async () => {
    const negocio = await crearNegocioDePrueba('mpx')
    venueId = negocio.venueId
    desde = new Date(Date.now() - 60 * 60_000)
    hasta = new Date(Date.now() + 60 * 60_000)
    const suf = `${Date.now()}-${process.pid}`
    categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Ropa', slug: `ropa-${suf}` } })).id
    productId = (
      await prisma.product.create({ data: { venueId, sku: `PLAY-${suf}`, name: 'Playera', categoryId, price: new Prisma.Decimal(100) } })
    ).id
    await sembrarVentaDeTarjetas({ ...negocio, montos: [500], metodo: 'CASH' })
    const { orderId } = await crearCuentaDeMercancia({ venueId, staffId: negocio.staffId, total: 100 })
    await prisma.orderItem.updateMany({ where: { orderId }, data: { productId } })
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        paymentStatus: 'PAID',
        paidAmount: new Prisma.Decimal(100),
        remainingBalance: new Prisma.Decimal(0),
      },
    })
  })

  afterAll(async () => {
    if (!venueId) return
    await limpiarNegocioDePrueba(venueId)
    if (productId) await prisma.product.delete({ where: { id: productId } })
    if (categoryId) await prisma.menuCategory.delete({ where: { id: categoryId } })
  })

  it('mezcla de productos: el total y el porcentaje del producto no cuentan la tarjeta', async () => {
    const r = await getPMIXReport(venueId, desde, hasta)
    expect(r.summary.totalRevenue).toBe(100)
    expect(r.summary.totalQuantitySold).toBe(1)
    expect(r.products.find(p => p.productId === productId)?.revenuePercentage).toBe(100)
  })

  it('varianza de costo: el ingreso real no trae la cuenta de tarjetas', async () => {
    const r = await getCostVarianceReport(venueId, desde, hasta)
    expect(r.revenue).toBe(100)
  })

  it('reporte de descuentos: la cuenta de tarjetas no entra al denominador de la tasa', async () => {
    const r = (await getChartData(venueId, 'discount-analysis', { fromDate: desde.toISOString(), toDate: hasta.toISOString() })) as {
      totalOrders: number
    }
    expect(r.totalOrders).toBe(1)
  })
})
