/**
 * Integration tests: generalStats aggregations in SQL (REAL PostgreSQL).
 *
 * 2026-09-01: las agregaciones de generalStats materializaban TODAS las filas del
 * rango en Node (incidente del event loop en producción) y se reescribieron a
 * GROUP BY en Postgres. La lógica que antes cubrían tests unitarios con un
 * `order.findMany` mockeado vive ahora en SQL crudo — y un `$queryRaw` mockeado
 * devuelve lo que le digas, así que aquí se prueba contra base real.
 *
 * Qué fija este archivo, además de los números:
 *  · El BUCKETING EN LA ZONA DEL VENUE: una orden de las 04:30Z es "ayer 22:30"
 *    en México. La sesión de Postgres corre en America/Mexico_City y las columnas
 *    guardan UTC real — el par de trampas exactas que corren un reporte 6 horas.
 *  · Los cuatro números canónicos de lineRevenue (77.29 / 90 / 449 / 104.40),
 *    que antes vivían en tests unitarios de `product-profitability` con findMany
 *    mockeado (tests/unit/services/dashboard/lineRevenue.test.ts).
 *  · Que CANCELLED/PENDING/DELETED siguen fuera de todas las agregaciones de
 *    órdenes — salvo kitchen-performance, que NUNCA filtró por status y conserva
 *    ese comportamiento a propósito (cambiarlo movería un número publicado).
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern generalStats-sql-aggregation
 */

import { getChartData, getExtendedMetrics, getGeneralStatsData } from '@/services/dashboard/generalStats.dashboard.service'
import prisma from '@/utils/prismaClient'

// Anclas horarias (venue en America/Mexico_City, UTC-6 en marzo):
//  DAY       = martes 11-mar 12:00 local
//  NOCTURNA  = miércoles 12-mar 04:30 UTC = martes 11-mar 22:30 local ← la trampa
//  LUNES     = lunes 10-mar 12:00 local
const DAY = new Date('2025-03-11T18:00:00.000Z')
const NOCTURNA = new Date('2025-03-12T04:30:00.000Z')
const LUNES = new Date('2025-03-10T18:00:00.000Z')
const FROM_ISO = '2025-03-09T00:00:00.000Z'
const TO_ISO = '2025-03-12T23:59:59.999Z'
const FILTERS = { fromDate: FROM_ISO, toDate: TO_ISO }

const suffix = `gs-sql-${Date.now()}`
const round2 = (n: number): number => Math.round(n * 100) / 100

