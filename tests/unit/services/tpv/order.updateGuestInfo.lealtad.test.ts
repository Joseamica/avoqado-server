/**
 * 🔴 R3-4 (ronda 3 post-QA de sellos tardíos; «vía vieja» de Codex recheck-7): editar los datos del invitado
 * (`PATCH /tpv/venues/:venueId/orders/:orderId/guest`, `orders:update`) puede escribir `Order.customerId`. En una venta PAGADA
 * con la lealtad pendiente y SIN primario, el reconciliador premia a ese cliente por el respaldo heredado: COCINA se saltaría la
 * decisión «A». Ahora, en una venta cobrada (PAID/REFUNDED), un actor SIN `payments:create` edita los datos del invitado pero NO
 * fija ni cambia `Order.customerId` (lo demás se guarda igual); con permiso, como hoy. Decidido bajo el candado de la venta.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { updateGuestInfo } from '@/services/tpv/order.tpv.service'

const VENUE = 'venue-1'
const ORDER = 'order-1'

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
  prismaMock.$queryRaw.mockReset()
  prismaMock.$queryRaw.mockImplementation((async () => {
    candadosDentro.push(enTransaccion)
    return [{ id: ORDER }]
  }) as never)
  prismaMock.order.findUnique.mockReset()
  prismaMock.order.findUnique.mockImplementation((async () => ({ id: ORDER, orderNumber: 'ORD-1', paymentStatus: estado })) as never)
  // R7-2: los reembolsos ya no deciden «cobrada»; el conteo no debe preguntarse (las pruebas lo vigilan).
  prismaMock.payment.count.mockReset()
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.order.update.mockReset()
  prismaMock.order.update.mockImplementation((async ({ data }: any) => ({
    id: ORDER,
    orderNumber: 'ORD-1',
    tableId: null,
    covers: data.covers ?? 2,
    customerName: data.customerName ?? null,
    items: [],
    payments: [],
    table: null,
  })) as never)
})

const datosEscritos = () => (prismaMock.order.update.mock.calls[0] as any)[0].data

describe('TPV updateGuestInfo — en una venta COBRADA, Order.customerId sólo con payments:create', () => {
  it.each(['PAID', 'REFUNDED'])(
    '🔴 venta %s y SIN permiso: guarda los datos del invitado pero NO fija Order.customerId',
    async paymentStatus => {
      estado = paymentStatus
      await updateGuestInfo(
        VENUE,
        ORDER,
        { customerName: 'Kev', customerPhone: '5512345678', customerId: 'cust-K' },
        { otorgarLealtad: false },
      )
      expect(datosEscritos()).toEqual({ customerName: 'Kev', customerPhone: '5512345678' })
    },
  )

  it('🔴 sin decir el permiso (llamador interno) falla CERRADO: en una venta cobrada no toca Order.customerId', async () => {
    await updateGuestInfo(VENUE, ORDER, { covers: 3, customerId: 'cust-K' })
    expect(datosEscritos()).toEqual({ covers: 3 })
  })

  it('venta cobrada y CON permiso: como hoy, también fija Order.customerId', async () => {
    await updateGuestInfo(VENUE, ORDER, { customerName: 'Kev', customerId: 'cust-K' }, { otorgarLealtad: true })
    expect(datosEscritos()).toEqual({ customerName: 'Kev', customerId: 'cust-K' })
  })

  it.each(['PENDING', 'PARTIAL'])(
    'regresión: cuenta %s (sin cobrar) y sin permiso: como hoy, fija Order.customerId',
    async paymentStatus => {
      estado = paymentStatus
      await updateGuestInfo(VENUE, ORDER, { customerId: 'cust-K' }, { otorgarLealtad: false })
      expect(datosEscritos()).toEqual({ customerId: 'cust-K' })
    },
  )

  // 🔴 R7-2 (ronda 7; Codex recheck-11 P2): una cuenta con un abono devuelto NUNCA se saldó: fija el cliente como antes de la ronda 6.
  it.each(['PARTIAL', 'PENDING'])(
    '🔴 R7-2: cuenta %s con un abono devuelto, sin permiso: como hoy, fija Order.customerId sin contar reembolsos',
    async paymentStatus => {
      estado = paymentStatus
      prismaMock.payment.count.mockResolvedValue(1)
      await updateGuestInfo(VENUE, ORDER, { customerName: 'Kev', customerId: 'cust-K' }, { otorgarLealtad: false })
      expect(datosEscritos()).toEqual({ customerName: 'Kev', customerId: 'cust-K' })
      expect(prismaMock.payment.count).not.toHaveBeenCalled()
    },
  )

  it('🔴 la decisión se toma bajo el candado de la venta: PRIMERA sentencia (FOR NO KEY UPDATE), con su presupuesto', async () => {
    await updateGuestInfo(VENUE, ORDER, { covers: 2 }, { otorgarLealtad: false })
    expect(candadosDentro).toEqual([true])
    const [sql] = prismaMock.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray]
    expect(sql.join('?')).toMatch(/FROM "Order"[\s\S]*FOR NO KEY UPDATE/)
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.order.findUnique.mock.invocationCallOrder[0])
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000, maxWait: 5_000 })
  })

  it('regresión: la venta no es de este negocio ⇒ 404, sin escribir', async () => {
    prismaMock.$queryRaw.mockResolvedValue([] as never)
    await expect(updateGuestInfo(VENUE, ORDER, { covers: 2 }, { otorgarLealtad: true })).rejects.toThrow('Order not found')
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('regresión: comensales < 1 ⇒ 400, sin escribir', async () => {
    await expect(updateGuestInfo(VENUE, ORDER, { covers: 0 }, { otorgarLealtad: true })).rejects.toThrow('Covers must be at least 1')
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })
})
