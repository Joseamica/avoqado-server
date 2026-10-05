/**
 * Integration (REAL PostgreSQL): the readers of `Order.discountAmount` use the EFFECTIVE merchandise discount PER ORDER
 * (sales summary cards + periods, and the dashboard's discount analysis).
 *
 * Codex B2c r1, P2: since B2/B2c `Order.discountAmount` is the Σ of the discount rows, WITHOUT a cap, so it can exceed
 * `Order.subtotal` (a cortesía on top of an account-level fixed discount). Charging is right — `computeStoredOrderTotal`
 * caps the merchandise at 0 — but the report subtracted the full header from the gross: café $100 + pan $50, fixed $60
 * and the café given away ⇒ header $160 on a $150 subtotal ⇒ «net sales» −$10 for an account worth $0.
 *
 * The cap is PER ORDER (LEAST(discountAmount, subtotal) inside the SUM): capping only the period total would let the
 * $10 excess of one order eat the sales of another. Hence the second, ordinary $100 order in the same day.
 *
 * Run: TEST_DATABASE_URL='postgresql://…/<a disposable test db>' npx jest --selectProjects integration --runTestsByPath <this file>
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getChartData } from '@/services/dashboard/generalStats.dashboard.service'
import { getOrderSourcesBreakdown } from '@/jobs/nightly-sales-summary.job'

const TZ = 'America/Mexico_City'
const FROM = new Date('2025-05-08T06:00:00.000Z')
const TO = new Date('2025-05-09T05:59:59.999Z')
const INSIDE = new Date('2025-05-08T18:00:00.000Z')
const suffix = `descefe-${Date.now()}`

let orgId: string
let venueId: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `DescEfe Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `descefe-${suffix}`, slug: `descefe-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id

  // The Codex account: subtotal 150, header 160 (fixed $60 + café cortesía $100), total 0, nothing charged.
  await prisma.order.create({
    data: {
      venueId,
      orderNumber: `DE-1-${suffix}`,
      createdAt: INSIDE,
      subtotal: 150,
      discountAmount: 160,
      taxAmount: 0,
      total: 0,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
  })
  // An ordinary $100 account paid in cash, same day.
  const normal = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `DE-2-${suffix}`,
      createdAt: INSIDE,
      subtotal: 100,
      discountAmount: 0,
      taxAmount: 0,
      total: 100,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
    select: { id: true },
  })
  await prisma.payment.create({
    data: {
      venueId,
      orderId: normal.id,
      amount: 100,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: 100,
      createdAt: INSIDE,
    },
  })
})

afterAll(async () => {
  if (!orgId) return
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const range = { startDate: FROM.toISOString(), endDate: TO.toISOString(), timezone: TZ }

describe('getSalesSummary — the discount subtracted from the gross is the effective one PER ORDER', () => {
  it('summary cards: discounts 150 (not 160), net sales / collected / profit 100 (not 90)', async () => {
    const { summary } = await getSalesSummary(venueId, range)

    expect(summary.grossSales).toBe(250)
    expect(summary.discounts).toBe(150)
    expect(summary.netSales).toBe(100)
    expect(summary.totalCollected).toBe(100)
    expect(summary.netProfit).toBe(100)
  })

  it('period view: the same day bucket gives discounts 150 and net 100', async () => {
    const { byPeriod } = await getSalesSummary(venueId, { ...range, reportType: 'days' })

    expect(byPeriod).toHaveLength(1)
    const m = byPeriod![0].metrics
    expect(m.grossSales).toBe(250)
    expect(m.discounts).toBe(150)
    expect(m.netSales).toBe(100)
    expect(m.totalCollected).toBe(100)
    expect(m.netProfit).toBe(100)
  })
})

describe('getChartData(discount-analysis) — the order-level discount reported is the effective one PER ORDER', () => {
  it('the $0 account reports 150 of order-level discount (not 160); the ordinary order is not counted', async () => {
    const r = (await getChartData(venueId, 'discount-analysis', { fromDate: FROM.toISOString(), toDate: TO.toISOString() })) as any

    expect(r.ordersWithDiscount).toBe(1)
    expect(r.orderLevelDiscount).toBe(150)
    expect(r.itemLevelDiscount).toBe(0)
    expect(r.totalDiscount).toBe(150)
    expect(r.averageDiscount).toBe(150)
  })
})

// B2c F2 (ruling «pendiente 1 de F1»): el aviso del correo nocturno («net sales negativo, data dañada») nombra sólo la cabecera
// que sus FILAS no explican. Otro día, para no tocar las cuentas de arriba.
describe('warnOnClampedOrders (correo nocturno) — sólo la cabecera que sus filas no explican', () => {
  const DIA = new Date('2025-05-10T18:00:00.000Z')
  const DESDE = new Date('2025-05-10T06:00:00.000Z')
  const HASTA = new Date('2025-05-11T05:59:59.999Z')
  const cuenta = (n: string, subtotal: number, descuento: number, filas: number[]) =>
    prisma.order.create({
      data: {
        venueId,
        orderNumber: `DE-W${n}-${suffix}`,
        createdAt: DIA,
        subtotal,
        discountAmount: descuento,
        taxAmount: 0,
        total: 0,
        status: 'COMPLETED',
        paymentStatus: 'PENDING',
        orderDiscounts: {
          create: filas.map((amount, i) => ({ type: 'FIXED_AMOUNT' as const, name: `Fila ${i}`, value: amount, amount })),
        },
      },
      select: { id: true },
    })

  it('🔴 la cortesía sobre un fijo (160 = 60 + 100 sobre 150) no se avisa; sin filas o sin cuadrar, sí', async () => {
    const legitima = await cuenta('1', 150, 160, [60, 100])
    const sinFilas = await cuenta('2', 150, 160, [])
    const noCuadra = await cuenta('3', 150, 160, [100])
    const warn = jest.spyOn(logger, 'warn')
    try {
      await getOrderSourcesBreakdown(venueId, DESDE, HASTA)
      const avisadas = (warn.mock.calls as unknown as Array<[unknown, { orderId?: string }]>)
        .filter(([m]) => String(m).includes('net sales negativo'))
        .map(([, meta]) => meta.orderId)
      expect(avisadas.sort()).toEqual([sinFilas.id, noCuadra.id].sort())
      expect(avisadas).not.toContain(legitima.id)
    } finally {
      warn.mockRestore()
    }
  })
})

// B2c F1b (Codex r2, P2): el bruto y el descuento efectivo se leían en DOS consultas, sin foto común. Una venta guardada
// ENTRE las dos lecturas (otra transacción) quedaba con su descuento contado y su bruto no: venta de $100 sin descuento +
// (intercalada) venta de $200 con descuento de $150 ⇒ bruto 100, descuentos 150, neto −50. Las fotos válidas son 100 (antes)
// o 150 (después). Venue propio, para no tocar las cuentas de arriba.
describe('getSalesSummary — bruto y descuento salen de UNA foto (una venta intercalada entre lecturas)', () => {
  let carreraVenueId: string

  afterAll(async () => {
    if (!carreraVenueId) return
    await prisma.order.deleteMany({ where: { venueId: carreraVenueId } })
    await prisma.venue.deleteMany({ where: { id: carreraVenueId } })
  })

  it('🔴 la venta intercalada tras la PRIMERA lectura de órdenes nunca deja un neto de −50', async () => {
    carreraVenueId = (
      await prisma.venue.create({
        data: { organizationId: orgId, name: `descefe-carrera-${suffix}`, slug: `descefe-carrera-${suffix}`, timezone: TZ },
        select: { id: true },
      })
    ).id
    const venta = (n: string, subtotal: number, descuento: number) =>
      prisma.order.create({
        data: {
          venueId: carreraVenueId,
          orderNumber: `DE-C${n}-${suffix}`,
          createdAt: INSIDE,
          subtotal,
          discountAmount: descuento,
          taxAmount: 0,
          total: subtotal - descuento,
          status: 'COMPLETED',
          paymentStatus: 'PENDING',
        },
      })
    await venta('1', 100, 0)

    // La otra transacción: se guarda justo DESPUÉS de la primera lectura de órdenes que haga el resumen, sea un agregado de
    // Prisma o SQL crudo sobre "Order" — el espía no supone cuál es.
    let intercalada = false
    const intercalar = async () => {
      if (intercalada) return
      intercalada = true
      await venta('2', 200, 150)
    }
    const realAggregate = prisma.order.aggregate.bind(prisma.order)
    const realRaw = prisma.$queryRawUnsafe.bind(prisma)
    const aggSpy = jest.spyOn(prisma.order, 'aggregate').mockImplementation((async (args: any) => {
      const r = await realAggregate(args)
      await intercalar()
      return r
    }) as any)
    const rawSpy = jest.spyOn(prisma, '$queryRawUnsafe').mockImplementation((async (sql: string, ...params: unknown[]) => {
      const r = await realRaw(sql, ...params)
      if (/FROM\s+"Order"/.test(sql)) await intercalar()
      return r
    }) as any)
    try {
      const { summary } = await getSalesSummary(carreraVenueId, range)

      expect(intercalada).toBe(true)
      expect([100, 150]).toContain(summary.netSales)
      expect(summary.discounts).toBeLessThanOrEqual(summary.grossSales!)
      expect(summary.netSales).toBe(summary.grossSales! - summary.discounts!)
      expect(summary.totalCollected).toBe(summary.netSales)
      expect(summary.netProfit).toBe(summary.netSales)
    } finally {
      aggSpy.mockRestore()
      rawSpy.mockRestore()
    }
  })
})
