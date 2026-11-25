/**
 * D34: el detalle de un pago del panel ofrecía «Eliminar de la transacción» en una venta ya cobrada y el PUT contestaba 409. Ahora el
 * SERVIDOR dice en la respuesta del pago si se puede quitar el cliente (`customerUnlink`), y el panel sólo ofrece el botón cuando sí.
 *
 * Lo que se prueba: para cada caso, la LECTURA (`sePuedeQuitarElCliente`) y el PUT con `customerId: null` (`updateOrder`) dicen lo
 * mismo, sobre el mismo mock. La regla no cambia: una venta cobrada conserva su cliente, también para un gerente.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { sePuedeQuitarElCliente } from '@/services/shared/ligaDeClienteEnVenta'
import { updateOrder } from '@/services/dashboard/order.dashboard.service'
import { getPaymentById } from '@/services/dashboard/payment.dashboard.service'

const VENUE = 'venue-1'
const ORDER = 'order-1'
const dec = (n: number) => new Prisma.Decimal(n)

type Caso = {
  status: string
  paymentStatus: string
  customerId: string | null
  primario?: string | null
  /** Lo cobrado (COMPLETED, sin reembolsos). */
  cobrado: number
  existe?: boolean
}

function preparar(c: Caso) {
  const venta = {
    id: ORDER,
    venueId: VENUE,
    status: c.status,
    paymentStatus: c.paymentStatus,
    customerId: c.customerId,
    customerName: null,
    tableId: null,
    servedById: null,
    createdAt: new Date('2026-11-01T18:00:00Z'),
    orderNumber: 'ORD-1',
    type: 'DINE_IN',
    subtotal: dec(100),
    discountAmount: dec(0),
    serviceChargeAmount: dec(0),
    contratoDePrecio: 'IVA_INCLUIDO',
    taxAmount: dec(0),
    items: [],
  }
  for (const m of [
    prismaMock.$queryRaw,
    prismaMock.order.findFirst,
    prismaMock.order.update,
    prismaMock.order.count,
    prismaMock.orderCustomer.findFirst,
    prismaMock.payment.aggregate,
    prismaMock.payment.findFirst,
  ] as jest.Mock[])
    m.mockReset()
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.$queryRaw.mockImplementation((async () => (c.existe === false ? [] : [{ id: ORDER }])) as never)
  prismaMock.order.findFirst.mockImplementation((async () => (c.existe === false ? null : venta)) as never)
  prismaMock.order.count.mockImplementation((async () => (['CANCELLED', 'DELETED'].includes(c.status) ? 1 : 0)) as never)
  prismaMock.order.update.mockImplementation((async (args: any) => ({ ...venta, ...args.data })) as never)
  prismaMock.orderCustomer.findFirst.mockResolvedValue((c.primario ? { customerId: c.primario } : null) as any)
  prismaMock.payment.aggregate.mockImplementation((async (args: any) =>
    args?.where?.type === 'REFUND'
      ? { _sum: { reopenedAmount: null, reopenedTipAmount: null } }
      : { _sum: { amount: dec(c.cobrado), tipAmount: dec(0) }, _count: c.cobrado > 0 ? 1 : 0 }) as never)
}

/** Lo que hace el PUT del panel con «Eliminar de la transacción»: un gerente con autoridad, para que sólo cuente el estado. */
async function quitarPorElPut(): Promise<{ ok: true } | { ok: false; statusCode: number; code?: string }> {
  try {
    await updateOrder(VENUE, ORDER, { customerId: null } as any, {
      puedeCambiarClienteEnVentaCobrada: true,
      customerAttribution: { staffId: 'manager', canAssignHistorical: true, canAttachAtReceipt: true },
    })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, statusCode: e.statusCode, code: e.code }
  }
}

