/**
 * D4c · Postgres real. En CDMX, una venta de las 23:50 del 11 llegó a las 00:10 del 12.
 * Las dos sucursales y las ventas con red hacen visibles los descuadres entre totales, días y tiendas.
 */
import prisma from '@/utils/prismaClient'
import {
  getEnhancedOrganizationOverview,
  getOrganizationOverview,
  getOrganizationVenues,
  getRevenueTrends,
  getTopItems,
  getVenueBenchmarks,
} from '@/services/organization/organization.service'
import { organizationDashboardService as dashboard } from '@/services/organization-dashboard/organizationDashboard.service'
import { commandCenterService as commandCenter } from '@/services/command-center/commandCenter.service'
import { promotersService } from '@/services/promoters/promoters.service'
import { crearNegocio, type NegocioDePrueba } from '../product-variants/fixtures'

const TZ = 'America/Mexico_City'
const DIA_11 = '2026-11-11'
const DIA_12 = '2026-11-12'
const RANGO_11 = { from: new Date('2026-11-11T06:00:00Z'), to: new Date('2026-11-12T05:59:59.999Z') }
const RANGO_12 = { from: new Date('2026-11-12T06:00:00Z'), to: new Date('2026-11-13T05:59:59.999Z') }
const AHORA = new Date('2026-11-12T18:00:00Z')
const NOCHE_11 = new Date('2026-11-12T05:55:00Z')
const CHECADA_A = '2026-11-12T06:00:00.000Z'

let n: NegocioDePrueba
let venueB: string
let staffB: string
let manager: string
let sequence = 0

async function sale(
  venueId: string,
  staffId: string,
  amount: number,
  quantity: number,
  arrival: string,
  deviceTime?: string,
  method: 'CASH' | 'CREDIT_CARD' = 'CASH',
) {
  const createdAt = new Date(arrival)
  const clientCreatedAt = deviceTime ? new Date(deviceTime) : null
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: `D4C-${++sequence}-${n.venueId}`,
      createdById: staffId,
      createdAt,
      clientCreatedAt,
      contratoDePrecio: 'IVA_INCLUIDO',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      subtotal: amount,
      taxAmount: 0,
      total: amount,
      items: {
        create: { productName: 'Café', categoryName: 'Bebidas', quantity, unitPrice: amount / quantity, taxAmount: 0, total: amount },
      },
      payments: {
        create: {
          venueId,
          processedById: staffId,
          amount,
          method,
          status: 'COMPLETED',
          type: 'REGULAR',
          feePercentage: 0,
          feeAmount: 0,
          netAmount: amount,
          createdAt,
          clientCreatedAt,
        },
      },
    },
    select: { id: true },
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

  n = await crearNegocio('d4c-hora-real')
  await prisma.venue.update({ where: { id: n.venueId }, data: { status: 'ACTIVE', timezone: TZ } })
  venueB = (
    await prisma.venue.create({
      data: { organizationId: n.organizationId, name: 'Sucursal B', slug: `d4c-b-${n.venueId}`, status: 'ACTIVE', timezone: TZ },
      select: { id: true },
    })
  ).id
  staffB = (
    await prisma.staff.create({
      data: { firstName: 'Caja', lastName: 'B', email: `d4c-caja-${n.venueId}@example.test` },
      select: { id: true },
    })
  ).id
  manager = (
    await prisma.staff.create({
      data: {
        firstName: 'Gerencia',
        lastName: 'D4c',
        email: `d4c-gerencia-${n.venueId}@example.test`,
        organizations: { create: { organizationId: n.organizationId } },
      },
      select: { id: true },
    })
  ).id
  await prisma.staffVenue.createMany({
    data: [
      { staffId: n.staffId, venueId: n.venueId, role: 'CASHIER' },
      { staffId: staffB, venueId: venueB, role: 'CASHIER' },
      { staffId: manager, venueId: n.venueId, role: 'MANAGER' },
      { staffId: manager, venueId: venueB, role: 'MANAGER' },
    ],
  })

  await sale(n.venueId, n.staffId, 60, 3, '2026-11-12T06:10:00Z', '2026-11-12T05:50:00Z')
  // Último milisegundo del 11: también debe entrar al convertir un fin exclusivo.
  await sale(venueB, staffB, 20, 2, '2026-11-12T05:59:59.999Z')
  await sale(venueB, staffB, 40, 1, '2026-11-12T16:00:00Z')
  // Una venta cruza medianoche UTC, aunque en CDMX sigue siendo el 10.
  await sale(n.venueId, n.staffId, 10, 1, '2026-11-11T00:10:00Z', '2026-11-10T23:50:00Z')
  // Límites de los indicadores de semana y mes al abrir el panel el 12.
  await sale(venueB, staffB, 30, 5, '2026-11-05T06:10:00Z', '2026-11-05T05:50:00Z')
  await sale(n.venueId, n.staffId, 100, 4, '2026-11-01T06:10:00Z', '2026-11-01T05:50:00Z')

  await prisma.timeEntry.create({ data: { staffId: n.staffId, venueId: n.venueId, clockInTime: new Date(CHECADA_A) } })
})

