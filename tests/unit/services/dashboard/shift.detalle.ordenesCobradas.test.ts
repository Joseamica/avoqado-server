import { prismaMock } from '@tests/__helpers__/setup'
import { getShiftById } from '@/services/dashboard/shift.dashboard.service'
import { contarOrdenesCobradas } from '@/services/tpv/shift.tpv.service'

/**
 * El detalle del turno cuenta las MISMAS órdenes que firma el cierre y enseña la lista: las cuentas COBRADAS en el turno
 * (decisión del founder, 18-oct, como Square «order count» y Toast «number of checks»). Antes las sacaba de
 * `Order.shiftId`, y no cuadraba en 30 de 511 turnos cerrados (19-oct):
 *  - 630 órdenes cobradas de 2025-12 a 2026-09 llegaron sin `shiftId` (Testarudo, 4-may: 360 cobradas, detalle 0);
 *  - una orden CONFIRMED sin cobro contaba en el detalle y no en la lista.
 * La equivalencia con la lista se midió en producción (0 de 511 con esta regla); aquí se fija la regla misma.
 */

const orden = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: id.toUpperCase(),
  total: 100,
  subtotal: 100,
  status: 'COMPLETED',
  table: null,
  createdAt: new Date('2026-10-18T15:00:00Z'),
  servedById: 'staff-1',
  servedBy: { id: 'staff-1', firstName: 'Ana', lastName: 'López' },
  items: [{ id: `${id}-i1`, productName: 'Café', quantity: 1, unitPrice: 100, discountAmount: 0, modifiers: [], product: null }],
  payments: [] as any[],
  ...over,
})

/** Las órdenes que «existen» en la base: `order.findMany` regresa las que le piden por id. */
const base = new Map<string, ReturnType<typeof orden>>()

const cobro = (id: string, order: ReturnType<typeof orden>, over: Record<string, unknown> = {}) => {
  base.set(order.id, order)
  return {
    id,
    amount: 100,
    tipAmount: 0,
    method: 'CASH',
    type: 'REGULAR',
    tenderLabel: null,
    externalSource: null,
    cardBrand: null,
    maskedPan: null,
    processorData: null,
    processedById: 'staff-1',
    processedBy: { id: 'staff-1', firstName: 'Ana', lastName: 'López' },
    orderId: order.id,
    createdAt: new Date('2026-10-18T16:00:00Z'),
    ...over,
  }
}

/** Un cobro SIN turno, como lo trae la orden (lo que deja la sincronización de SoftRestaurant). */
const sinTurno = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  method: 'CASH',
  cardBrand: null,
  maskedPan: null,
  shiftId: null,
  type: 'REGULAR',
  createdAt: new Date('2026-10-18T16:00:00Z'),
  ...over,
})

const turno = (payments: any[], orders: any[] = []) => ({
  id: 'shift-1',
  venueId: 'venue-1',
  staffId: 'staff-1',
  startTime: new Date('2026-10-18T14:00:00Z'),
  endTime: new Date('2026-10-18T22:00:00Z') as Date | null,
  updatedAt: new Date('2026-10-18T22:00:00Z'),
  startingCash: 0,
  endingCash: 0,
  totalSales: 0,
  totalTips: 0,
  totalOrders: 0,
  status: 'CLOSED',
  staff: { id: 'staff-1', firstName: 'Ana', lastName: 'López', email: 'ana@example.test' },
  venue: { id: 'venue-1', name: 'Venue', timezone: 'America/Mexico_City' },
  payments,
  // Lo que regresa la include `orders`: las órdenes del turno con algún cobro sin turno.
  orders,
})

beforeEach(() => {
  jest.clearAllMocks()
  base.clear()
  prismaMock.order.findMany.mockImplementation((async (args: any) =>
    (args.where.id.in as string[]).map(id => base.get(id)).filter(Boolean)) as any)
})

