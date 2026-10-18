/**
 * 🔴 R14-1 (ronda 14 post-QA de sellos tardíos; decisión del founder del 17-oct): una cuenta con vales de mostrador NO se separa ni
 * se junta. Para pagar entre varios se registran abonos en la misma cuenta (la sesión de vales ya los soporta).
 *
 * Por qué: dividir o fusionar movía renglones de vale fuera de la sesión, del vale y de la reserva que los poseen (Codex r18 #1/#2 y
 * la re-revisión r13 (E): descuento doble en una carrera TPV/POS, producto cobrado sin descontar al cancelar el origen, vale marcado
 * entregado con su renglón sin cobrar, sesión huérfana). El guarda vive en los TRES escritores de `OrderItem.orderId`
 * (`splitOrderItemsInTransaction`, `splitOrderBySeatInTransaction`, `mergeOrdersInTransaction`), por donde pasan las rutas `/mobile` y
 * `/tpv`, la cola sin red (SPLIT_ORDER, SPLIT_BY_SEAT, MERGE_ORDERS) y las tools del MCP.
 *
 * La venta de vales de las pruebas: un vale de queso de $60 (su renglón trae `areaTicketLineId`) + un pan suelto de $40.
 */
import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { mergeOrdersInTransaction, splitOrderBySeat, splitOrderItems } from '@/services/mobile/order.mobile.service'

const MENSAJE =
  'Esta cuenta tiene vales de mostrador: no se puede separar ni juntar. Para pagar entre varios, registra abonos en la misma cuenta.'
const RECHAZO = { statusCode: 400, code: 'AREA_TICKET_ORDER_NOT_SPLITTABLE', message: MENSAJE }

const SESION = { id: 'sesion-vales' }
const QUESO = { id: 'renglon-queso', orderPromotionId: null, seat: 1, areaTicketLineId: 'linea-vale-queso' }
const PAN = { id: 'renglon-pan', orderPromotionId: null, seat: 2, areaTicketLineId: null }

/** La cuenta que leen los dos separar (bajo el candado de la orden). */
function cuenta(o: { sesion?: typeof SESION | null; items: Array<Record<string, unknown>> }) {
  return {
    id: 'order-1',
    orderNumber: 'ORD-1',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    tableId: null,
    covers: 1,
    servedById: 'staff-1',
    type: 'TAKEOUT',
    paidAmount: new Decimal(0),
    shiftId: null,
    contratoDePrecio: 'IVA_INCLUIDO',
    originSystem: null,
    areaTicketCheckoutSession: o.sesion ?? null,
    items: o.items,
    orderDiscounts: [],
    serviceCharges: [],
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.$queryRaw.mockImplementation(async (query: { sql?: string } | string[], ...values: unknown[]) => {
    const sql = Array.isArray(query) ? query.join('?') : (query.sql ?? '')
    if (sql.includes('FROM "Venue"') && sql.includes('FOR KEY SHARE')) return [{ id: 'venue-1' }]
    if (sql.includes('FROM "Order"') && sql.includes('FOR UPDATE') && Array.isArray(values[1])) return values[1].map(id => ({ id }))
    if (sql.includes('FROM "Table"') && sql.includes('FOR NO KEY UPDATE')) return [{ id: 't1' }]
    throw new Error(`Unexpected raw statement: ${sql}`)
  })
  prismaMock.order.findMany.mockImplementation(async (args: any) =>
    [
      { id: 'order-1', tableId: null, status: 'CONFIRMED', paymentStatus: 'PENDING', createdAt: new Date(0) },
      { id: 'order-2', tableId: null, status: 'PENDING', paymentStatus: 'PENDING', createdAt: new Date(0) },
    ].filter(row => args.where.id?.in?.includes(row.id)),
  )
  prismaMock.table.findMany.mockResolvedValue([])
  prismaMock.order.create.mockResolvedValue({ id: 'order-nueva', orderNumber: 'ORD-N', version: 1 })
  prismaMock.orderItem.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.orderDiscount.findMany.mockResolvedValue([])
  prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
  prismaMock.order.findUnique.mockResolvedValue({ contratoDePrecio: 'IVA_INCLUIDO', taxAmount: new Decimal(0), status: 'CONFIRMED' })
  prismaMock.order.update.mockResolvedValue({ total: 0, version: 2 })
})

