/**
 * Full-testing v2 · FAIL #2 (R3): en el DETALLE del turno, la cuenta de tarjetas de regalo no es una orden ni sus renglones son
 * productos vendidos. La cabecera ya decía «2 órdenes», pero el desglose por empleado, la lista de órdenes y «Productos vendidos»
 * la contaban («Alex Demo · 5 orders», «Unknown Product ×7»). El dinero (cobros, efectivo, caja) no cambia: eso lo cubren
 * `tests/integration/giftCards/ventas.integration.test.ts` y el desglose por método.
 *
 * `getShiftById` hace la cuenta en JavaScript sobre las filas que ya trajo Prisma, así que el cliente fingido sí ejercita el código real.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { getShiftById } from '@/services/dashboard/shift.dashboard.service'
import { contarOrdenesCobradas } from '@/services/tpv/shift.tpv.service'

const CAJERA = { id: 'staff-1', firstName: 'Ana', lastName: 'López' }

/** La cuenta de tarjetas: dos sobres ($500 + $300), sin producto (la marca R11 es `giftCardId`). */
const cuentaDeTarjetas = {
  id: 'orden-tarjetas',
  orderNumber: 'GC-1',
  total: 800,
  subtotal: 800,
  status: 'COMPLETED',
  table: null,
  createdAt: new Date('2026-10-19T15:00:00.000Z'),
  servedById: CAJERA.id,
  servedBy: CAJERA,
  payments: [{ id: 'pago-tarjetas', method: 'CASH', cardBrand: null, maskedPan: null }],
  items: [
    { id: 'oi-gc-1', quantity: 1, unitPrice: 500, discountAmount: 0, giftCardId: 'gc-1', product: null },
    { id: 'oi-gc-2', quantity: 1, unitPrice: 300, discountAmount: 0, giftCardId: 'gc-2', product: null },
  ],
}

const ventaDeMercancia = {
  id: 'orden-playera',
  orderNumber: 'A-2',
  total: 150,
  subtotal: 150,
  status: 'COMPLETED',
  table: null,
  createdAt: new Date('2026-10-19T16:00:00.000Z'),
  servedById: CAJERA.id,
  servedBy: CAJERA,
  payments: [{ id: 'pago-playera', method: 'CASH', cardBrand: null, maskedPan: null }],
  items: [{ id: 'oi-playera', quantity: 1, unitPrice: 150, discountAmount: 0, giftCardId: null, product: { id: 'p1', name: 'Playera' } }],
}

const cobro = (id: string, orderId: string, amount: number, deTarjetas: boolean) => ({
  id,
  amount,
  tipAmount: 0,
  method: 'CASH',
  tenderLabel: null,
  externalSource: null,
  cardBrand: null,
  maskedPan: null,
  processorData: null,
  processedById: CAJERA.id,
  processedBy: CAJERA,
  orderId,
  createdAt: new Date('2026-10-19T16:00:00.000Z'),
  order: { items: deTarjetas ? [{ id: 'oi-gc-1' }] : [] },
})

// Turno CERRADO: el total de ventas sale del firmado y no hace falta la consulta cruda del turno abierto.
const turno = (orders: unknown[], payments: unknown[], totalSales: number) => ({
  id: 'shift-1',
  venueId: 'venue-1',
  staffId: CAJERA.id,
  status: 'CLOSED',
  startTime: new Date('2026-10-19T14:00:00.000Z'),
  endTime: new Date('2026-10-19T22:00:00.000Z'),
  startingCash: 0,
  endingCash: 0,
  totalSales,
  totalTips: 0,
  staff: { ...CAJERA, email: 'ana@example.test' },
  venue: { id: 'venue-1', name: 'Venue', timezone: 'America/Mexico_City' },
  payments,
  orders,
})

