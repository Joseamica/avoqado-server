/**
 * D4 fase 4b (REAL PostgreSQL · hz:47b359b5:D4, tras D93, D1, D2 y 4a): el asistente del DASHBOARD (el nuevo, `SharedQueryService`, y el
 * anterior, `POST /assistant/query`) cuenta lo vendido sin internet a su hora real, igual que el Resumen.
 *
 * El reloj (sólo `Date`) se fija a las 16:00 del 12 en CDMX: «hoy» es el 12 y «ayer» el 11. La Playera vendida sin internet a las 23:50
 * del 11 y subida a las 00:10 del 12 guarda `createdAt` = la llegada y `clientCreatedAt` = 23:50, en la orden y en su cobro: sale el 11
 * (y a las 23:00 en la gráfica por hora) en cada lector, y no el 12. «Té viejo», vendido sin internet 10 min ANTES de hace 30 días y
 * subido 10 min DESPUÉS, ya no entra en los «últimos 30 días» del asistente anterior.
 *
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern d4b-asistente
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

import prisma from '@/utils/prismaClient'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import asistenteAnterior from '@/services/dashboard/assistant.dashboard.service'
import { crearNegocio, NegocioDePrueba } from '../product-variants/fixtures'

const AHORA = new Date('2026-11-12T22:00:00.000Z') // 16:00 del 12 en CDMX
const DIA_11 = { from: new Date('2026-11-11T06:00:00.000Z'), to: new Date('2026-11-12T05:59:59.999Z') }
const DIA_12 = { from: new Date('2026-11-12T06:00:00.000Z'), to: new Date('2026-11-13T05:59:59.999Z') }
const MIN = 60 * 1000
const HACE_30_DIAS = AHORA.getTime() - 30 * 24 * 60 * MIN

let n: NegocioDePrueba
let seq = 0
const anterior = asistenteAnterior as unknown as Record<string, (venueId: string, ...a: unknown[]) => Promise<any>>

async function venta(p: { nombre: string; monto: number; llegada: Date; delAparato?: Date }) {
  seq += 1
  const product = await prisma.product.create({
    data: { venueId: n.venueId, categoryId: n.categoryId, sku: `D4B-${seq}-${n.venueId}`, name: p.nombre, price: p.monto },
    select: { id: true },
  })
  const order = await prisma.order.create({
    data: {
      venueId: n.venueId,
      orderNumber: `D4B-${seq}-${n.venueId}`,
      createdById: n.staffId,
      createdAt: p.llegada,
      clientCreatedAt: p.delAparato ?? null,
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: p.monto,
      taxAmount: 0,
      discountAmount: 0,
      tipAmount: 0,
      total: p.monto,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: { create: [{ productId: product.id, productName: p.nombre, quantity: 1, unitPrice: p.monto, taxAmount: 0, total: p.monto }] },
    },
    select: { id: true },
  })
  await prisma.payment.create({
    data: {
      venueId: n.venueId,
      orderId: order.id,
      processedById: n.staffId,
      amount: p.monto,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: p.monto,
      createdAt: p.llegada,
      clientCreatedAt: p.delAparato ?? null,
    },
  })
}

beforeAll(async () => {
  jest.useFakeTimers({
    now: AHORA,
    advanceTimers: true,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  })
  n = await crearNegocio('d4b-asistente')
  await prisma.venue.update({ where: { id: n.venueId }, data: { timezone: 'America/Mexico_City' } })
  // El negocio de prueba no liga a su persona; el ranking del personal la necesita activa en la sucursal.
  await prisma.staffVenue.create({ data: { staffId: n.staffId, venueId: n.venueId, role: 'WAITER', active: true } })

  await venta({ nombre: 'Café', monto: 100, llegada: new Date('2026-11-12T00:00:00.000Z') }) // 18:00 del 11, con red
  await venta({
    nombre: 'Playera',
    monto: 50,
    llegada: new Date('2026-11-12T06:10:00.000Z'), // 00:10 del 12
    delAparato: new Date('2026-11-12T05:50:00.000Z'), // 23:50 del 11
  })
  await venta({ nombre: 'Jugo', monto: 30, llegada: new Date('2026-11-12T16:00:00.000Z') }) // 10:00 del 12, con red
  await venta({
    nombre: 'Té viejo',
    monto: 7,
    llegada: new Date(HACE_30_DIAS + 10 * MIN),
    delAparato: new Date(HACE_30_DIAS - 10 * MIN),
  })
})

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { venueId: n?.venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId: n?.venueId } } })
  await prisma.order.deleteMany({ where: { venueId: n?.venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId: n?.venueId } })
  await n?.limpiar()
  await prisma.$disconnect()
  jest.useRealTimers()
})

describe('D4b · asistente nuevo (SharedQueryService)', () => {
  it('¿cuánto vendí?: el 11 suma $150 en 2 órdenes (ticket $75); el 12, $30 en 1', async () => {
    const r11 = await SharedQueryService.getSalesForPeriod(n.venueId, DIA_11)
    expect([r11.totalRevenue, r11.orderCount, r11.averageTicket]).toEqual([150, 2, 75]) // con la llegada: 100, 1
    const r12 = await SharedQueryService.getSalesForPeriod(n.venueId, DIA_12)
    expect([r12.totalRevenue, r12.orderCount]).toEqual([30, 1]) // con la llegada: 80, 2
  })

  it('la gráfica cuadra con el importe: por día 11 → $150 y 12 → $30; «ayer» por hora pone la Playera a las 23:00', async () => {
    const dias = await SharedQueryService.getSalesTimeSeries(n.venueId, { from: DIA_11.from, to: DIA_12.to })
    expect(dias.dataPoints.map(p => [p.date, p.revenue])).toEqual([
      ['2026-11-11', 150],
      ['2026-11-12', 30],
    ])
    const ayer = await SharedQueryService.getSalesTimeSeries(n.venueId, 'yesterday')
    expect(ayer.granularity).toBe('hour')
    expect(ayer.dataPoints.find(p => p.date === '23:00')?.revenue).toBe(50)
  })

  it('más vendidos y «¿cuánto vendí de Playera?»: el 11 sí, el 12 no', async () => {
    const nombres = async (d: typeof DIA_11) => (await SharedQueryService.getTopProducts(n.venueId, d, 10)).map(p => p.productName)
    expect(await nombres(DIA_11)).toContain('Playera')
    expect(await nombres(DIA_12)).not.toContain('Playera')
    expect((await SharedQueryService.getProductSalesByName(n.venueId, 'Playera', DIA_11)).quantitySold).toBe(1)
    expect((await SharedQueryService.getProductSalesByName(n.venueId, 'Playera', DIA_12)).quantitySold).toBe(0)
  })

  it('comparación «de noche» del 11: la Playera de las 23:50 cuenta (con la llegada era de las 00:10 del 12 y no contaba)', async () => {
    const r = await SharedQueryService.compareProductSales(n.venueId, {
      leftTerm: 'Playera',
      rightTerm: 'Jugo',
      period: DIA_11,
      nightOnly: true,
    })
    expect(r.left.revenue).toBe(50)
    expect(r.right.revenue).toBe(0)
  })

  it('rentabilidad y métodos de pago del 11: ingresos $150, con la Playera', async () => {
    const rent = await SharedQueryService.getProfitAnalysis(n.venueId, DIA_11, 10)
    expect(rent.totalRevenue).toBe(150)
    expect(rent.topProfitableProducts.map(p => p.productName)).toContain('Playera')
    const metodos = await SharedQueryService.getPaymentMethodBreakdown(n.venueId, DIA_11)
    expect(metodos.total).toBe(150)
  })
})

describe('D4b · asistente anterior (POST /assistant/query)', () => {
  it('ventas: hoy (12) $30 y ayer (11) $150 — con la llegada eran $80 y $100', async () => {
    const r = await anterior.getSalesData.call(asistenteAnterior, n.venueId)
    expect([r.hoy, r.ayer]).toEqual([30, 150])
  })

  it('resumen general: las ventas de hoy son sólo el Jugo', async () => {
    const r = await anterior.getGeneralSummary.call(asistenteAnterior, n.venueId)
    expect([r.ventasHoy, r.ordenesHoy]).toEqual([30, 1])
  })

  it('personal y productos de los últimos 30 días: el «Té viejo» (de hace 30 días y 10 min) ya no entra', async () => {
    const staff = await anterior.getStaffData.call(asistenteAnterior, n.venueId)
    const suma = (k: 'ventas' | 'ordenes') => staff.ranking.reduce((t: number, r: Record<string, number>) => t + r[k], 0)
    expect([suma('ventas'), suma('ordenes')]).toEqual([180, 3]) // con la llegada, 187 y 4
    const productos = await anterior.getProductsData.call(asistenteAnterior, n.venueId)
    expect(productos.masVendidos.map((p: { nombre: string }) => p.nombre)).not.toContain('Té viejo')
    expect(productos.masVendidos.map((p: { nombre: string }) => p.nombre)).toContain('Playera')
  })
})