describe('🔴 R14-1 separar cuenta (`splitOrderItemsInTransaction`)', () => {
  it('🔴 separar el queso del vale ($60) ⇒ 400 AREA_TICKET_ORDER_NOT_SPLITTABLE con el aviso, sin crear cuenta ni mover renglones', async () => {
    prismaMock.order.findFirst.mockResolvedValue(cuenta({ sesion: SESION, items: [QUESO, PAN] }))

    await expect(splitOrderItems('venue-1', 'order-1', [QUESO.id], 'staff-1')).rejects.toMatchObject(RECHAZO)

    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 separar sólo el pan suelto ($40) de la venta de vales ⇒ el mismo aviso (la cuenta con vales no se separa)', async () => {
    prismaMock.order.findFirst.mockResolvedValue(cuenta({ sesion: SESION, items: [QUESO, PAN] }))

    await expect(splitOrderItems('venue-1', 'order-1', [PAN.id], 'staff-1')).rejects.toMatchObject(RECHAZO)

    expect(prismaMock.orderItem.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 dato viejo (dividida antes del despliegue): la cuenta B trae el renglón del vale sin la sesión ⇒ tampoco se separa', async () => {
    prismaMock.order.findFirst.mockResolvedValue(cuenta({ sesion: null, items: [QUESO, PAN] }))

    await expect(splitOrderItems('venue-1', 'order-1', [PAN.id], 'staff-1')).rejects.toMatchObject(RECHAZO)

    expect(prismaMock.orderItem.updateMany).not.toHaveBeenCalled()
  })

  it('regresión: una cuenta SIN vales se separa como siempre', async () => {
    prismaMock.order.findFirst.mockResolvedValue(cuenta({ items: [{ ...QUESO, areaTicketLineId: null }, { ...PAN }] }))

    await splitOrderItems('venue-1', 'order-1', [PAN.id], 'staff-1')

    expect(prismaMock.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [PAN.id] }, orderId: 'order-1' },
      data: { orderId: 'order-nueva' },
    })
  })
})

describe('🔴 R14-1 dividir por puesto (`splitOrderBySeatInTransaction`)', () => {
  it('🔴 venta de vales con dos asientos ⇒ el aviso, sin crear cheques', async () => {
    prismaMock.order.findFirst.mockResolvedValue(cuenta({ sesion: SESION, items: [QUESO, PAN] }))

    await expect(splitOrderBySeat('venue-1', 'order-1', 'staff-1')).rejects.toMatchObject(RECHAZO)

    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.orderItem.updateMany).not.toHaveBeenCalled()
  })

  it('regresión: sin vales, un cheque por asiento como siempre', async () => {
    prismaMock.order.findFirst.mockResolvedValue(cuenta({ items: [{ ...QUESO, areaTicketLineId: null }, { ...PAN }] }))

    await splitOrderBySeat('venue-1', 'order-1', 'staff-1')

    expect(prismaMock.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [PAN.id] }, orderId: 'order-1' },
      data: { orderId: 'order-nueva' },
    })
  })
})

describe('🔴 R14-1 juntar cuentas (`mergeOrdersInTransaction`)', () => {
  /** Destino `order-1` y origen `order-2`, ambos abiertos; cada uno con o sin vales. */
  function lasDos(o: {
    destino?: { sesion?: typeof SESION | null; vale?: boolean }
    origen?: { sesion?: typeof SESION | null; vale?: boolean }
  }) {
    const vales = (lado?: { sesion?: typeof SESION | null; vale?: boolean }) => ({
      areaTicketCheckoutSession: lado?.sesion ?? null,
      items: lado?.vale ? [{ areaTicketLineId: QUESO.areaTicketLineId }] : [],
    })
    const comun = {
      status: 'PENDING',
      paymentStatus: 'PENDING',
      paidAmount: new Decimal(0),
      tableId: null,
      customerName: null,
      specialRequests: null,
      contratoDePrecio: 'IVA_INCLUIDO',
      originSystem: null,
      taxAmount: new Decimal(0),
      _count: { items: 1 },
      orderDiscounts: [],
      serviceCharges: [],
    }
    prismaMock.order.findFirst.mockImplementation(async ({ where }: any) => {
      if (where.id === 'order-1') return { ...comun, id: 'order-1', orderNumber: 'ORD-1', ...vales(o.destino) }
      if (where.id === 'order-2') return { ...comun, id: 'order-2', orderNumber: 'ORD-2', ...vales(o.origen) }
      return null
    })
  }
  const juntar = () => mergeOrdersInTransaction(prismaMock, 'venue-1', 'order-1', 'order-2', 'staff-1')

  it('🔴 la venta de vales (origen) dentro de otra cuenta ⇒ el aviso, sin mover renglones (antes: su sesión quedaba huérfana)', async () => {
    lasDos({ origen: { sesion: SESION, vale: true } })

    await expect(juntar()).rejects.toMatchObject(RECHAZO)

    expect(prismaMock.orderItem.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 una cuenta normal dentro de la venta de vales (destino) ⇒ también el aviso: la cuenta con vales no se junta', async () => {
    lasDos({ destino: { sesion: SESION, vale: true } })

    await expect(juntar()).rejects.toMatchObject(RECHAZO)

    expect(prismaMock.orderItem.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 dato viejo: el origen trae el renglón del vale sin la sesión ⇒ el aviso', async () => {
    lasDos({ origen: { sesion: null, vale: true } })

    await expect(juntar()).rejects.toMatchObject(RECHAZO)

    expect(prismaMock.orderItem.updateMany).not.toHaveBeenCalled()
  })

  it('regresión: dos cuentas SIN vales llegan a mover los renglones como siempre', async () => {
    lasDos({})
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue(null)
    // El resto de la fusión ya lo cubren `order.mobile.service.mergeOrders.test.ts` y `mobileMoney.atomic.test.ts`: aquí basta con
    // saber que el guarda no la detuvo.
    prismaMock.orderItem.updateMany.mockRejectedValueOnce(new Error('LLEGÓ A MOVER'))

    await expect(juntar()).rejects.toThrow('LLEGÓ A MOVER')

    expect(prismaMock.orderItem.updateMany).toHaveBeenCalledWith({ where: { orderId: 'order-2' }, data: { orderId: 'order-1' } })
  })
})