beforeEach(() => {
  jest.setSystemTime(AHORA)
})

afterAll(async () => {
  jest.useRealTimers()
  if (!n?.venueId) return
  try {
    await prisma.order.deleteMany({ where: { venue: { organizationId: n.organizationId } } })
    if (venueB) await prisma.venue.delete({ where: { id: venueB } })
    await prisma.staff.deleteMany({ where: { id: { in: [staffB, manager].filter(Boolean) } } })
    await n.limpiar()
  } finally {
    await prisma.$disconnect()
  }
})

describe('D4c · organización', () => {
  it('R09 · el resumen mueve juntas la cabecera y las dos sucursales', async () => {
    const day11 = await getOrganizationOverview(n.organizationId, RANGO_11)
    const day12 = await getOrganizationOverview(n.organizationId, RANGO_12)
    expect(day11).toMatchObject({ totalRevenue: 80, totalOrders: 2, totalPayments: 2 })
    expect(day12).toMatchObject({ totalRevenue: 40, totalOrders: 1, totalPayments: 1 })
    expect(day11.venues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: n.venueId, revenue: 60, orderCount: 1, paymentCount: 1 }),
        expect.objectContaining({ id: venueB, revenue: 20, orderCount: 1, paymentCount: 1 }),
      ]),
    )
    expect(day12.venues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: n.venueId, revenue: 0, orderCount: 0, paymentCount: 0 }),
        expect.objectContaining({ id: venueB, revenue: 40, orderCount: 1, paymentCount: 1 }),
      ]),
    )
  })

  it('R10 · el comparativo incluye la venta en el periodo anterior y en la tendencia de su sucursal', async () => {
    const day11 = await getEnhancedOrganizationOverview(n.organizationId, RANGO_11)
    const day12 = await getEnhancedOrganizationOverview(n.organizationId, RANGO_12)
    expect(day11).toMatchObject({ totalRevenue: 80, totalOrders: 2, totalPayments: 2, averageTicketSize: 40 })
    expect(day11.venues.find(v => v.id === n.venueId)).toMatchObject({ revenue: 60, orderCount: 1, paymentCount: 1 })
    expect(day12).toMatchObject({
      totalRevenue: 40,
      totalOrders: 1,
      totalPayments: 1,
      previousPeriod: { totalRevenue: 80, totalOrders: 2, totalPayments: 2, averageTicketSize: 40 },
      changes: { revenueChange: -50, ordersChange: -50, paymentsChange: -50 },
    })
    expect(day12.venues.find(v => v.id === n.venueId)).toMatchObject({ revenue: 0, orderCount: 0, paymentCount: 0 })
    expect(day12.topVenues.find(v => v.id === n.venueId)).toMatchObject({ trend: 'down' })
  })

  it('R11 · la serie conserva el día UTC y usa la hora real en ambos periodos', async () => {
    const day11 = await getRevenueTrends(n.organizationId, RANGO_11)
    const day12 = await getRevenueTrends(n.organizationId, RANGO_12)
    expect(day11.currentPeriod.dataPoints).toEqual([{ date: DIA_12, revenue: 80, orders: 2 }])
    expect(day11.previousPeriod.dataPoints).toEqual([{ date: '2026-11-10', revenue: 10, orders: 1 }])
    expect(day12.currentPeriod.dataPoints).toEqual([{ date: DIA_12, revenue: 40, orders: 1 }])
    expect(day12.previousPeriod).toMatchObject({
      dataPoints: [{ date: DIA_12, revenue: 80, orders: 2 }],
      totals: { revenue: 80, orders: 2 },
    })
    expect(day12.comparison).toEqual({ revenueChange: -50, ordersChange: -50 })
    const acrossUtcMidnight = await getRevenueTrends(n.organizationId, { from: new Date('2026-11-10T06:00:00Z'), to: RANGO_11.to })
    expect(acrossUtcMidnight.currentPeriod.dataPoints).toEqual([
      { date: '2026-11-10', revenue: 10, orders: 1 },
      { date: DIA_12, revenue: 80, orders: 2 },
    ])
  })

  it('R12 · el ranking y el importe de los renglones usan el mismo día de la cuenta', async () => {
    expect(await getTopItems(n.organizationId, RANGO_11)).toMatchObject([{ quantitySold: 5, totalRevenue: 80 }])
    expect(await getTopItems(n.organizationId, RANGO_12)).toMatchObject([{ quantitySold: 1, totalRevenue: 40 }])
  })

  it('R13 · los promedios y el ranking entre sucursales usan la hora real', async () => {
    const day11 = await getVenueBenchmarks(n.organizationId, RANGO_11)
    const day12 = await getVenueBenchmarks(n.organizationId, RANGO_12)
    expect(day11.averages).toMatchObject({ revenue: 40, orders: 1, payments: 1 })
    expect(day11.venues).toMatchObject([
      { id: n.venueId, metrics: { revenue: 60, orders: 1, payments: 1 } },
      { id: venueB, metrics: { revenue: 20, orders: 1, payments: 1 } },
    ])
    expect(day12.venues).toMatchObject([
      { id: venueB, metrics: { revenue: 40, orders: 1, payments: 1 } },
      { id: n.venueId, metrics: { revenue: 0, orders: 0, payments: 0 } },
    ])
  })

  it('R14 · las sucursales conservan su alta y calculan el crecimiento por hora real', async () => {
    const before = await getOrganizationVenues(n.organizationId, RANGO_11)
    const after = await getOrganizationVenues(n.organizationId, RANGO_12)
    const beforeA = before.find(v => v.id === n.venueId)
    expect(beforeA?.metrics).toMatchObject({ revenue: 60, orderCount: 1, paymentCount: 1, growth: 500 })
    expect(after.find(v => v.id === n.venueId)).toMatchObject({
      createdAt: beforeA?.createdAt,
      metrics: { revenue: 0, orderCount: 0, paymentCount: 0, growth: -100 },
    })
    expect(after.find(v => v.id === venueB)?.metrics).toMatchObject({ revenue: 40, orderCount: 1, paymentCount: 1, growth: 100 })
  })
})

