/**
 * Postventa: editar invitado no evita el gate histórico ni reemplaza al cliente cobrado.
 * Ante rechazo no se guarda parcialmente el resto de datos. Las cuentas abiertas siguen igual.
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
  prismaMock.order.findFirst.mockImplementation((async () => ({
    id: ORDER,
    status: 'COMPLETED',
    paymentStatus: estado,
    customerId: null,
  })) as never)
  prismaMock.orderCustomer.findFirst.mockResolvedValue(null)
  prismaMock.payment.findFirst.mockResolvedValue({
    status: 'COMPLETED',
    type: 'REGULAR',
    createdAt: new Date('2026-01-01'),
    processedById: 'cashier',
  } as any)
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

describe('TPV updateGuestInfo — atribución histórica del cliente', () => {
  it.each([
    ['PAID', 403, 'CUSTOMER_ASSIGNMENT_REQUIRES_MANAGER'],
    ['REFUNDED', 409, 'SALE_NOT_ELIGIBLE_FOR_CUSTOMER'],
  ])('venta %s sin autoridad: rechaza %s y no guarda datos parciales', async (paymentStatus, statusCode, code) => {
    estado = paymentStatus as string
    await expect(
      updateGuestInfo(VENUE, ORDER, { customerName: 'Kev', customerPhone: '5512345678', customerId: 'cust-K' }, { otorgarLealtad: false }),
    ).rejects.toMatchObject({ statusCode, code })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it.each([undefined, { otorgarLealtad: true }])('sin autoridad nueva (opciones %j) falla cerrado antes de guardar', async opciones => {
    await expect(updateGuestInfo(VENUE, ORDER, { covers: 3, customerId: 'cust-K' }, opciones)).rejects.toMatchObject({
      statusCode: 403,
      code: 'CUSTOMER_ASSIGNMENT_REQUIRES_MANAGER',
    })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('gerente autorizado puede fijar cliente olvidado de venta elegible', async () => {
    await updateGuestInfo(
      VENUE,
      ORDER,
      { customerName: 'Kev', customerId: 'cust-K' },
      {
        customerAttribution: { staffId: 'manager', canAssignHistorical: true },
      },
    )
    expect(datosEscritos()).toEqual({ customerName: 'Kev', customerId: 'cust-K' })
  })

  it('ni gerente puede reemplazar el cliente cobrado; tampoco guarda los otros datos', async () => {
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ customerId: 'cust-A' } as any)
    await expect(
      updateGuestInfo(
        VENUE,
        ORDER,
        { customerName: 'Kev', customerId: 'cust-K' },
        {
          customerAttribution: { staffId: 'manager', canAssignHistorical: true },
        },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SALE_CUSTOMER_ALREADY_ASSIGNED' })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
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