describe('detalle del turno · la cuenta de tarjetas no es orden ni producto (FAIL #2)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('una venta de tarjetas + una de mercancía ⇒ 1 orden por empleado, 1 en la lista y sólo los productos de la mercancía', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(
      turno(
        [ventaDeMercancia, cuentaDeTarjetas],
        [cobro('pago-playera', 'orden-playera', 150, false), cobro('pago-tarjetas', 'orden-tarjetas', 800, true)],
        150,
      ) as any,
    )

    const detalle = await getShiftById('venue-1', 'shift-1')

    expect(detalle.staffBreakdown.map((s: { staffId: string; ordersCount: number }) => [s.staffId, s.ordersCount])).toEqual([
      [CAJERA.id, 1],
    ])
    expect(detalle.orders.map((o: { id: string }) => o.id)).toEqual(['orden-playera'])
    expect(detalle.topProducts).toEqual([{ name: 'Playera', quantity: 1, revenue: 150 }])
    expect([detalle.totalOrders, detalle.stats.totalOrders, detalle.stats.totalProducts]).toEqual([1, 1, 1])
    // El dinero NO cambia: los dos cobros siguen en la lista y en el conteo de cobros.
    expect(detalle.payments).toHaveLength(2)
    expect(detalle.stats.totalPayments).toBe(2)
  })

  it('un turno de sólo tarjetas ⇒ 0 órdenes, lista vacía y 0 productos (no 1)', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(turno([cuentaDeTarjetas], [cobro('pago-tarjetas', 'orden-tarjetas', 800, true)], 0) as any)

    const detalle = await getShiftById('venue-1', 'shift-1')

    expect(detalle.staffBreakdown.map((s: { staffId: string; ordersCount: number }) => [s.staffId, s.ordersCount])).toEqual([
      [CAJERA.id, 0],
    ])
    expect(detalle.orders).toEqual([])
    expect(detalle.topProducts).toEqual([])
    expect([detalle.totalOrders, detalle.stats.totalOrders, detalle.stats.totalProducts]).toEqual([0, 0, 0])
    expect(detalle.payments).toHaveLength(1)
  })

  it('con la membresía del cierre (19-oct), la cuenta de tarjetas que llega por sus cobros del turno tampoco cuenta', async () => {
    // Lo normal: las dos se cobraron CON turno, así que `orders` del turno llega vacío y el detalle las pide aparte.
    prismaMock.shift.findFirst.mockResolvedValue(
      turno([], [cobro('pago-playera', 'orden-playera', 150, false), cobro('pago-tarjetas', 'orden-tarjetas', 800, true)], 150) as any,
    )
    prismaMock.order.findMany.mockResolvedValue([ventaDeMercancia, cuentaDeTarjetas] as any)

    const detalle = await getShiftById('venue-1', 'shift-1')

    const pedidas = (prismaMock.order.findMany.mock.calls[0][0] as any).select.items.select
    expect(pedidas.giftCardId).toBe(true)
    expect(detalle.orders.map((o: { id: string }) => o.id)).toEqual(['orden-playera'])
    expect(
      detalle.staffBreakdown.map((s: { staffId: string; ordersCount: number; sales: number }) => [s.staffId, s.ordersCount, s.sales]),
    ).toEqual([[CAJERA.id, 1, 150]])
    expect(detalle.topProducts).toEqual([{ name: 'Playera', quantity: 1, revenue: 150 }])
    expect([detalle.totalOrders, detalle.stats.totalOrders]).toEqual([1, 1])
  })

  // S0.4 (tarjetas 1b): la lista cuenta con `contarOrdenesCobradas`, que salta la orden con ALGÚN renglón de tarjeta. Una cuenta
  // mezclada no debería existir (A5), pero si existiera, el detalle y la lista tienen que dar el mismo número.
  it('una cuenta MIXTA cobrada en el turno no cuenta en el detalle, igual que en la lista', async () => {
    const cuentaMixta = {
      ...cuentaDeTarjetas,
      id: 'orden-mixta',
      orderNumber: 'GC-2',
      items: [
        { id: 'oi-mixta-gc', quantity: 1, unitPrice: 500, discountAmount: 0, giftCardId: 'gc1', product: null },
        {
          id: 'oi-mixta-playera',
          quantity: 1,
          unitPrice: 150,
          discountAmount: 0,
          giftCardId: null,
          product: { id: 'p1', name: 'Playera' },
        },
      ],
    }
    const pagos = [cobro('pago-playera', 'orden-playera', 150, false), cobro('pago-mixta', 'orden-mixta', 650, true)]
    prismaMock.shift.findFirst.mockResolvedValue(turno([], pagos, 150) as any)
    prismaMock.order.findMany.mockResolvedValue([ventaDeMercancia, cuentaMixta] as any)

    const detalle = await getShiftById('venue-1', 'shift-1')

    expect(contarOrdenesCobradas(pagos)).toBe(1)
    expect(detalle.totalOrders).toBe(contarOrdenesCobradas(pagos))
    expect(detalle.orders.map((o: { id: string }) => o.id)).toEqual(['orden-playera'])
  })
})