describe('D34 · sePuedeQuitarElCliente dice lo mismo que el PUT `customerId: null`', () => {
  it.each<[string, Caso, true | string]>([
    ['cuenta abierta sin cobros', { status: 'PENDING', paymentStatus: 'PENDING', customerId: 'cust-A', cobrado: 0 }, true],
    ['abono que no cubre', { status: 'PENDING', paymentStatus: 'PARTIAL', customerId: 'cust-A', cobrado: 40 }, true],
    [
      'venta PAID con cliente',
      { status: 'COMPLETED', paymentStatus: 'PAID', customerId: 'cust-A', cobrado: 100 },
      'SALE_CUSTOMER_ALREADY_ASSIGNED',
    ],
    [
      'venta REFUNDED con cliente',
      { status: 'COMPLETED', paymentStatus: 'REFUNDED', customerId: 'cust-A', cobrado: 100 },
      'SALE_CUSTOMER_ALREADY_ASSIGNED',
    ],
    [
      'cobros que ya cubren con el estado atrasado',
      { status: 'PENDING', paymentStatus: 'PENDING', customerId: 'cust-A', cobrado: 100 },
      'SALE_CUSTOMER_ALREADY_ASSIGNED',
    ],
    [
      'PAID con sólo el primario (cabecera vacía)',
      { status: 'COMPLETED', paymentStatus: 'PAID', customerId: null, primario: 'cust-A', cobrado: 100 },
      'SALE_CUSTOMER_ALREADY_ASSIGNED',
    ],
    ['PAID sin cliente (no hay nada que quitar)', { status: 'COMPLETED', paymentStatus: 'PAID', customerId: null, cobrado: 100 }, true],
    [
      'cancelada con cliente',
      { status: 'CANCELLED', paymentStatus: 'PENDING', customerId: 'cust-A', cobrado: 0 },
      'ORDER_CANCELLED_NO_EDIT',
    ],
    ['cancelada y cobrada', { status: 'CANCELLED', paymentStatus: 'PAID', customerId: 'cust-A', cobrado: 100 }, 'ORDER_CANCELLED_NO_EDIT'],
  ])('%s', async (_n, caso, esperado) => {
    preparar(caso)
    const campo = await sePuedeQuitarElCliente(prismaMock as any, { venueId: VENUE, orderId: ORDER })
    preparar(caso)
    const put = await quitarPorElPut()

    if (esperado === true) {
      expect(campo).toEqual({ allowed: true })
      expect(put).toEqual({ ok: true })
    } else {
      expect(campo).toEqual({ allowed: false, code: esperado, reason: expect.any(String) })
      expect(put).toMatchObject({ ok: false, code: esperado })
      expect(campo?.allowed === false && campo.reason.length).toBeGreaterThan(10)
    }
  })

  it('venta de otra sucursal o inexistente: no decide (null) y el PUT da 404', async () => {
    const caso: Caso = { status: 'COMPLETED', paymentStatus: 'PAID', customerId: 'cust-A', cobrado: 100, existe: false }
    preparar(caso)
    expect(await sePuedeQuitarElCliente(prismaMock as any, { venueId: VENUE, orderId: ORDER })).toBeNull()
    preparar(caso)
    expect(await quitarPorElPut()).toMatchObject({ ok: false, statusCode: 404 })
  })

  it('la venta se lee acotada al negocio', async () => {
    preparar({ status: 'COMPLETED', paymentStatus: 'PAID', customerId: 'cust-A', cobrado: 100 })
    await sePuedeQuitarElCliente(prismaMock as any, { venueId: VENUE, orderId: ORDER })
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ORDER, venueId: VENUE } }))
  })
})

describe('D34 · el detalle del pago trae `customerUnlink`', () => {
  const pago = (over: Record<string, unknown>) => ({
    id: 'pay-1',
    venueId: VENUE,
    amount: dec(100),
    tipAmount: dec(0),
    method: 'CASH',
    status: 'COMPLETED',
    tenderType: null,
    createdAt: new Date('2026-11-01T18:00:00Z'),
    ...over,
  })
  /** `leerCobradoDeLaOrden` (lo que cobró cada renglón) no decide nada aquí: sin renglones ni descuentos. */
  const sinCobradoPorRenglon = () => {
    prismaMock.order.findUnique.mockResolvedValue(null as any)
    prismaMock.orderItem.findMany.mockResolvedValue([] as any)
    prismaMock.$queryRaw.mockResolvedValue([] as never)
  }

  it('con venta cobrada y cliente: no se puede quitar, con su código', async () => {
    preparar({ status: 'COMPLETED', paymentStatus: 'PAID', customerId: 'cust-A', cobrado: 100 })
    prismaMock.payment.findFirst.mockResolvedValueOnce(pago({ orderId: ORDER, order: { id: ORDER, items: [] } }) as any)
    sinCobradoPorRenglon()
    const r: any = await getPaymentById(VENUE, 'pay-1')
    expect(r.customerUnlink).toEqual({ allowed: false, code: 'SALE_CUSTOMER_ALREADY_ASSIGNED', reason: expect.any(String) })
  })

  it('con cuenta abierta: se puede quitar', async () => {
    preparar({ status: 'PENDING', paymentStatus: 'PARTIAL', customerId: 'cust-A', cobrado: 40 })
    prismaMock.payment.findFirst.mockResolvedValueOnce(pago({ orderId: ORDER, order: { id: ORDER, items: [] } }) as any)
    sinCobradoPorRenglon()
    const r: any = await getPaymentById(VENUE, 'pay-1')
    expect(r.customerUnlink).toEqual({ allowed: true })
  })

  it('🔴 si la lectura del campo falla, el detalle del pago responde igual, sin el campo (el panel no ofrece el botón)', async () => {
    preparar({ status: 'COMPLETED', paymentStatus: 'PAID', customerId: 'cust-A', cobrado: 100 })
    prismaMock.payment.findFirst.mockResolvedValueOnce(pago({ orderId: ORDER, order: { id: ORDER, items: [] } }) as any)
    sinCobradoPorRenglon()
    prismaMock.order.findFirst.mockRejectedValue(new Error('P1001 la base no contestó'))
    const r: any = await getPaymentById(VENUE, 'pay-1')
    expect(r).toMatchObject({ id: 'pay-1', order: { id: ORDER } })
    expect(r).not.toHaveProperty('customerUnlink')
  })

  it('regresión: un pago sin venta no trae el campo y responde como antes', async () => {
    prismaMock.payment.findFirst.mockResolvedValueOnce(pago({ orderId: null, order: null }) as any)
    const r: any = await getPaymentById(VENUE, 'pay-1')
    expect(r).not.toHaveProperty('customerUnlink')
    expect(r).toMatchObject({ id: 'pay-1', tenderSystemKind: null })
  })
})
