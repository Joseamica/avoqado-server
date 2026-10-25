/**
 * Los ingresos por artículo cuentan los descuentos de CUENTA repartidos (`OrderDiscount.reparto`), contra Postgres REAL.
 * Reporte por artículo, `product_sales` (lineRevenueSql) y el desglose nocturno por categoría deben dar el MISMO neto.
 *
 * TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/dashboard/salesByItem.descuentoDeCuenta.integration.test.ts
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { nuevoRepartoDirigido } from '@/services/shared/repartoDescuento'
import { sincronizarRepartos } from '@/services/shared/repartoDescuentoTx'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { lineRevenue, lineRevenueSql } from '@/services/dashboard/lineRevenue'
import { getCategoryBreakdown } from '@/jobs/nightly-sales-summary.job'
import { crearNegocio, NegocioDePrueba } from '../product-variants/fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

const DAY = new Date('2025-03-11T18:00:00.000Z')
const FROM_ISO = '2025-03-09T00:00:00.000Z'
const TO_ISO = '2025-03-12T23:59:59.999Z'
const cents = (n: number): number => Math.round(n * 100)

describe('reportes por artículo: descuento de cuenta repartido', () => {
  let n: NegocioDePrueba
  const ids: Record<string, { productId: string; itemId: string }> = {}

  const crearOrden = async (
    clave: string,
    items: Array<{ key: string; price: number; discount?: number }>,
    descuentos: Array<{ amount: number; reparto: unknown }>,
  ) => {
    const total = items.reduce((s, i) => s + i.price - (i.discount ?? 0), 0) - descuentos.reduce((s, d) => s + d.amount, 0)
    const order = await prisma.order.create({
      data: {
        venueId: n.venueId,
        orderNumber: `DC-${clave}-${Date.now()}`,
        createdAt: DAY,
        subtotal: items.reduce((s, i) => s + i.price, 0),
        taxAmount: 0,
        total,
        discountAmount: descuentos.reduce((s, d) => s + d.amount, 0),
        status: 'COMPLETED',
        paymentStatus: 'PAID',
      },
    })
    for (const i of items) {
      const product = await prisma.product.create({
        data: { venueId: n.venueId, categoryId: n.categoryId, sku: `DC-${i.key}-${Date.now()}`, name: i.key, price: i.price } as any,
      })
      const item = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          productName: i.key,
          quantity: 1,
          unitPrice: i.price,
          discountAmount: i.discount ?? 0,
          taxAmount: 0,
          total: i.price - (i.discount ?? 0),
        },
      })
      ids[i.key] = { productId: product.id, itemId: item.id }
    }
    for (const d of descuentos) {
      const reparto = d.reparto as any
      const real = reparto && {
        ...reparto,
        renglones: Object.fromEntries(Object.entries(reparto.renglones).map(([k, v]) => [ids[k].itemId, v])),
      }
      await prisma.orderDiscount.create({
        data: {
          orderId: order.id,
          type: 'FIXED_AMOUNT',
          name: 'Descuento',
          value: d.amount,
          amount: d.amount,
          reparto: real ?? Prisma.DbNull,
        } as any,
      })
    }
  }

  beforeAll(async () => {
    n = await crearNegocio('dc-cuenta')
    // A) $600 + $400, descuento de cuenta de $150 repartido 90/60.
    await crearOrden(
      'A',
      [
        { key: 'Pizza', price: 600 },
        { key: 'Pasta', price: 400 },
      ],
      [{ amount: 150, reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { Pizza: 9000, Pasta: 6000 } } }],
    )
    // B) descuento por artículo (con su fila espejo): NO se resta dos veces.
    await crearOrden(
      'B',
      [{ key: 'Taco', price: 100, discount: 20 }],
      [{ amount: 20, reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { Taco: 2000 } } }],
    )
    // C) anterior a B2: fila sin reparto, no aporta nada por renglón (igual que hoy).
    // D) DIRIGIDO espejo:false (motor/TPV/sellos): el renglón NO lleva discountAmount; su parte sólo vive en el reparto.
    //    Pasa por el escritor real (`nuevoRepartoDirigido` + `sincronizarRepartos`), no por un JSON a mano.
    await crearOrden(
      'D',
      [
        { key: 'Flan', price: 100 },
        { key: 'Cafe', price: 50 },
      ],
      [{ amount: 30, reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones: { Flan: 3000 } } }],
    )
    {
      const fila = await prisma.orderDiscount.findFirstOrThrow({
        where: { orderId: (await prisma.orderItem.findUniqueOrThrow({ where: { id: ids.Flan.itemId } })).orderId },
      })
      await prisma.orderDiscount.update({
        where: { id: fila.id },
        data: {
          appliedToItemIds: [ids.Flan.itemId],
          reparto: nuevoRepartoDirigido(30, { [ids.Flan.itemId]: 30 }, { espejo: false }) as any,
        },
      })
      await prisma.$transaction(tx => sincronizarRepartos(tx, fila.orderId))
    }
    await crearOrden('C', [{ key: 'Sopa', price: 80 }], [{ amount: 8, reparto: null }])
  })

  afterAll(async () => {
    if (!n?.venueId) return
    await prisma.orderDiscount.deleteMany({ where: { order: { venueId: n.venueId } } })
    await prisma.orderItem.deleteMany({ where: { order: { venueId: n.venueId } } })
    await prisma.order.deleteMany({ where: { venueId: n.venueId } })
    await n.limpiar()
  })

  it('cuenta repartida 90/60 → descuento 90 y 60, neto 510 y 340; espejo y sin reparto como hoy', async () => {
    const r = await getSalesByItem(n.venueId, { startDate: FROM_ISO, endDate: TO_ISO })
    const por = new Map(r.items.map(i => [i.productName, [cents(i.grossSales), cents(i.discounts), cents(i.netSales)]]))
    expect(por.get('Pizza')).toEqual([60000, 9000, 51000])
    expect(por.get('Pasta')).toEqual([40000, 6000, 34000])
    expect(por.get('Taco')).toEqual([10000, 2000, 8000]) // el espejo no se resta otra vez
    expect(por.get('Sopa')).toEqual([8000, 0, 8000]) // reparto nulo: igual que hoy
    expect(por.get('Flan')).toEqual([10000, 3000, 7000]) // DIRIGIDO no espejo: su parte baja el neto del renglón
    expect(por.get('Cafe')).toEqual([5000, 0, 5000])
    expect(cents(r.totals.netSales)).toBe(51000 + 34000 + 8000 + 8000 + 7000 + 5000)
  })

  it('product_sales (lineRevenueSql) y el desglose nocturno dan el MISMO neto', async () => {
    const [agg] = await prisma.$queryRaw<Array<{ revenue: Prisma.Decimal }>>`
      SELECT COALESCE(SUM(${Prisma.raw(lineRevenueSql())}), 0) AS revenue
      FROM "OrderItem" oi INNER JOIN "Order" o ON o.id = oi."orderId"
      WHERE oi."productId" = ${ids.Pizza.productId} AND o."venueId" = ${n.venueId}`
    expect(cents(Number(agg.revenue))).toBe(51000)

    const cat = await getCategoryBreakdown(n.venueId, new Date(FROM_ISO), new Date(TO_ISO))
    expect(cat.reduce((s, c) => s + cents(c.netSales), 0)).toBe(51000 + 34000 + 8000 + 8000 + 7000 + 5000)
  })

  it('el gemelo JS (lineRevenue, reporte de turno) da lo mismo que lineRevenueSql en cada renglón', async () => {
    const sql = await prisma.$queryRaw<Array<{ id: string; revenue: Prisma.Decimal }>>`
      SELECT oi.id, ${Prisma.raw(lineRevenueSql())} AS revenue
      FROM "OrderItem" oi INNER JOIN "Order" o ON o.id = oi."orderId"
      WHERE o."venueId" = ${n.venueId}`
    const orders = await prisma.order.findMany({
      where: { venueId: n.venueId },
      take: 10,
      select: {
        items: {
          select: {
            id: true,
            quantity: true,
            unitPrice: true,
            discountAmount: true,
            weightQuantity: true,
            modifiers: { select: { price: true, quantity: true } },
          },
        },
        orderDiscounts: { select: { reparto: true } },
      },
    })
    const js = new Map(orders.flatMap(o => o.items.map(i => [i.id, cents(lineRevenue(i, o.orderDiscounts))] as const)))
    expect(sql.length).toBe(js.size)
    for (const r of sql) expect([r.id, js.get(r.id)]).toEqual([r.id, cents(Number(r.revenue))])
  })
})