let orgId: string
let venueId: string

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `GeneralStats SQL Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id

  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `gs-${suffix}`, slug: `gs-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  venueId = venue.id

  const category = await prisma.menuCategory.create({
    data: { venueId, name: `Cat ${suffix}`, slug: `cat-${suffix}` },
    select: { id: true },
  })
  const mk = (sku: string, name: string, price: number, type: 'FOOD' | 'BEVERAGE') =>
    prisma.product.create({
      data: { venueId, sku: `${sku}-${suffix}`, name: `${name} ${suffix}`, categoryId: category.id, price, type },
      select: { id: true },
    })
  const tacos = await mk('TACOS', 'Tacos al Pastor', 89, 'FOOD')
  const cerveza = await mk('CERV', 'Cerveza', 45, 'BEVERAGE')
  const burger = await mk('BURG', 'Hamburguesa Doble', 169, 'FOOD')
  const jamon = await mk('HAM', 'Jamon por kg', 240, 'FOOD')
  const sincat = await mk('SINCAT', 'Suelto', 30, 'FOOD')

  const mesa5 = await prisma.table.create({
    data: { venueId, number: '5', capacity: 4, qrCode: `qr5-${suffix}` },
    select: { id: true },
  })
  const mesaA7 = await prisma.table.create({
    data: { venueId, number: 'A7', capacity: 2, qrCode: `qrA7-${suffix}` },
    select: { id: true },
  })

  const ana = await prisma.staff.create({
    data: { email: `ana-${suffix}@example.test`, firstName: 'Ana', lastName: 'López' },
    select: { id: true },
  })

  // 1. Combo (martes 12:00): línea con descuento propio (77.29) + línea sin
  //    descuento en cantidad 2 (90). Pago COMPLETED de 100 y un FAILED que no cuenta.
  await prisma.order.create({
    data: {
      venueId,
      orderNumber: `COMBO-${suffix}`,
      createdAt: DAY,
      tableId: mesa5.id,
      createdById: ana.id,
      type: 'DINE_IN',
      subtotal: 114,
      discountAmount: 0,
      taxAmount: 0,
      tipAmount: 10,
      total: 99,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: [
          {
            productId: tacos.id,
            productName: 'Tacos al Pastor',
            categoryName: 'Tacos',
            quantity: 1,
            unitPrice: 89,
            discountAmount: 11.71,
            taxAmount: 0,
            total: 77.29,
          },
          {
            productId: cerveza.id,
            productName: 'Cerveza',
            categoryName: 'Bebidas',
            quantity: 2,
            unitPrice: 45,
            discountAmount: 0,
            taxAmount: 0,
            total: 90,
          },
        ],
      },
      payments: {
        create: [
          {
            venueId,
            amount: 100,
            tipAmount: 10,
            method: 'CASH',
            status: 'COMPLETED',
            createdAt: DAY,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 100,
          },
          {
            venueId,
            amount: 50,
            tipAmount: 0,
            method: 'CASH',
            status: 'FAILED',
            createdAt: DAY,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 50,
          },
        ],
      },
    },
  })

  // 2. Extras (martes 12:00, PICKUP): modifiers que unitPrice no carga (449) y
  //    venta por peso (104.40). Pago COMPLETED de 50.
  await prisma.order.create({
    data: {
      venueId,
      orderNumber: `EXTRAS-${suffix}`,
      createdAt: DAY,
      tableId: mesaA7.id,
      createdById: ana.id,
      type: 'PICKUP',
      subtotal: 553.4,
      discountAmount: 0,
      taxAmount: 0,
      total: 553.4,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: [
          {
            productId: burger.id,
            productName: 'Hamburguesa Doble',
            categoryName: 'Hamburguesas',
            quantity: 1,
            unitPrice: 169,
            discountAmount: 0,
            taxAmount: 0,
            total: 169,
            modifiers: {
              create: [
                { name: 'Extra carne', quantity: 1, price: 250 },
                { name: 'Queso', quantity: 1, price: 30 },
              ],
            },
          },
          {
            productId: jamon.id,
            productName: 'Jamon por kg',
            categoryName: 'Carnes',
            quantity: 1,
            unitPrice: 240,
            discountAmount: 0,
            taxAmount: 0,
            weightQuantity: 0.435,
            total: 104.4,
          },
        ],
      },
      payments: {
        create: [
          {
            venueId,
            amount: 50,
            tipAmount: 0,
            method: 'CREDIT_CARD',
            status: 'COMPLETED',
            createdAt: DAY,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 50,
          },
        ],
      },
    },
  })

  // 3. Nocturna (04:30Z = martes 22:30 local): si algún bucket la pone en
  //    miércoles, el timezone del SQL está roto. Línea SIN categoryName.
  await prisma.order.create({
    data: {
      venueId,
      orderNumber: `NOCT-${suffix}`,
      createdAt: NOCTURNA,
      createdById: ana.id,
      type: 'DINE_IN',
      subtotal: 200,
      discountAmount: 0,
      taxAmount: 0,
      total: 200,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: {
        create: [{ productId: sincat.id, productName: 'Suelto', quantity: 1, unitPrice: 30, discountAmount: 0, taxAmount: 0, total: 30 }],
      },
      payments: {
        create: [
          {
            venueId,
            amount: 200,
            tipAmount: 0,
            method: 'CASH',
            status: 'COMPLETED',
            createdAt: NOCTURNA,
            feePercentage: 0,
            feeAmount: 0,
            netAmount: 200,
          },
        ],
      },
    },
  })

  // 4. Lunes sin pagos: revenue-trends debe mostrar el día con 0 (LEFT JOIN);
  //    aov-trends debe excluirlo (solo órdenes con cobro).
  await prisma.order.create({
    data: {
      venueId,
      orderNumber: `SINPAGO-${suffix}`,
      createdAt: LUNES,
      createdById: ana.id,
      type: 'DINE_IN',
      subtotal: 75,
      discountAmount: 0,
      taxAmount: 0,
      total: 75,
      status: 'COMPLETED',
      paymentStatus: 'PENDING',
    },
  })

  // 5-6. CANCELLED y PENDING: fuera de toda agregación de órdenes… salvo
  //     kitchen-performance, que nunca filtró status (comportamiento conservado).
  await prisma.order.create({
    data: {
      venueId,
      orderNumber: `CANC-${suffix}`,
      createdAt: DAY,
      type: 'DINE_IN',
      subtotal: 9999,
      discountAmount: 0,
      taxAmount: 0,
      total: 9999,
      status: 'CANCELLED',
      paymentStatus: 'PENDING',
      items: {
        create: [
          {
            productId: tacos.id,
            productName: 'Tacos al Pastor',
            categoryName: 'Tacos',
            quantity: 5,
            unitPrice: 89,
            discountAmount: 0,
            taxAmount: 0,
            total: 445,
          },
        ],
      },
    },
  })
  await prisma.order.create({
    data: {
      venueId,
      orderNumber: `PEND-${suffix}`,
      createdAt: DAY,
      type: 'DINE_IN',
      subtotal: 135,
      discountAmount: 0,
      taxAmount: 0,
      total: 135,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      items: {
        create: [
          {
            productId: cerveza.id,
            productName: 'Cerveza',
            categoryName: 'Bebidas',
            quantity: 3,
            unitPrice: 45,
            discountAmount: 0,
            taxAmount: 0,
            total: 135,
          },
        ],
      },
    },
  })

  // Reviews: dos del mediodía (4★, 5★) y una nocturna (3★) que pertenece al
  // MARTES local — las tres juntas promedian '4.0'.
  await prisma.review.createMany({
    data: [
      { venueId, overallRating: 4, createdAt: DAY },
      { venueId, overallRating: 5, createdAt: DAY },
      { venueId, overallRating: 3, createdAt: NOCTURNA },
    ],
  })

  // KDS: 10 y 20 minutos cuentan (avg 15.0); abierta, 25 h y 0 min quedan fuera.
  const kds = (mins: number | null, started = true) => ({
    venueId,
    createdAt: DAY,
    orderNumber: `K-${mins ?? 'open'}-${suffix}`,
    startedAt: started ? DAY : null,
    completedAt: mins == null ? null : new Date(DAY.getTime() + mins * 60000),
  })
  await prisma.kdsOrder.createMany({
    data: [kds(10), kds(20), kds(null), kds(25 * 60), kds(0)],
  })

  // Reservas del martes: CONFIRMED y COMPLETED cuentan como confirmadas.
  await prisma.reservation.createMany({
    data: (['CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'PENDING'] as const).map((status, i) => ({
      venueId,
      status,
      partySize: 2,
      createdAt: DAY,
      confirmationCode: `R${i}-${suffix}`,
      startsAt: DAY,
      endsAt: new Date(DAY.getTime() + 60 * 60000),
      blockedEndsAt: new Date(DAY.getTime() + 60 * 60000),
      duration: 60,
    })),
  })
})