describe('D4c · visión global, tiendas y vendedores', () => {
  it('R15 · Visión Global mueve el total, las unidades y las tiendas con ventas, y conserva el reloj del efectivo', async () => {
    const day11 = await dashboard.getVisionGlobalSummary(n.organizationId, TZ, DIA_11, DIA_11)
    expect(day11).toMatchObject({
      todaySales: 80,
      todayCashSales: 20,
      unitsSold: 5,
      avgTicket: 40,
      activeStores: 2,
      activePromoters: 0,
      categoryBreakdown: [{ name: 'Bebidas', sales: 80, units: 5 }],
    })
    const day12 = await dashboard.getVisionGlobalSummary(n.organizationId, TZ, DIA_12, DIA_12)
    expect(day12).toMatchObject({ todaySales: 40, todayCashSales: 100, unitsSold: 1, activeStores: 1, activePromoters: 1 })
    expect(await dashboard.getVisionGlobalSummary(n.organizationId, TZ)).toMatchObject({
      todaySales: 40,
      weekSales: 130,
      monthSales: 160,
    })
    const storeA = await dashboard.getVisionGlobalSummary(n.organizationId, TZ, DIA_11, DIA_11, n.venueId)
    expect(storeA).toMatchObject({ todaySales: 60, unitsSold: 3, activeStores: 1, totalStores: 2 })
  })

  it('R16 · desempeño mueve ventas y piezas juntos, también en metas y semana anterior', async () => {
    const get = (day?: string) => dashboard.getStorePerformance(n.organizationId, 10, TZ, day, day)
    const day11 = await get(DIA_11)
    const day12 = await get(DIA_12)
    expect(day11.find(v => v.id === n.venueId)).toMatchObject({ todaySales: 60, unitsSold: 3 })
    expect(day12.find(v => v.id === n.venueId)).toMatchObject({ todaySales: 0, unitsSold: 0, activePromoters: 1 })
    expect(day12.find(v => v.id === venueB)).toMatchObject({ todaySales: 40, unitsSold: 1, weekSales: 60, trend: 'up' })
    const today = await get()
    expect(today.find(v => v.id === n.venueId)).toMatchObject({ todaySales: 0, unitsSold: 0 })
    expect(today.find(v => v.id === venueB)).toMatchObject({ todaySales: 40, unitsSold: 1 })

    const goal = await prisma.organizationSalesGoalConfig.create({
      data: { organizationId: n.organizationId, goal: 100, period: 'MONTHLY', goalType: 'AMOUNT' },
    })
    try {
      expect((await get()).find(v => v.id === n.venueId)).toMatchObject({ performance: 70 })
      await prisma.organizationSalesGoalConfig.update({ where: { id: goal.id }, data: { goal: 10, goalType: 'QUANTITY' } })
      expect((await get()).find(v => v.id === n.venueId)).toMatchObject({ performance: 40 })
      await prisma.organizationSalesGoalConfig.update({ where: { id: goal.id }, data: { period: 'WEEKLY' } })
      expect((await get()).find(v => v.id === venueB)).toMatchObject({ performance: 30 })
    } finally {
      await prisma.organizationSalesGoalConfig.delete({ where: { id: goal.id } })
    }

    jest.setSystemTime(new Date('2026-11-19T18:00:00Z'))
    expect((await get()).find(v => v.id === n.venueId)).toMatchObject({ weekSales: 0, trend: 'down' })
  })

  it('R17 · el detalle del gerente conserva el desglose de hoy y de la semana', async () => {
    const day12 = await dashboard.getManagerDashboard(n.organizationId, manager, TZ)
    expect(day12?.aggregateMetrics.totalSales).toBe(40)
    expect(day12?.stores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: n.venueId, todaySales: 0, weekSales: 70, activePromoters: 1 }),
        expect.objectContaining({ id: venueB, todaySales: 40, weekSales: 60 }),
      ]),
    )
    jest.setSystemTime(NOCHE_11)
    const day11 = await dashboard.getManagerDashboard(n.organizationId, manager, TZ)
    expect(day11?.stores.find(v => v.id === n.venueId)).toMatchObject({ todaySales: 60 })
  })

  it('R18 · el resumen del gerente coincide con su detalle', async () => {
    const rows = await dashboard.getOrgManagers(n.organizationId, TZ)
    expect(rows).toMatchObject([{ id: manager, storeCount: 2, activeStores: 1, todaySales: 40 }])
  })

  it('R19 · la gráfica de ingresos conserva las metas y mueve el real de cada día', async () => {
    const org = await dashboard.getRevenueVsTarget(n.organizationId)
    const store = await dashboard.getRevenueVsTarget(n.organizationId, n.venueId)
    expect(org.days.slice(3, 5)).toMatchObject([
      { date: RANGO_11.from.toISOString(), actual: 80, target: 19285.71 },
      { date: RANGO_12.from.toISOString(), actual: 40, target: 19285.71 },
    ])
    expect(org.weekTotal.actual).toBe(130)
    expect(store.days.slice(3, 5)).toMatchObject([{ actual: 60 }, { actual: 0 }])
  })

  it('R20 · el volumen por día mueve las órdenes y conserva la meta', async () => {
    const org = await dashboard.getVolumeVsTarget(n.organizationId)
    const store = await dashboard.getVolumeVsTarget(n.organizationId, n.venueId)
    expect(org.days.slice(3, 5)).toMatchObject([
      { date: RANGO_11.from.toISOString(), actual: 2, target: 71 },
      { date: RANGO_12.from.toISOString(), actual: 1, target: 71 },
    ])
    expect(org.weekTotal.actual).toBe(4)
    expect(store.days.slice(3, 5)).toMatchObject([{ actual: 1 }, { actual: 0 }])
  })

  it('R21 · el mejor promotor de hoy no incluye la venta de ayer', async () => {
    expect(await dashboard.getTopPromoter(n.organizationId, TZ)).toMatchObject({ staffId: staffB, venueId: venueB, salesCount: 1 })
  })

  it('R21 · la primera venta real desempata y decide la sucursal del promotor', async () => {
    jest.setSystemTime(new Date('2026-11-13T18:00:00Z'))
    const sales: Array<{ id: string }> = []
    try {
      sales.push(await sale(n.venueId, n.staffId, 10, 1, '2026-11-13T17:00:00Z', '2026-11-13T08:00:00Z'))
      sales.push(await sale(venueB, n.staffId, 10, 1, '2026-11-13T16:00:00Z'))
      sales.push(await sale(venueB, staffB, 10, 1, '2026-11-13T12:00:00Z'))
      sales.push(await sale(venueB, staffB, 10, 1, '2026-11-13T13:00:00Z'))
      expect(await dashboard.getTopPromoter(n.organizationId, TZ)).toMatchObject({
        staffId: n.staffId,
        venueId: n.venueId,
        salesCount: 2,
      })
    } finally {
      await prisma.order.deleteMany({ where: { venue: { organizationId: n.organizationId }, id: { in: sales.map(s => s.id) } } })
    }
  })

  it('R22 · las ventas por vendedor se mueven y el efectivo por checada queda a su hora de llegada', async () => {
    const day11 = await dashboard.getStaffAttendance(n.organizationId, DIA_11)
    const day12 = await dashboard.getStaffAttendance(n.organizationId, DIA_12)
    expect(day11.staff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: n.staffId, venueId: n.venueId, sales: 60, cashSales: 0, checkInTime: null }),
        expect.objectContaining({ id: staffB, venueId: venueB, sales: 20, cashSales: 20 }),
      ]),
    )
    expect(day12.staff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: n.staffId,
          venueId: n.venueId,
          sales: 0,
          cashSales: 60,
          checkInTime: CHECADA_A,
          allTimeEntries: [expect.objectContaining({ cashSales: 60 })],
        }),
        expect.objectContaining({ id: staffB, venueId: venueB, sales: 40, cashSales: 40 }),
      ]),
    )
  })

  it('R23 · la tendencia del vendedor usa el día local y el límite semanal de la hora real', async () => {
    const a = await dashboard.getStaffSalesTrend(n.organizationId, n.staffId, TZ)
    const b = await dashboard.getStaffSalesTrend(n.organizationId, staffB, TZ)
    expect(a.salesData.slice(-3)).toEqual([
      { day: 'Mar', sales: 10 },
      { day: 'Mié', sales: 60 },
      { day: 'Jue', sales: 0 },
    ])
    expect(b.salesData.slice(-2)).toEqual([
      { day: 'Mié', sales: 20 },
      { day: 'Jue', sales: 40 },
    ])
  })

  it('R22 · quien no checó conserva su efectivo de hoy aunque la venta sea de ayer (Codex 4c r1 #1)', async () => {
    jest.setSystemTime(new Date('2026-11-14T18:00:00Z'))
    // 23:50 del 13 en CDMX, subida a las 00:10 del 14; la cajera B no checa ni el 13 ni el 14.
    const tardia = await sale(venueB, staffB, 15, 1, '2026-11-14T06:10:00Z', '2026-11-14T05:50:00Z')
    try {
      const day14 = await dashboard.getStaffAttendance(n.organizationId, '2026-11-14')
      expect(day14.staff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: staffB, venueId: venueB, sales: 0, salesAtArrival: 15, cashSales: 15, checkInTime: null }),
        ]),
      )
      const day13 = await dashboard.getStaffAttendance(n.organizationId, '2026-11-13')
      expect(day13.staff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: staffB, venueId: venueB, sales: 15, salesAtArrival: 0, cashSales: 0, checkInTime: null }),
        ]),
      )
    } finally {
      await prisma.order.deleteMany({ where: { id: tardia.id, venue: { organizationId: n.organizationId } } })
    }
  })

  it('R22 · la venta tardía con TARJETA de quien no checó también conserva su fila del día de llegada (Codex 4c r3 #2)', async () => {
    jest.setSystemTime(new Date('2026-11-16T18:00:00Z'))
    // 23:50 del 15 en CDMX con tarjeta, subida a las 00:10 del 16; el gerente no checa.
    const tarjeta = await sale(venueB, manager, 15, 1, '2026-11-16T06:10:00Z', '2026-11-16T05:50:00Z', 'CREDIT_CARD')
    try {
      const day16 = await dashboard.getStaffAttendance(n.organizationId, '2026-11-16')
      expect(day16.staff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: manager, venueId: venueB, sales: 0, salesAtArrival: 15, cashSales: 0, checkInTime: null }),
        ]),
      )
      const day15 = await dashboard.getStaffAttendance(n.organizationId, '2026-11-15')
      expect(day15.staff).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: manager, venueId: venueB, sales: 15, cashSales: 0 })]),
      )
    } finally {
      await prisma.order.deleteMany({ where: { id: tarjeta.id, venue: { organizationId: n.organizationId } } })
    }
  })

  it('R22 · con red, quien no checó ni vendió y sólo devolvió efectivo de otra venta no aparece, como antes (Codex 4c r2 #2)', async () => {
    jest.setSystemTime(new Date('2026-11-14T18:00:00Z'))
    const original = await prisma.payment.findFirstOrThrow({
      where: { venueId: venueB, processedById: staffB, amount: 40 },
      select: { id: true, orderId: true },
    })
    const devolucion = await prisma.payment.create({
      data: {
        venueId: venueB,
        orderId: original.orderId,
        processedById: manager,
        amount: -15,
        method: 'CASH',
        status: 'COMPLETED',
        type: 'REFUND',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: -15,
        processorData: { originalPaymentId: original.id },
        createdAt: new Date('2026-11-14T17:00:00Z'),
      },
      select: { id: true },
    })
    try {
      const day14 = await dashboard.getStaffAttendance(n.organizationId, '2026-11-14')
      expect(day14.staff.find(s => s.id === manager)).toBeUndefined()
      // La devolución es de quien vendió (D2): la cajera B sí sale, con −15.
      expect(day14.staff).toEqual(expect.arrayContaining([expect.objectContaining({ id: staffB, venueId: venueB, sales: -15 })]))
    } finally {
      await prisma.payment.deleteMany({ where: { id: devolucion.id, venueId: venueB } })
    }
  })

  it('R23/R25/R27 · una venta de hace 7 días subida hace 6 no cae en la barra de hoy y la semana cuadra con su gráfica (Codex 4c r1 #2 y #4)', async () => {
    // Jueves 5 a las 23:50 en CDMX, subida el viernes 6 a las 00:10. Hoy es el jueves 12: la semana es del viernes 6 al jueves 12.
    const vieja = await sale(venueB, staffB, 7, 1, '2026-11-06T06:10:00Z', '2026-11-06T05:50:00Z')
    // El primer día de la semana (viernes 6, mediodía, con red) SÍ entra: una semana de 6 días no pasaría (Codex 4c r2 #4).
    const primerDia = await sale(venueB, staffB, 3, 2, '2026-11-06T18:00:00Z')
    try {
      const b = await dashboard.getStaffSalesTrend(n.organizationId, staffB, TZ)
      expect(b.salesData).toEqual([
        { day: 'Vie', sales: 3 },
        { day: 'Sáb', sales: 0 },
        { day: 'Dom', sales: 0 },
        { day: 'Lun', sales: 0 },
        { day: 'Mar', sales: 0 },
        { day: 'Mié', sales: 20 },
        { day: 'Jue', sales: 40 },
      ])
      const summary = await commandCenter.getSummary(venueB)
      const chart = await commandCenter.getStockVsSales(venueB, { days: 7 })
      const chartSales = chart.trend.reduce((sum, d) => sum + d.sales, 0)
      const chartUnits = chart.trend.reduce((sum, d) => sum + d.units, 0)
      expect(chart.trend).toHaveLength(7)
      expect(summary).toMatchObject({ weekSales: 63, weekUnits: 5 })
      expect(summary.weekSales).toBe(chartSales)
      expect(summary.weekUnits).toBe(chartUnits)
    } finally {
      await prisma.order.deleteMany({ where: { id: { in: [vieja.id, primerDia.id] }, venue: { organizationId: n.organizationId } } })
    }
  })

  it('R24 · en Tijuana el cobro de las 23:50 del 12 sale el 12 (el fin del rango también es el de la sucursal, Codex 4c r3 #3)', async () => {
    const venueT = (
      await prisma.venue.create({
        data: {
          organizationId: n.organizationId,
          name: 'Sucursal Tijuana',
          slug: `d4c-t-${n.venueId}`,
          status: 'ACTIVE',
          timezone: 'America/Tijuana',
        },
        select: { id: true },
      })
    ).id
    try {
      await prisma.staffVenue.create({ data: { staffId: staffB, venueId: venueT, role: 'CASHIER' } })
      // 23:50 del 12 en Tijuana (UTC−8) = 07:50Z del 13, con red: en CDMX ya es la 01:50 del 13.
      await sale(venueT, staffB, 35, 1, '2026-11-13T07:50:00Z')
      const get = (from: string, to: string) => dashboard.getSalesHeatmap(n.organizationId, from, to, 'OWNER', n.staffId, venueT)
      expect((await get(DIA_12, DIA_12)).summary.byDay).toEqual([{ date: DIA_12, totalCount: 1, totalAmount: 35 }])
      expect((await get('2026-11-13', '2026-11-13')).summary.byDay).toEqual([{ date: '2026-11-13', totalCount: 0, totalAmount: 0 }])
    } finally {
      await prisma.order.deleteMany({ where: { venueId: venueT } })
      await prisma.staffVenue.deleteMany({ where: { venueId: venueT } })
      await prisma.venue.delete({ where: { id: venueT } })
    }
  })

  it('R24 · en una sucursal de Cancún el día del filtro es el mismo con el que se agrupa (Codex 4c r1 #3)', async () => {
    const venueC = (
      await prisma.venue.create({
        data: {
          organizationId: n.organizationId,
          name: 'Sucursal Cancún',
          slug: `d4c-c-${n.venueId}`,
          status: 'ACTIVE',
          timezone: 'America/Cancun',
        },
        select: { id: true },
      })
    ).id
    try {
      await prisma.staffVenue.create({ data: { staffId: staffB, venueId: venueC, role: 'CASHIER' } })
      // 00:10 del 12 en Cancún (23:10 del 11 en CDMX), subida a la 01:10 del 12 en Cancún.
      await sale(venueC, staffB, 25, 1, '2026-11-12T06:10:00Z', '2026-11-12T05:10:00Z')
      const get = (from: string, to: string) => dashboard.getSalesHeatmap(n.organizationId, from, to, 'OWNER', n.staffId, venueC)
      expect((await get(DIA_12, DIA_12)).summary.byDay).toEqual([{ date: DIA_12, totalCount: 1, totalAmount: 25 }])
      expect((await get(DIA_11, DIA_11)).summary.byDay).toEqual([{ date: DIA_11, totalCount: 0, totalAmount: 0 }])
      expect((await get(DIA_11, DIA_12)).summary.byDay).toEqual([
        { date: DIA_11, totalCount: 0, totalAmount: 0 },
        { date: DIA_12, totalCount: 1, totalAmount: 25 },
      ])
    } finally {
      await prisma.order.deleteMany({ where: { venueId: venueC } })
      await prisma.staffVenue.deleteMany({ where: { venueId: venueC } })
      await prisma.venue.delete({ where: { id: venueC } })
    }
  })

  it('R24 · la asistencia corta el día de cada sucursal con SU zona: Cancún a las 00:30 del 12 sale el 12 (Codex 4c r6 #1)', async () => {
    const venueC = (
      await prisma.venue.create({
        data: {
          organizationId: n.organizationId,
          name: 'Sucursal Cancún asistencia',
          slug: `d4c-ca-${n.venueId}`,
          status: 'ACTIVE',
          timezone: 'America/Cancun',
        },
        select: { id: true },
      })
    ).id
    const staffC = (
      await prisma.staff.create({
        data: { firstName: 'Caja', lastName: 'Cancún', email: `d4c-caja-c-${n.venueId}@example.test` },
        select: { id: true },
      })
    ).id
    try {
      await prisma.staffVenue.create({ data: { staffId: staffC, venueId: venueC, role: 'CASHIER' } })
      // Cancún es UTC−5 todo el año: 00:20 del 12 = 05:20Z (23:20 del 11 en CDMX). Checa y cobra en efectivo a las 00:30, con red.
      const checada = await prisma.timeEntry.create({
        data: { staffId: staffC, venueId: venueC, clockInTime: new Date('2026-11-12T05:20:00Z') },
        select: { id: true },
      })
      await sale(venueC, staffC, 25, 1, '2026-11-12T05:30:00Z')

      const fila = (r: Awaited<ReturnType<typeof dashboard.getStaffAttendance>>) =>
        r.staff.find(s => s.id === staffC && s.venueId === venueC)

      // «El día 12»: la checada, la venta y el efectivo (por persona y por checada) son del 12 de Cancún.
      expect(fila(await dashboard.getStaffAttendance(n.organizationId, DIA_12))).toMatchObject({
        sales: 25,
        salesAtArrival: 25,
        cashSales: 25,
        checkInTime: '2026-11-12T05:20:00.000Z',
        allTimeEntries: [expect.objectContaining({ id: checada.id, cashSales: 25 })],
      })
      // «El día 11» no lo trae: en Cancún ya era el 12.
      expect(fila(await dashboard.getStaffAttendance(n.organizationId, DIA_11))).toBeUndefined()
      // «Entre» 12 y 13, con el filtro de sucursal: igual.
      expect(fila(await dashboard.getStaffAttendance(n.organizationId, undefined, venueC, undefined, DIA_12, '2026-11-13'))).toMatchObject({
        sales: 25,
        cashSales: 25,
      })
      expect(fila(await dashboard.getStaffAttendance(n.organizationId, undefined, undefined, undefined, DIA_11, DIA_11))).toBeUndefined()

      // Sin fecha («hoy»): a las 00:40 del 12 en Cancún (23:40 del 11 en CDMX), hoy en Cancún ya es el 12.
      jest.setSystemTime(new Date('2026-11-12T05:40:00Z'))
      expect(fila(await dashboard.getStaffAttendance(n.organizationId))).toMatchObject({ sales: 25, cashSales: 25 })

      // Las sucursales de CDMX siguen con su día de siempre en la misma petición (R22).
      const day12 = await dashboard.getStaffAttendance(n.organizationId, DIA_12)
      expect(day12.staff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: n.staffId, venueId: n.venueId, sales: 0, cashSales: 60, checkInTime: CHECADA_A }),
          expect.objectContaining({ id: staffB, venueId: venueB, sales: 40, cashSales: 40 }),
        ]),
      )
    } finally {
      await prisma.order.deleteMany({ where: { venueId: venueC } })
      await prisma.timeEntry.deleteMany({ where: { venueId: venueC } })
      await prisma.staffVenue.deleteMany({ where: { venueId: venueC } })
      await prisma.venue.delete({ where: { id: venueC } })
      await prisma.staff.deleteMany({ where: { id: staffC } })
    }
  })

  it('R24 · asistencia: donde la medianoche no existe (Santiago, 6-sep) los días no se enciman, y una fecha vacía es «hoy» (Codex a1988b r1 #3 y #5)', async () => {
    const venueS = (
      await prisma.venue.create({
        data: {
          organizationId: n.organizationId,
          name: 'Sucursal Santiago asistencia',
          slug: `d4c-sa-${n.venueId}`,
          status: 'ACTIVE',
          timezone: 'America/Santiago',
        },
        select: { id: true },
      })
    ).id
    const staffS = (
      await prisma.staff.create({
        data: { firstName: 'Caja', lastName: 'Santiago', email: `d4c-caja-s-${n.venueId}@example.test` },
        select: { id: true },
      })
    ).id
    try {
      await prisma.staffVenue.create({ data: { staffId: staffS, venueId: venueS, role: 'CASHIER' } })
      // 23:30 del 5-sep en Santiago (UTC−4) = 03:30Z del 6. El 6 empieza a la 01:00 (UTC−3) = 04:00Z: el cobro es SÓLO del 5.
      await sale(venueS, staffS, 9, 1, '2026-09-06T03:30:00Z')
      const fila = (r: Awaited<ReturnType<typeof dashboard.getStaffAttendance>>) =>
        r.staff.find(s => s.id === staffS && s.venueId === venueS)
      expect(fila(await dashboard.getStaffAttendance(n.organizationId, '2026-09-05'))).toMatchObject({ sales: 9, cashSales: 9 })
      expect(fila(await dashboard.getStaffAttendance(n.organizationId, '2026-09-06'))).toBeUndefined()
      expect(
        fila(await dashboard.getStaffAttendance(n.organizationId, undefined, undefined, undefined, '2026-09-05', '2026-09-06')),
      ).toMatchObject({ sales: 9, cashSales: 9 })

      // Una fecha vacía (`?date=`) es «hoy», como antes, y no tumba la consulta.
      const vacia = await dashboard.getStaffAttendance(n.organizationId, '')
      const hoy = await dashboard.getStaffAttendance(n.organizationId)
      expect(vacia.staff.map(s => `${s.id}:${s.venueId}:${s.sales}`).sort()).toEqual(
        hoy.staff.map(s => `${s.id}:${s.venueId}:${s.sales}`).sort(),
      )
      expect(hoy.staff).toEqual(expect.arrayContaining([expect.objectContaining({ id: staffB, venueId: venueB, sales: 40 })]))
    } finally {
      await prisma.order.deleteMany({ where: { venueId: venueS } })
      await prisma.staffVenue.deleteMany({ where: { venueId: venueS } })
      await prisma.venue.delete({ where: { id: venueS } })
      await prisma.staff.deleteMany({ where: { id: staffS } })
    }
  })

  it('R24 · el mapa de calor usa el día real del cobro en el filtro y en el grupo por tienda', async () => {
    const get = (from: string, to: string) => dashboard.getSalesHeatmap(n.organizationId, from, to, 'OWNER', n.staffId)
    const both = await get(DIA_11, DIA_12)
    expect(both.summary.byDay).toEqual([
      { date: DIA_11, totalCount: 2, totalAmount: 80 },
      { date: DIA_12, totalCount: 1, totalAmount: 40 },
    ])
    expect(both.summary.byVenue.find(v => v.venueId === n.venueId)?.byDay).toEqual([
      { date: DIA_11, totalCount: 1, totalAmount: 60 },
      { date: DIA_12, totalCount: 0, totalAmount: 0 },
    ])
    expect((await get(DIA_11, DIA_11)).summary.byDay).toEqual([{ date: DIA_11, totalCount: 2, totalAmount: 80 }])
    expect((await get(DIA_12, DIA_12)).summary.byDay).toEqual([{ date: DIA_12, totalCount: 1, totalAmount: 40 }])
  })
})

