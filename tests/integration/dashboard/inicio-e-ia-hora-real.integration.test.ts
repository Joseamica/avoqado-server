/**
 * D2 (REAL PostgreSQL · hz:47b359b5:D2, tras D93 «B» como Square y D1): el inicio del DASHBOARD y las herramientas de IA cuentan
 * lo vendido sin internet a su hora real, igual que el Resumen de ventas.
 *
 * La venta de las 23:50 del 11 (CDMX) que el POS subió a las 00:10 del 12 guarda `createdAt` = 00:10 (la llegada) y
 * `clientCreatedAt` = 23:50, en la orden y en su cobro: sale el 11, a las 23; el 12 no. El 11-nov-2026 es miércoles.
 *
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern inicio-e-ia-hora-real
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))

import prisma from '@/utils/prismaClient'
import {
  getBasicMetricsData,
  getBasicMetricsDetailsPage,
  getChartData,
  getExtendedMetrics,
  getGeneralStatsData,
} from '@/services/dashboard/generalStats.dashboard.service'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import { registerSalesTools } from '@/mcp/tools/sales'
import { registerProductTools } from '@/mcp/tools/products'
import type { McpScope } from '@/mcp/scope'

const TZ = 'America/Mexico_City'
const DIA_11 = { fromDate: '2026-11-11T06:00:00.000Z', toDate: '2026-11-12T05:59:59.999Z' }
const DIA_12 = { fromDate: '2026-11-12T06:00:00.000Z', toDate: '2026-11-13T05:59:59.999Z' }
const PAN_DEL_APARATO = '2026-11-12T05:50:00.000Z' // 23:50 del 11 en CDMX
const MIERCOLES_ISO = 3 // `weekday` de las gráficas: 1 = lunes
const MIERCOLES_DOW = 3 // `performanceByWeekday`: 0 = domingo
const suffix = `inicio-horareal-${Date.now()}`

let orgId: string
let venueId: string
let staffId: string
let categoryId: string
let tableId: string
let otraVenueId: string
const pagos: Record<string, string> = {}
let seq = 0

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, Handler>()
const ia = async (name: string, args: Record<string, unknown>) =>
  JSON.parse((await handlers.get(name)!({ venueId, ...args }, {})).content[0].text)

async function venta(p: { producto: string; monto: number; propina?: number; llegada: Date; delAparato?: Date; enVenue?: string }) {
  seq += 1
  const enVenue = p.enVenue ?? venueId
  const product = await prisma.product.create({
    data: { venueId: enVenue, categoryId, sku: `IHR-${seq}-${suffix}`, name: p.producto, price: p.monto },
    select: { id: true },
  })
  const order = await prisma.order.create({
    data: {
      venueId: enVenue,
      orderNumber: `IHR-${seq}-${suffix}`,
      createdById: staffId,
      tableId: enVenue === venueId ? tableId : null,
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
      items: {
        create: [
          {
            productId: product.id,
            productName: p.producto,
            categoryName: 'Cafetería',
            quantity: 1,
            unitPrice: p.monto,
            taxAmount: 0,
            total: p.monto,
          },
        ],
      },
    },
    select: { id: true },
  })
  const pago = await prisma.payment.create({
    data: {
      venueId: enVenue,
      orderId: order.id,
      processedById: staffId,
      amount: p.monto,
      tipAmount: p.propina ?? 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: p.monto,
      createdAt: p.llegada,
      clientCreatedAt: p.delAparato ?? null,
    },
    select: { id: true },
  })
  pagos[p.producto] = pago.id
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `InicioHoraReal Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `ihr-${suffix}`, slug: `ihr-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  staffId = (
    await prisma.staff.create({ data: { email: `staff-${suffix}@example.test`, firstName: 'Ana', lastName: 'Caja' }, select: { id: true } })
  ).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' } })
  categoryId = (
    await prisma.menuCategory.create({
      data: { venueId, name: `Cafetería ${suffix}`, slug: `cafeteria-${suffix}` } as never,
      select: { id: true },
    })
  ).id
  tableId = (await prisma.table.create({ data: { venueId, number: '7', capacity: 4, qrCode: `qr-${suffix}` }, select: { id: true } })).id
  // La misma cajera también vende en otra sucursal el 11: no cuenta en ésta (Codex r1 #1).
  otraVenueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `ihr2-${suffix}`, slug: `ihr2-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  await prisma.staffVenue.create({ data: { venueId: otraVenueId, staffId, role: 'CASHIER' } })
  await venta({ producto: 'Torta', monto: 80, llegada: new Date('2026-11-11T20:00:00.000Z'), enVenue: otraVenueId })
  // Dos turnos el 11 en esta sucursal: no duplican sus ventas (Codex r2 #1).
  await prisma.shift.createMany({
    data: [
      { venueId, staffId, startTime: new Date('2026-11-11T14:00:00.000Z') },
      { venueId, staffId, startTime: new Date('2026-11-11T22:00:00.000Z') },
    ] as never,
  })
  // En línea, el 11 a las 18:00.
  await venta({ producto: 'Café', monto: 100, llegada: new Date('2026-11-12T00:00:00.000Z') })
  // Sin internet: 23:50 del 11, subida a las 00:10 del 12, con $5 de propina.
  await venta({
    producto: 'Pan',
    monto: 50,
    propina: 5,
    llegada: new Date('2026-11-12T06:10:00.000Z'),
    delAparato: new Date(PAN_DEL_APARATO),
  })
  // En línea, el 12 a las 10:00.
  await venta({ producto: 'Jugo', monto: 30, llegada: new Date('2026-11-12T16:00:00.000Z') })
  // Sin internet: 21:00 del 10, subida 20 h después (el 11 a las 17:00): es del 10, no del 11.
  await venta({ producto: 'Té', monto: 7, llegada: new Date('2026-11-11T23:00:00.000Z'), delAparato: new Date('2026-11-11T03:00:00.000Z') })

  const scope = {
    staffId,
    activeOrg: orgId,
    allowedVenueIds: [venueId],
    scopes: ['mcp:read'],
    perVenueAccess: new Map([[venueId, { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }]]),
  } as unknown as McpScope
  const reg = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as Handler) } as never
  registerSalesTools(reg, scope)
  registerProductTools(reg, scope)
})

afterAll(async () => {
  const venues = [venueId, otraVenueId].filter(Boolean)
  if (venues.length) {
    await prisma.payment.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.shift.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId: { in: venues } } } })
    await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.product.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.table.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.menuCategory.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.staffVenue.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  }
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

const sum = (xs: number[]) => xs.reduce((s, n) => s + n, 0)

describe('D2 · el inicio del DASHBOARD cuenta lo vendido sin internet a su hora real', () => {
  it('más vendidos, categorías, canales y ranking: el 11 trae el Pan; el 12 no; el Té del 10 no va el 11', async () => {
    const top11 = (await getChartData(venueId, 'best-selling-products', DIA_11)) as { products: Array<{ name: string }> }
    expect(top11.products.map(p => p.name).sort()).toEqual(['Café', 'Pan'])
    const top12 = (await getChartData(venueId, 'best-selling-products', DIA_12)) as { products: Array<{ name: string }> }
    expect(top12.products.map(p => p.name)).toEqual(['Jugo'])

    const cat = (await getChartData(venueId, 'category-mix', DIA_11)) as Array<{ revenue: number }>
    expect(sum(cat.map(c => c.revenue))).toBeCloseTo(150, 2)
    const canal = (await getChartData(venueId, 'channel-mix', DIA_11)) as Array<{ revenue: number }>
    expect(sum(canal.map(c => c.revenue))).toBeCloseTo(150, 2)
    const ranking = (await getChartData(venueId, 'staff-ranking', DIA_11)) as Array<{ revenue: number; orders: number }>
    expect(ranking[0].revenue).toBeCloseTo(150, 2)
    expect(ranking[0].orders).toBe(2)
  })

  it('el día, la hora y el día de la semana salen de la hora real (tendencias, frecuencia, mapa de calor, días)', async () => {
    const semana = { fromDate: '2026-11-09T06:00:00.000Z', toDate: '2026-11-16T05:59:59.999Z' }
    const tendencia = (await getChartData(venueId, 'revenue-trends', semana)) as { revenue: Array<{ date: string; revenue: number }> }
    expect(tendencia.revenue).toEqual([
      expect.objectContaining({ date: '2026-11-10', revenue: 7 }),
      expect.objectContaining({ date: '2026-11-11', revenue: 150 }),
      expect.objectContaining({ date: '2026-11-12', revenue: 30 }),
    ])
    const ticket = (await getChartData(venueId, 'aov-trends', semana)) as { aov: Array<{ date: string; orderCount: number }> }
    expect(ticket.aov.find(d => d.date === '2026-11-11')?.orderCount).toBe(2)

    const frecuencia = (await getChartData(venueId, 'order-frequency', DIA_11)) as { frequency: Array<{ hourNum: number; orders: number }> }
    expect(frecuencia.frequency.find(h => h.hourNum === 23)?.orders).toBe(1)
    expect(frecuencia.frequency.find(h => h.hourNum === 0)).toBeUndefined()

    const calor = (await getChartData(venueId, 'sales-heatmap', DIA_11)) as { heatmap: Array<{ day: number; hour: number; value: number }> }
    expect(calor.heatmap.find(c => c.day === MIERCOLES_ISO - 1 && c.hour === 23)?.value).toBeCloseTo(50, 2)
    expect(calor.heatmap.find(c => c.day === MIERCOLES_ISO && c.hour === 0)?.value).toBe(0)

    const dias = (await getChartData(venueId, 'sales-by-weekday', DIA_11)) as Array<{ day: string; sales: number }>
    expect(dias.find(d => d.day === 'Miércoles')?.sales).toBeCloseTo(150, 2)
    expect(dias.find(d => d.day === 'Jueves')?.sales).toBe(0)

    const semanal = (await getChartData(venueId, 'weekly-trends', DIA_11)) as Array<{ day: string; currentWeek: number }>
    expect(semanal.find(d => d.day === 'Miércoles')?.currentWeek).toBeCloseTo(150, 2)
    expect(semanal.find(d => d.day === 'Jueves')?.currentWeek).toBe(0)
    // El periodo anterior (pedir el 18 compara contra el 11) también va por la hora real.
    const dia18 = { fromDate: '2026-11-18T06:00:00.000Z', toDate: '2026-11-19T05:59:59.999Z' }
    const anterior = (await getChartData(venueId, 'weekly-trends', dia18)) as Array<{ day: string; previousWeek: number }>
    expect(anterior.find(d => d.day === 'Miércoles')?.previousWeek).toBeCloseTo(150, 2)
    expect(anterior.find(d => d.day === 'Jueves')?.previousWeek).toBe(0)

    const horas = (await getChartData(venueId, 'peak-hours', DIA_11)) as Array<{ hour: number; sales: number }>
    expect(horas.find(h => h.hour === 23)?.sales).toBeCloseTo(50, 2)
  })

  it('descuentos y cocina cuentan las órdenes del día real', async () => {
    const desc = (await getChartData(venueId, 'discount-analysis', DIA_11)) as { totalOrders: number }
    expect(desc.totalOrders).toBe(2)
    const cocina = (await getChartData(venueId, 'kitchen-performance', DIA_11)) as { kitchen: Array<{ orders: number }> }
    expect(sum(cocina.kitchen.map(k => k.orders))).toBe(2)
    // El 11 da 2 también con la llegada (el Té subido el 11 tapa al Pan): el 12 es el que distingue (llegada: Pan + Jugo).
    expect(((await getChartData(venueId, 'discount-analysis', DIA_12)) as { totalOrders: number }).totalOrders).toBe(1)
    const cocina12 = (await getChartData(venueId, 'kitchen-performance', DIA_12)) as { kitchen: Array<{ orders: number }> }
    expect(sum(cocina12.kitchen.map(k => k.orders))).toBe(1)
  })

  it('las métricas de mesas, rentabilidad y personal también', async () => {
    const mesas11 = (await getExtendedMetrics(venueId, 'table-performance', DIA_11)) as Array<{ orderCount: number; totalSales: number }>
    expect(mesas11[0].orderCount).toBe(2)
    expect(mesas11[0].totalSales).toBeCloseTo(150, 2)
    const mesas12 = (await getExtendedMetrics(venueId, 'table-performance', DIA_12)) as Array<{ orderCount: number }>
    expect(mesas12[0].orderCount).toBe(1)
    const rent = (await getExtendedMetrics(venueId, 'product-profitability', DIA_11)) as Array<{ name: string }>
    expect(rent.map(r => r.name).sort()).toEqual(['Café', 'Pan'])
    const personal = (await getExtendedMetrics(venueId, 'staff-performance', DIA_11)) as Array<{ totalSales: number; orderCount: number }>
    // 2 y no 3: la Torta que vendió en la otra sucursal no se suma aquí (Codex r1 #1). $150 y no $300 con sus dos turnos (r2 #1).
    expect(personal[0].orderCount).toBe(2)
    expect(personal[0].totalSales).toBeCloseTo(150, 2)
    expect(personal[0].totalTips).toBeCloseTo(5, 2)
    const asistente = await SharedQueryService.getStaffPerformance(venueId, {
      from: new Date(DIA_11.fromDate),
      to: new Date(DIA_11.toDate),
    })
    expect(asistente[0].totalRevenue).toBeCloseTo(150, 2)
    expect(asistente[0].shiftsWorked).toBe(2)
  })

  it('las tarjetas de arriba suman el Pan el 11, con su día de la semana, y cuadran con el Resumen', async () => {
    const m11 = await getBasicMetricsData(venueId, { ...DIA_11, responseMode: 'aggregated-v1' } as never)
    expect(m11.summary.totalAmount).toBeCloseTo(150, 2)
    expect(m11.summary.totalTransactions).toBe(2)
    expect(m11.summary.totalTips).toBeCloseTo(5, 2)
    expect(m11.performanceByWeekday[MIERCOLES_DOW]).toBeCloseTo(150, 2)
    const m12 = await getBasicMetricsData(venueId, { ...DIA_12, responseMode: 'aggregated-v1' } as never)
    expect(m12.summary.totalAmount).toBeCloseTo(30, 2)

    const resumen = await getSalesSummary(venueId, { startDate: DIA_11.fromDate, endDate: DIA_11.toDate, timezone: TZ })
    expect(m11.summary.totalAmount).toBeCloseTo(resumen.summary.grossSales ?? 0, 2)
  })

  it('la lista vieja, la descarga y `general-stats` traen el Pan el 11 con su hora real', async () => {
    const viejo = await getBasicMetricsData(venueId, DIA_11)
    const pan = viejo.payments.find(p => p.id === pagos.Pan)
    expect(pan?.createdAt).toBe(PAN_DEL_APARATO)
    expect(viejo.payments.map(p => p.id)).not.toContain(pagos.Jugo)

    const pagina = await getBasicMetricsDetailsPage(venueId, { ...DIA_11, kind: 'payments' } as never)
    const ids = pagina.items.map(i => i.id).sort()
    expect(ids).toEqual([pagos.Café, pagos.Pan].sort())
    expect(pagina.items.find(i => i.id === pagos.Pan)?.createdAt).toBe(PAN_DEL_APARATO)
    // De a una fila por página: ni se repite ni se pierde (el cursor sigue con la llegada).
    const p1 = await getBasicMetricsDetailsPage(venueId, { ...DIA_11, kind: 'payments', limit: 1 } as never)
    expect(p1.nextCursor).not.toBeNull()
    const p2 = await getBasicMetricsDetailsPage(venueId, { ...DIA_11, kind: 'payments', limit: 1, cursor: p1.nextCursor } as never)
    expect(p2.nextCursor).toBeNull()
    expect([...p1.items, ...p2.items].map(i => i.id).sort()).toEqual([pagos.Café, pagos.Pan].sort())

    const general = await getGeneralStatsData(venueId, DIA_11)
    expect(general.payments.map(p => p.id).sort()).toEqual([pagos.Café, pagos.Pan].sort())
    expect(general.payments.find(p => p.id === pagos.Pan)?.createdAt).toBe(PAN_DEL_APARATO)
    expect(general.products.map(p => p.name).sort()).toEqual(['Café', 'Pan'])
  })

  it('las gráficas de propinas y de métodos de pago reciben el Pan con su hora real (el navegador agrupa por esa hora)', async () => {
    const propinas = (await getChartData(venueId, 'tips-over-time', DIA_11)) as { payments: Array<{ createdAt: string }> }
    expect(propinas.payments.map(p => p.createdAt)).toContain(PAN_DEL_APARATO)
    expect(propinas.payments).toHaveLength(2)
    const metodos = (await getChartData(venueId, 'sales-by-payment-method', DIA_11)) as {
      payments: Array<{ amount: number; createdAt: string }>
    }
    expect(sum(metodos.payments.map(p => p.amount))).toBeCloseTo(150, 2)
    expect(metodos.payments.map(p => p.createdAt)).toContain(PAN_DEL_APARATO)
  })
})

describe('D2 · las herramientas de IA cuentan lo vendido sin internet a su hora real', () => {
  const D11 = { fromDate: '2026-11-11', toDate: '2026-11-11' }
  const D12 = { fromDate: '2026-11-12', toDate: '2026-11-12' }

  it('top_products, category_mix, channel_mix y staff_ranking', async () => {
    expect((await ia('top_products', D11)).topProducts.map((p: { name: string }) => p.name).sort()).toEqual(['Café', 'Pan'])
    expect((await ia('top_products', D12)).topProducts.map((p: { name: string }) => p.name)).toEqual(['Jugo'])
    expect(sum((await ia('category_mix', D11)).categories.map((c: { revenue: number }) => c.revenue))).toBeCloseTo(150, 2)
    expect(sum((await ia('channel_mix', D11)).channels.map((c: { revenue: number }) => c.revenue))).toBeCloseTo(150, 2)
    expect((await ia('staff_ranking', D11)).staff[0].revenue).toBeCloseTo(150, 2)
  })

  it('product_sales: el Pan se vendió el 11, no el 12', async () => {
    const r11 = await ia('product_sales', { name: 'Pan', ...D11 })
    expect(r11.unitsSold).toBe(1)
    expect(r11.revenue).toBeCloseTo(50, 2)
    expect((await ia('product_sales', { name: 'Pan', ...D12 })).unitsSold).toBe(0)
  })

  it('sales_by_payment_method, tips_over_time y staff_tips', async () => {
    const metodos = await ia('sales_by_payment_method', D11)
    expect(metodos.netSales.total).toBeCloseTo(150, 2)
    expect(metodos.grossCollected.total).toBeCloseTo(155, 2)
    expect((await ia('sales_by_payment_method', D12)).netSales.total).toBeCloseTo(30, 2)

    const propinas = await ia('tips_over_time', D11)
    expect(propinas.total).toBeCloseTo(5, 2)
    expect(propinas.byDay).toEqual([expect.objectContaining({ date: '2026-11-11', tips: 5 })])
    expect((await ia('tips_over_time', D12)).total).toBe(0)

    expect((await ia('staff_tips', D11)).total).toBeCloseTo(5, 2)
    expect((await ia('staff_tips', D12)).total).toBe(0)
  })
})