afterAll(async () => {
  await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.review.deleteMany({ where: { venueId } })
  await prisma.kdsOrder.deleteMany({ where: { venueId } })
  await prisma.reservation.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.table.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { email: `ana-${suffix}@example.test` } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

// ===========================================================================
// Los cuatro números canónicos de lineRevenue, ahora calculados por Postgres
// ===========================================================================
describe('product-profitability — lineRevenueSql da los mismos números que lineRevenue', () => {
  it('reports the discounted combo line at 77.29, not 89 — and the cancelled order does not leak in', async () => {
    const rows = (await getExtendedMetrics(venueId, 'product-profitability', FILTERS)) as any[]
    const tacos = rows.find(r => r.name.startsWith('Tacos'))

    expect(tacos).toBeDefined()
    expect(round2(tacos.totalRevenue)).toBe(77.29)
    // La orden CANCELLED traía 5 tacos más: si el status NOT IN se pierde, aquí sale 6.
    expect(tacos.quantity).toBe(1)
  })

  it('still reports an undiscounted line at full price (2 × 45 = 90)', async () => {
    const rows = (await getExtendedMetrics(venueId, 'product-profitability', FILTERS)) as any[]
    const cerveza = rows.find(r => r.name.startsWith('Cerveza'))

    expect(round2(cerveza.totalRevenue)).toBe(90)
    expect(cerveza.quantity).toBe(2)
    // Mock 30% cost ratio de siempre: 45 × 0.3 × 2
    expect(round2(cerveza.totalCost)).toBe(27)
  })

  it('counts the modifiers the customer paid for (169 + 280 = 449)', async () => {
    const rows = (await getExtendedMetrics(venueId, 'product-profitability', FILTERS)) as any[]
    const burger = rows.find(r => r.name.startsWith('Hamburguesa'))

    expect(round2(burger.totalRevenue)).toBe(449)
  })

  it('charges a weighed item by the kilo (240/kg × 0.435 = 104.40, not 240)', async () => {
    const rows = (await getExtendedMetrics(venueId, 'product-profitability', FILTERS)) as any[]
    const jamon = rows.find(r => r.name.startsWith('Jamon'))

    expect(round2(jamon.totalRevenue)).toBe(104.4)
  })
})

// ===========================================================================
// Bucketing en la zona del venue: la orden de las 04:30Z es del MARTES local
// ===========================================================================
describe('timezone bucketing — la venta nocturna pertenece al día local, no al UTC', () => {
  it('weekly-trends: la nocturna suma al Martes y la CANCELLED no suma a nada', async () => {
    const data = (await getChartData(venueId, 'weekly-trends', FILTERS)) as Array<{
      day: string
      currentWeek: number
      previousWeek: number
    }>

    const martes = data.find(d => d.day === 'Martes')!
    const miercoles = data.find(d => d.day === 'Miércoles')!
    const lunes = data.find(d => d.day === 'Lunes')!

    expect(round2(martes.currentWeek)).toBe(852.4) // 99 + 553.40 + 200 (nocturna)
    expect(miercoles.currentWeek).toBe(0) // agrupar en UTC la pondría aquí
    expect(round2(lunes.currentWeek)).toBe(75)
    expect(data.map(d => d.day)).toEqual(['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'])
  })

  it('peak-hours: la nocturna cae en la hora 22 local, no en la 4', async () => {
    const data = (await getChartData(venueId, 'peak-hours', FILTERS)) as Array<{ hour: number; sales: number; transactions: number }>

    const h22 = data.find(d => d.hour === 22)!
    expect(round2(h22.sales)).toBe(200)
    expect(h22.transactions).toBe(1)
    expect(data.find(d => d.hour === 4)).toBeUndefined()

    const h12 = data.find(d => d.hour === 12)!
    expect(round2(h12.sales)).toBe(727.4) // 99 + 553.40 (martes) + 75 (lunes)
    expect(h12.transactions).toBe(3)
  })

  it('sales-heatmap: celda martes(1) × 22h con la venta nocturna', async () => {
    const { heatmap } = (await getChartData(venueId, 'sales-heatmap', FILTERS)) as {
      heatmap: Array<{ day: number; hour: number; value: number }>
    }

    expect(heatmap).toHaveLength(168) // rejilla completa 7 × 24, como siempre
    const celda = heatmap.find(c => c.day === 1 && c.hour === 22)!
    expect(round2(celda.value)).toBe(200)
    const celdaUtc = heatmap.find(c => c.day === 2 && c.hour === 4)!
    expect(celdaUtc.value).toBe(0)
  })

  it('customer-satisfaction: la review nocturna promedia con las del martes local (string "4.0")', async () => {
    const { satisfaction } = (await getChartData(venueId, 'customer-satisfaction', FILTERS)) as {
      satisfaction: Array<{ date: string; rating: string | number; reviewCount: number }>
    }

    expect(satisfaction).toHaveLength(1)
    expect(satisfaction[0].date).toBe('2025-03-11')
    // (4 + 5 + 3) / 3 — y `.toFixed(1)` devuelve STRING, contrato de siempre.
    expect(satisfaction[0].rating).toBe('4.0')
    expect(satisfaction[0].reviewCount).toBe(3)
  })

  it('revenue-trends: el lunes sin pagos existe con 0 y el martes suma solo pagos COMPLETED', async () => {
    const { revenue } = (await getChartData(venueId, 'revenue-trends', FILTERS)) as {
      revenue: Array<{ date: string; revenue: number; formattedDate: string }>
    }

    expect(revenue.map(r => r.date)).toEqual(['2025-03-10', '2025-03-11'])
    expect(revenue[0].revenue).toBe(0) // orden sin pagos: el día NO desaparece
    expect(round2(revenue[1].revenue)).toBe(350) // 100 + 50 + 200; el FAILED de 50 no cuenta
  })

  it('aov-trends: solo órdenes con cobro; la división queda en Node como siempre', async () => {
    const { aov } = (await getChartData(venueId, 'aov-trends', FILTERS)) as {
      aov: Array<{ date: string; aov: number; orderCount: number }>
    }

    expect(aov).toHaveLength(1) // el lunes sin cobro no aparece
    expect(aov[0].date).toBe('2025-03-11')
    expect(aov[0].orderCount).toBe(3)
    expect(round2(aov[0].aov)).toBe(116.67) // 350 / 3
  })
})

// ===========================================================================
// El resto de las agregaciones migradas
// ===========================================================================
describe('agregaciones restantes — mismos números que la versión Node', () => {
  it('sales-by-weekday: shape fijo de 7 días con la nocturna en Martes', async () => {
    const data = (await getChartData(venueId, 'sales-by-weekday', FILTERS)) as Array<{ day: string; sales: number; transactions: number }>

    expect(data).toHaveLength(7)
    const martes = data.find(d => d.day === 'Martes')!
    expect(round2(martes.sales)).toBe(852.4)
    expect(martes.transactions).toBe(3)
  })

  it('order-frequency: conteo por hora local', async () => {
    const { frequency } = (await getChartData(venueId, 'order-frequency', FILTERS)) as {
      frequency: Array<{ hour: string; orders: number; hourNum: number }>
    }

    expect(frequency.find(f => f.hourNum === 12)).toEqual({ hour: '12:00', orders: 3, hourNum: 12 })
    expect(frequency.find(f => f.hourNum === 22)).toEqual({ hour: '22:00', orders: 1, hourNum: 22 })
  })

  it('category-mix: una línea sin categoryName cae en "Sin categoría" y los porcentajes suman 100', async () => {
    const data = (await getChartData(venueId, 'category-mix', FILTERS)) as Array<{
      category: string
      revenue: number
      quantity: number
      percentage: number
    }>

    const sinCat = data.find(d => d.category === 'Sin categoría')!
    expect(round2(sinCat.revenue)).toBe(30)
    const bebidas = data.find(d => d.category === 'Bebidas')!
    expect(round2(bebidas.revenue)).toBe(90) // la PENDING con 3 cervezas no cuenta
    expect(bebidas.quantity).toBe(2)
    expect(round2(data.reduce((s, d) => s + d.percentage, 0))).toBe(100)
  })

  it('channel-mix: DINE_IN vs PICKUP con la CANCELLED fuera', async () => {
    const data = (await getChartData(venueId, 'channel-mix', FILTERS)) as Array<{ channel: string; revenue: number; count: number }>

    const dineIn = data.find(d => d.channel === 'DINE_IN')!
    expect(round2(dineIn.revenue)).toBe(374) // 99 + 200 + 75 — sin los 9999 cancelados
    expect(dineIn.count).toBe(3)
    const pickup = data.find(d => d.channel === 'PICKUP')!
    expect(round2(pickup.revenue)).toBe(553.4)
  })

  it('staff-ranking: agrupa por quien creó la orden, con nombre y ticket promedio', async () => {
    const data = (await getChartData(venueId, 'staff-ranking', FILTERS)) as Array<{
      name: string
      revenue: number
      orders: number
      tips: number
      averageTicket: number
    }>

    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('Ana López')
    expect(round2(data[0].revenue)).toBe(927.4) // 99 + 553.40 + 200 + 75
    expect(data[0].orders).toBe(4)
    expect(round2(data[0].tips)).toBe(10)
    expect(round2(data[0].averageTicket)).toBe(231.85)
  })

  it('table-performance: agrupa por mesa; un número de mesa no numérico sigue dando NaN', async () => {
    const rows = (await getExtendedMetrics(venueId, 'table-performance', FILTERS)) as any[]

    const mesa5 = rows.find(r => r.tableNumber === 5)!
    expect(round2(mesa5.totalSales)).toBe(99)
    expect(mesa5.orderCount).toBe(1)
    expect(round2(mesa5.avgTicket)).toBe(99)
    expect(round2(mesa5.totalRevenue)).toBe(99)

    // `parseInt('A7')` siempre fue NaN (→ null en el JSON de la API): se conserva.
    const mesaA7 = rows.find(r => Number.isNaN(r.tableNumber))!
    expect(mesaA7).toBeDefined()
    expect(round2(mesaA7.totalSales)).toBe(553.4)

    // La nocturna no tiene mesa: no aparece como fila.
    expect(rows).toHaveLength(2)
  })

  it('kitchen-performance cuenta LÍNEAS por tipo de producto y NUNCA filtró por status (conservado)', async () => {
    const { kitchen } = (await getChartData(venueId, 'kitchen-performance', FILTERS)) as {
      kitchen: Array<{ category: string; prepTime: number; target: number; orders: number }>
    }

    // FOOD: tacos(combo) + burger + jamón + suelto + tacos(CANCELLED) = 5 líneas.
    // El include original no filtraba Order.status; cambiar eso aquí movería un
    // número publicado, así que el SQL lo replica tal cual.
    const comida = kitchen.find(k => k.category === 'Comida')!
    expect(comida.orders).toBe(5)
    expect(comida.prepTime).toBe(0)
    // BEVERAGE: cerveza(combo) + cerveza(PENDING) = 2 líneas.
    const bebidas = kitchen.find(k => k.category === 'Bebidas')!
    expect(bebidas.orders).toBe(2)
  })

  it('reservation-overview: buckets por día local y resumen por status', async () => {
    const data = (await getChartData(venueId, 'reservation-overview', FILTERS)) as {
      reservations: Array<{ date: string; total: number; confirmed: number; cancelled: number }>
      summary: { total: number; confirmed: number; cancelled: number; noShow: number }
    }

    expect(data.summary).toEqual({ total: 5, confirmed: 2, cancelled: 1, noShow: 1 })
    // La fila por fecha conserva su forma exacta (sin noShow por día).
    expect(data.reservations).toEqual([{ date: '2025-03-11', total: 5, confirmed: 2, cancelled: 1 }])
  })

  it('best-selling-products: cantidades agregadas por producto, catálogo actual', async () => {
    const { products } = (await getChartData(venueId, 'best-selling-products', FILTERS)) as {
      products: Array<{ id: string; name: string; type: string; quantity: number; price: number }>
    }

    const cerveza = products.find(p => p.name.startsWith('Cerveza'))!
    expect(cerveza.quantity).toBe(2) // la PENDING con 3 más queda fuera
    expect(cerveza.type).toBe('BEVERAGE')
    expect(cerveza.price).toBe(45)
    expect(products.find(p => p.name.startsWith('Tacos'))!.quantity).toBe(1)
  })

  it('getGeneralStatsData: products agregados + prep overall medido + listas con su forma de siempre', async () => {
    const data = await getGeneralStatsData(venueId, FILTERS)

    // Solo pagos COMPLETED de órdenes no canceladas, más nuevos primero.
    expect(data.payments).toHaveLength(3)
    expect(data.payments.map(p => round2(p.amount))).toEqual([200, 100, 50])
    expect(data.payments[0].tips).toEqual([{ amount: 0 }])

    expect(data.reviews).toHaveLength(3)
    expect(data.reviews[0].stars).toBe(3)

    const cerveza = data.products.find(p => p.name.startsWith('Cerveza'))!
    expect(cerveza.quantity).toBe(2)

    // KDS: (10 + 20) / 2 = 15.0 sobre exactamente 2 comandas medibles — la
    // abierta, la de 25 h y la de 0 minutos quedan fuera, como siempre.
    expect(data.extraMetrics.prepTimesByCategory.overall).toEqual({ avg: 15, target: null, medicion: 2 })

    const martes = data.extraMetrics.weeklyTrendsData.find((d: any) => d.day === 'Martes')!
    expect(round2(martes.currentWeek)).toBe(852.4)
  })
})
