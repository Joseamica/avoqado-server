/**
 * 🔴 Ronda 2 post-QA de sellos tardíos (cierra el riesgo 1 de la ronda 1): quitar al PRIMARIO de una venta COBRADA promovía al
 * siguiente cliente. COCINA (sin `payments:create`) podía quitar al primario de una venta pagada con la lealtad pendiente y
 * volver beneficiario a su acompañante. Ahora, en una venta cobrada (pagada o reembolsada, con la lealtad pendiente o ya
 * procesada), la promoción sólo ocurre si quien quita tiene `payments:create` (el controller lo resuelve con el resolvedor
 * efectivo, falla cerrado). Sin él no se promueve a nadie: los demás quedan acompañantes. Una cuenta abierta promueve como
 * siempre. La decisión se toma bajo el candado canónico de la venta (el del cobro).
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
  prismaMock.order.findFirst.mockImplementation((async () => ({ paymentStatus: estado })) as never)
  prismaMock.orderCustomer.findUnique.mockReset()
  prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', orderId: ORDER, customerId: 'cust-P', isPrimary: true } as any)
  prismaMock.orderCustomer.delete.mockResolvedValue({ id: 'oc-1' } as any)
  prismaMock.orderCustomer.findFirst.mockReset()
  prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-2', orderId: ORDER, customerId: 'cust-C', isPrimary: false } as any)
  prismaMock.orderCustomer.update.mockResolvedValue({ id: 'oc-2' } as any)
  prismaMock.orderCustomer.findMany.mockResolvedValue(LISTA as any)
})

describe('TPV removeCustomerFromOrder — la promoción del siguiente en una venta COBRADA exige payments:create', () => {
  it.each(['PAID', 'REFUNDED'])(
    '🔴 venta %s y SIN permiso: se quita al primario y NO se promueve a nadie (el resto queda acompañante)',
    async paymentStatus => {
      estado = paymentStatus
      const r = await removeCustomerFromOrder(VENUE, ORDER, 'cust-P', { otorgarLealtad: false })
      expect(prismaMock.orderCustomer.delete).toHaveBeenCalledWith({
        where: { orderId_customerId: { orderId: ORDER, customerId: 'cust-P' } },
      })
      expect(prismaMock.orderCustomer.update).not.toHaveBeenCalled()
      expect(r).toEqual(LISTA)
    },
  )

  it('🔴 sin decir el permiso (llamador interno) falla CERRADO: en una venta cobrada no promueve', async () => {
    await removeCustomerFromOrder(VENUE, ORDER, 'cust-P')
    expect(prismaMock.orderCustomer.delete).toHaveBeenCalled()
    expect(prismaMock.orderCustomer.update).not.toHaveBeenCalled()
  })

  it('🔴 venta cobrada y CON permiso: promueve al siguiente más antiguo, como siempre', async () => {
    await removeCustomerFromOrder(VENUE, ORDER, 'cust-P', { otorgarLealtad: true })
    expect(prismaMock.orderCustomer.findFirst).toHaveBeenCalledWith({ where: { orderId: ORDER }, orderBy: { addedAt: 'asc' } })
    expect(prismaMock.orderCustomer.update).toHaveBeenCalledWith({ where: { id: 'oc-2' }, data: { isPrimary: true } })
  })

  it.each(['PENDING', 'PARTIAL'])('regresión: cuenta %s (sin cobrar) y sin permiso: promueve como siempre', async paymentStatus => {
    estado = paymentStatus
    await removeCustomerFromOrder(VENUE, ORDER, 'cust-P', { otorgarLealtad: false })
    expect(prismaMock.orderCustomer.update).toHaveBeenCalledWith({ where: { id: 'oc-2' }, data: { isPrimary: true } })
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
    await removeCustomerFromOrder(VENUE, ORDER, 'cust-P', { otorgarLealtad: false })
    expect(candadosDentro).toEqual([true])
    const [sql] = prismaMock.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray]
    expect(sql.join('?')).toMatch(/FROM "Order"[\s\S]*FOR NO KEY UPDATE/)
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.order.findFirst.mock.invocationCallOrder[0])
    expect(prismaMock.order.findFirst.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.orderCustomer.delete.mock.invocationCallOrder[0])
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000, maxWait: 5_000 })
  })

  it('la venta ya no es de este negocio bajo el candado ⇒ 404, sin borrar nada', async () => {
    prismaMock.$queryRaw.mockResolvedValue([] as never)
    await expect(removeCustomerFromOrder(VENUE, ORDER, 'cust-P', { otorgarLealtad: true })).rejects.toThrow('Order not found')
    expect(prismaMock.orderCustomer.delete).not.toHaveBeenCalled()
  })
})