describe('detalle del turno · órdenes = cuentas cobradas en el turno', () => {
  it('🔴 cuenta la orden cobrada en el turno aunque la orden no traiga `shiftId` (turnos viejos en 0)', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(turno([cobro('p1', orden('a'))]) as any)

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.totalOrders).toBe(1)
    expect(r.stats.totalOrders).toBe(1)
    expect(r.orders.map((o: any) => o.id)).toEqual(['a'])
    expect(r.topProducts).toEqual([{ name: 'Café', quantity: 1, revenue: 100 }])
    expect(r.staffBreakdown[0].ordersCount).toBe(1)
  })

  it('🔴 NO cuenta una orden CONFIRMED sin cobro, aunque esté ligada al turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(turno([], [orden('sin-cobro', { status: 'CONFIRMED' })]) as any)

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.totalOrders).toBe(0)
    expect(r.orders).toEqual([])
    expect(r.topProducts).toEqual([])
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })

  it('una cuenta pagada en abonos es UNA orden, y se pide UNA vez a la base (sin copias por cobro)', async () => {
    const a = orden('a')
    prismaMock.shift.findFirst.mockResolvedValue(
      turno([cobro('p1', a, { amount: 30 }), cobro('p2', a, { amount: 30 }), cobro('p3', a, { amount: 40 })]) as any,
    )

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.totalOrders).toBe(1)
    expect(r.topProducts[0].quantity).toBe(1)
    expect(r.stats.totalPayments).toBe(3)
    expect(prismaMock.order.findMany).toHaveBeenCalledTimes(1)
    const args = prismaMock.order.findMany.mock.calls[0][0] as any
    expect(args.where).toEqual({ venueId: 'venue-1', id: { in: ['a'] } })
    expect(args.take).toBe(1)
  })

  it('una devolución sola no hace orden; la venta con su devolución sigue siendo una', async () => {
    const vendida = orden('vendida')
    prismaMock.shift.findFirst.mockResolvedValue(
      turno([
        cobro('p1', vendida),
        cobro('r1', vendida, { type: 'REFUND', amount: -100 }),
        cobro('r2', orden('solo-devuelta'), { type: 'REFUND', amount: -50 }),
      ]) as any,
    )

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.orders.map((o: any) => o.id)).toEqual(['vendida'])
    expect(r.totalOrders).toBe(1)
  })

  it('cuadra con `contarOrdenesCobradas` sobre los cobros del turno y ordena de la más nueva a la más vieja', async () => {
    const vieja = orden('vieja', { createdAt: new Date('2026-10-18T14:30:00Z') })
    const nueva = orden('nueva', { createdAt: new Date('2026-10-18T20:00:00Z') })
    const pagos = [cobro('p1', vieja), cobro('p2', nueva), cobro('p3', vieja), cobro('r1', nueva, { type: 'REFUND', amount: -10 })]
    prismaMock.shift.findFirst.mockResolvedValue(turno(pagos) as any)

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.totalOrders).toBe(contarOrdenesCobradas(pagos))
    expect(r.orders.map((o: any) => o.id)).toEqual(['nueva', 'vieja'])
    expect(r.stats.avgOrderValue).toBe(Number((r.totalSales / 2).toFixed(2)))
  })

  it('la consulta del turno ya no anida la orden en cada cobro; `orders` trae sólo las de cobro sin turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(turno([]) as any)

    await getShiftById('venue-1', 'shift-1')

    const args = prismaMock.shift.findFirst.mock.calls[0][0] as any
    expect(args.include.payments.select.type).toBe(true)
    expect(args.include.payments.select.order).toBeUndefined()
    expect(args.include.orders.where).toEqual({ payments: { some: { status: 'COMPLETED', shiftId: null } } })
    expect(args.include.orders.select.items).toBeDefined()
  })
})

/**
 * Testarudo sincroniza sus turnos de SoftRestaurant: la ORDEN trae el turno y el COBRO no (358 turnos, ago-2025 a
 * sep-2026). El cierre los cuenta así (`readShiftPaymentsForClose`): un cobro sin turno de una orden del turno, dentro
 * de su horario. Contar sólo por los cobros del turno los dejaba en 0 (medido el 19-oct).
 */
