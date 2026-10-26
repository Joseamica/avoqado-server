/**
 * Postventa: el primario de una venta cobrada es inmutable, incluso para gerente.
 * Quitar acompañantes y promover al siguiente en una cuenta abierta sigue permitido.
 * El rechazo debe ocurrir bajo candado y antes de borrar o promover asociaciones.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { removeCustomerFromOrder } from '@/services/tpv/order.tpv.service'

const VENUE = 'venue-1'
const ORDER = 'order-1'
const LISTA = [{ id: 'oc-2', orderId: ORDER, customerId: 'cust-C', isPrimary: false, customer: { id: 'cust-C' } }]

let enTransaccion = false
let candadosDentro: boolean[] = []
let estado = 'PAID'

beforeEach(() => {
  candadosDentro = []
  estado = 'PAID'
  prismaMock.$transaction.mockImplementation(async (cb: any) => {
    enTransaccion = true
    try {
      return await cb(prismaMock)
    } finally {
      enTransaccion = false
    }
  })
  prismaMock.order.findUnique.mockResolvedValue({ id: ORDER, orderNumber: 'ORD-1' } as any)
  prismaMock.$queryRaw.mockReset()
  prismaMock.$queryRaw.mockImplementation((async () => {
    candadosDentro.push(enTransaccion)
    return [{ id: ORDER }]
  }) as never)
  prismaMock.order.findFirst.mockReset()
  prismaMock.order.findFirst.mockImplementation((async () => ({ paymentStatus: estado, customerId: 'cust-P' })) as never)
  // R7-2: los reembolsos ya no deciden «cobrada»; el conteo no debe preguntarse (las pruebas lo vigilan).
  prismaMock.payment.count.mockReset()
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.orderCustomer.findUnique.mockReset()
  prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', orderId: ORDER, customerId: 'cust-P', isPrimary: true } as any)
  prismaMock.orderCustomer.delete.mockResolvedValue({ id: 'oc-1' } as any)
  prismaMock.orderCustomer.findFirst.mockReset()
  prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-2', orderId: ORDER, customerId: 'cust-C', isPrimary: false } as any)
  prismaMock.orderCustomer.update.mockResolvedValue({ id: 'oc-2' } as any)
  prismaMock.orderCustomer.findMany.mockResolvedValue(LISTA as any)
})

describe('TPV removeCustomerFromOrder — primario cobrado inmutable', () => {
  it.each(['PAID', 'REFUNDED'])('venta %s: no quita ni promueve el primario, aun con autoridad de gerente', async paymentStatus => {
    estado = paymentStatus
    await expect(
      removeCustomerFromOrder(VENUE, ORDER, 'cust-P', {
        otorgarLealtad: true,
        customerAttribution: { staffId: 'manager', canAssignHistorical: true },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SALE_CUSTOMER_ALREADY_ASSIGNED' })
    expect(prismaMock.orderCustomer.delete).not.toHaveBeenCalled()
    expect(prismaMock.orderCustomer.update).not.toHaveBeenCalled()
  })

  it.each([undefined, { otorgarLealtad: false }, { otorgarLealtad: true }])(
    'sin autoridad nueva o con booleano legado %j tampoco borra el primario cobrado',
    async opciones => {
      await expect(removeCustomerFromOrder(VENUE, ORDER, 'cust-P', opciones)).rejects.toMatchObject({
        statusCode: 409,
        code: 'SALE_CUSTOMER_ALREADY_ASSIGNED',
      })
      expect(prismaMock.orderCustomer.delete).not.toHaveBeenCalled()
      expect(prismaMock.orderCustomer.update).not.toHaveBeenCalled()
    },
  )

  it.each(['PENDING', 'PARTIAL'])('regresión: cuenta %s (sin cobrar) y sin permiso: promueve como siempre', async paymentStatus => {
    estado = paymentStatus
    await removeCustomerFromOrder(VENUE, ORDER, 'cust-P', { otorgarLealtad: false })
    expect(prismaMock.orderCustomer.update).toHaveBeenCalledWith({ where: { id: 'oc-2' }, data: { isPrimary: true } })
  })

  // 🔴 R7-2 (ronda 7; Codex recheck-11 P2): una cuenta con un abono devuelto NUNCA se saldó: promueve como antes de la ronda 6.
  it.each(['PARTIAL', 'PENDING'])('🔴 R7-2: cuenta %s con un abono devuelto, sin permiso: promueve como siempre', async paymentStatus => {
    estado = paymentStatus
    prismaMock.payment.count.mockResolvedValue(1)
    await removeCustomerFromOrder(VENUE, ORDER, 'cust-P', { otorgarLealtad: false })
    expect(prismaMock.orderCustomer.update).toHaveBeenCalledWith({ where: { id: 'oc-2' }, data: { isPrimary: true } })
    expect(prismaMock.payment.count).not.toHaveBeenCalled()
  })

  it('regresión: quitar a un acompañante no promueve a nadie', async () => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-2', orderId: ORDER, customerId: 'cust-C', isPrimary: false } as any)
    await removeCustomerFromOrder(VENUE, ORDER, 'cust-C', { otorgarLealtad: true })
    expect(prismaMock.orderCustomer.delete).toHaveBeenCalled()
    expect(prismaMock.orderCustomer.update).not.toHaveBeenCalled()
  })

  it('regresión: el cliente no estaba en la venta ⇒ 404, sin borrar nada', async () => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue(null)
    await expect(removeCustomerFromOrder(VENUE, ORDER, 'cust-X', { otorgarLealtad: true })).rejects.toThrow(
      'Customer not associated with this order',
    )
    expect(prismaMock.orderCustomer.delete).not.toHaveBeenCalled()
  })

  it('🔴 la decisión se toma bajo el candado canónico de la venta: PRIMERA sentencia de la transacción, con su presupuesto', async () => {
    await expect(removeCustomerFromOrder(VENUE, ORDER, 'cust-P', { otorgarLealtad: false })).rejects.toMatchObject({ statusCode: 409 })
    expect(candadosDentro).toEqual([true])
    const [sql] = prismaMock.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray]
    expect(sql.join('?')).toMatch(/FROM "Order"[\s\S]*FOR NO KEY UPDATE/)
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.order.findFirst.mock.invocationCallOrder[0])
    expect(prismaMock.order.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.orderCustomer.findUnique.mock.invocationCallOrder[0],
    )
    expect(prismaMock.orderCustomer.delete).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000, maxWait: 5_000 })
  })

  it('la venta ya no es de este negocio bajo el candado ⇒ 404, sin borrar nada', async () => {
    prismaMock.$queryRaw.mockResolvedValue([] as never)
    await expect(removeCustomerFromOrder(VENUE, ORDER, 'cust-P', { otorgarLealtad: true })).rejects.toThrow('Order not found')
    expect(prismaMock.orderCustomer.delete).not.toHaveBeenCalled()
  })
})