describe('D4c · centro de mando y lista de promotores', () => {
  it('R25 · resumen por sucursal mueve ventas, unidades y ticket con el reloj de cada periodo', async () => {
    const a = await commandCenter.getSummary(n.venueId)
    const b = await commandCenter.getSummary(venueB)
    expect(a).toMatchObject({
      todaySales: 0,
      todayUnits: 0,
      avgTicket: 0,
      topSellers: [],
      categoryBreakdown: [],
      weekSales: 70,
      weekUnits: 4,
      monthSales: 70,
      monthUnits: 4,
      activePromoters: 1,
    })
    expect(b).toMatchObject({ todaySales: 40, todayUnits: 1, avgTicket: 40, weekSales: 60, weekUnits: 3, monthSales: 90, monthUnits: 8 })
    jest.setSystemTime(NOCHE_11)
    expect(await commandCenter.getSummary(n.venueId)).toMatchObject({ todaySales: 60, todayUnits: 3, avgTicket: 60 })
  })

  it('R26 · ranking de vendedores de hoy excluye la venta de ayer al reintentar', async () => {
    expect(await commandCenter.getTopSellers(n.venueId)).toEqual([])
    expect(await commandCenter.getTopSellers(venueB)).toMatchObject([{ id: staffB, sales: 40, units: 1, rank: 1 }])
    jest.setSystemTime(NOCHE_11)
    expect(await commandCenter.getTopSellers(n.venueId)).toMatchObject([{ id: n.staffId, sales: 60, units: 3, rank: 1 }])
  })

  it('R27 · la serie y la comparación usan la fecha local de cada orden', async () => {
    const both = await commandCenter.getStockVsSales(n.venueId, { startDate: DIA_11, endDate: DIA_12 })
    expect(both.trend).toMatchObject([
      { sales: 60, units: 3, transactions: 1 },
      { sales: 0, units: 0, transactions: 0 },
    ])
    const get12 = (venueId: string) => commandCenter.getStockVsSales(venueId, { startDate: DIA_12, endDate: DIA_12 })
    expect(await get12(n.venueId)).toMatchObject({
      trend: [{ sales: 0, units: 0, transactions: 0 }],
      comparison: { salesChange: -100, unitsChange: -100, transactionsChange: -100 },
    })
    expect(await get12(venueB)).toMatchObject({
      trend: [{ sales: 40, units: 1, transactions: 1 }],
      comparison: { salesChange: 100, unitsChange: -50, transactionsChange: 0 },
    })
  })

  it('R28 · el listado de promotores mueve sus ventas y conserva la checada de hoy', async () => {
    const a = await promotersService.getPromotersList(n.venueId)
    const b = await promotersService.getPromotersList(venueB)
    expect(a.promoters).toMatchObject([{ id: n.staffId, todaySales: 0, todayUnits: 0, status: 'ACTIVE' }])
    expect(a.summary).toMatchObject({ active: 1, todayTotalSales: 0 })
    expect(b.promoters).toMatchObject([{ id: staffB, todaySales: 40, todayUnits: 1, status: 'INACTIVE' }])
    expect(b.summary.todayTotalSales).toBe(40)
    // D13 (Codex 4c r1 #5): la ficha dice lo mismo que su fila, también su comisión estimada.
    expect((await promotersService.getPromoterDetail(n.venueId, n.staffId))?.todayMetrics).toMatchObject({
      sales: 0,
      units: 0,
      commission: 0,
    })
    // Lo vendido hoy con red sigue en la ficha (Codex 4c r2 #4).
    expect((await promotersService.getPromoterDetail(venueB, staffB))?.todayMetrics).toMatchObject({ sales: 40, units: 1, commission: 1.2 })
    jest.setSystemTime(NOCHE_11)
    expect((await promotersService.getPromotersList(n.venueId)).promoters).toMatchObject([{ id: n.staffId, todaySales: 60, todayUnits: 1 }])
    expect((await promotersService.getPromoterDetail(n.venueId, n.staffId))?.todayMetrics).toMatchObject({
      sales: 60,
      units: 1,
      commission: 1.8,
    })
  })
})