describe('detalle del turno · cobros sin turno de una orden del turno (turnos sincronizados)', () => {
  it('🔴 cuenta la orden del turno cobrada SIN turno dentro de su horario, sin volver a pedirla', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(turno([], [orden('sr-1', { payments: [sinTurno('p1')] })]) as any)

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.totalOrders).toBe(1)
    expect(r.orders.map((o: any) => o.id)).toEqual(['sr-1'])
    expect(r.topProducts[0].quantity).toBe(1)
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })

  it('NO la cuenta si ese cobro cae fuera del horario del turno (es de otro turno)', async () => {
    const despues = sinTurno('p1', { createdAt: new Date('2026-10-18T22:00:01Z') })
    const antes = sinTurno('p2', { createdAt: new Date('2026-10-18T13:59:59Z') })
    prismaMock.shift.findFirst.mockResolvedValue(turno([], [orden('sr-1', { payments: [despues, antes] })]) as any)

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.totalOrders).toBe(0)
  })

  it('NO la cuenta si su único cobro sin turno es una devolución, ni si el cobro sí trae OTRO turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(
      turno(
        [],
        [
          orden('solo-devolucion', { payments: [sinTurno('r1', { type: 'REFUND' })] }),
          orden('cobrada-en-otro-turno', { payments: [sinTurno('p2', { shiftId: 'shift-2' })] }),
        ],
      ) as any,
    )

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.totalOrders).toBe(0)
  })

  it('suma las dos vías sin duplicar la orden que aparece en las dos, y sólo pide a la base la que falta', async () => {
    const mixta = orden('mixta', { payments: [sinTurno('p-sin')] })
    prismaMock.shift.findFirst.mockResolvedValue(
      turno([cobro('p-con', mixta), cobro('p-otra', orden('tpv'))], [mixta, orden('sr', { payments: [sinTurno('p3')] })]) as any,
    )

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.orders.map((o: any) => o.id).sort()).toEqual(['mixta', 'sr', 'tpv'])
    expect(r.totalOrders).toBe(3)
    expect((prismaMock.order.findMany.mock.calls[0][0] as any).where.id).toEqual({ in: ['tpv'] })
  })

  it('🔴 reusa la orden ya leída aunque NO califique por la vía sin turno: venta con turno + devolución sin turno (Codex r2)', async () => {
    const parcial = orden('parcial', { payments: [sinTurno('r1', { type: 'REFUND' })] })
    const fuera = orden('fuera', { payments: [sinTurno('p9', { createdAt: new Date('2026-10-18T23:00:00Z') })] })
    prismaMock.shift.findFirst.mockResolvedValue(turno([cobro('p1', parcial), cobro('p2', fuera)], [parcial, fuera]) as any)

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.orders.map((o: any) => o.id).sort()).toEqual(['fuera', 'parcial'])
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
  })

  it('en un turno ABIERTO el horario llega hasta ahora', async () => {
    const abierto = turno([], [orden('sr-1', { payments: [sinTurno('p1', { createdAt: new Date(Date.now() - 60_000) })] })])
    abierto.endTime = null
    abierto.startTime = new Date(Date.now() - 3_600_000)
    abierto.status = 'OPEN'
    prismaMock.shift.findFirst.mockResolvedValue(abierto as any)

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.totalOrders).toBe(1)
  })

  it('🔴 mientras se CIERRA, corta donde el cierre (su `updatedAt`), no en ahora (Codex r1 #3)', async () => {
    const cerrando = turno(
      [],
      [
        orden('antes-del-cierre', { payments: [sinTurno('p1', { createdAt: new Date('2026-10-18T19:59:59Z') })] }),
        orden('despues-del-cierre', { payments: [sinTurno('p2', { createdAt: new Date('2026-10-18T20:00:01Z') })] }),
      ],
    )
    cerrando.status = 'CLOSING'
    cerrando.endTime = null
    cerrando.updatedAt = new Date('2026-10-18T20:00:00Z')
    prismaMock.shift.findFirst.mockResolvedValue(cerrando as any)

    const r = await getShiftById('venue-1', 'shift-1')

    expect(r.orders.map((o: any) => o.id)).toEqual(['antes-del-cierre'])
  })
})
