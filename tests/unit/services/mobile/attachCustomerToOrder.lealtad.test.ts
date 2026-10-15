/**
 * «Agregar cliente» en «Cobro exitoso» (POST /mobile/.../payments/:paymentId/customer y /payments/customer) liga al cliente
 * y AHORA también da el sello tardío. Antes no llamaba a la lealtad: 3 de 5 ventas con cliente de Testarudo perdieron su sello.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
const mockLate = jest.fn()
const mockReabrir = jest.fn()
jest.mock('@/services/shared/loyaltyOnLateCustomer', () => ({
  awardLoyaltyForLateCustomer: (...a: unknown[]) => mockLate(...a),
  reabrirLealtadSiAplica: (...a: unknown[]) => mockReabrir(...a),
}))

import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { NotFoundError } from '@/errors/AppError'
import { attachCustomerToLatestPayment, attachCustomerToPayment } from '@/services/mobile/order.mobile.service'

const VENUE = 'venue-1'
let enTransaccion = false
let reabrioDentroDeLaTransaccion: boolean | null = null
const SELLO = { stampsEnabled: true, stamped: true, reason: null, stampsEarned: 2, stampsRequired: 7, rewardReady: false }
const ORDEN_LIGADA = {
  id: 'order-1',
  orderNumber: 'ORD-1',
  customerId: 'cust-1',
  customerName: 'Dany',
  customerPhone: '+525543453965',
  customerEmail: null,
}

beforeEach(() => {
  reabrioDentroDeLaTransaccion = null
  prismaMock.$transaction.mockImplementation(async (cb: any) => {
    enTransaccion = true
    try {
      return await cb(prismaMock)
    } finally {
      enTransaccion = false
    }
  })
  mockReabrir.mockImplementation(async () => {
    reabrioDentroDeLaTransaccion = enTransaccion
    return true
  })
  prismaMock.payment.findFirst.mockResolvedValue({ id: 'pay-1', orderId: 'order-1' } as any)
  prismaMock.order.findFirst.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1' } as any)
  prismaMock.customer.findUnique.mockResolvedValue({
    id: 'cust-1',
    venueId: VENUE,
    firstName: 'Dany',
    lastName: null,
    email: null,
    phone: '+525543453965',
  } as any)
  prismaMock.orderCustomer.findUnique.mockResolvedValue(null)
  prismaMock.orderCustomer.findFirst.mockResolvedValue(null)
  prismaMock.orderCustomer.create.mockResolvedValue({ id: 'oc-1' } as any)
  prismaMock.order.update.mockResolvedValue(ORDEN_LIGADA as any)
  mockLate.mockResolvedValue(SELLO)
})

describe('attachCustomerToPayment — sello tardío', () => {
  it('🔴 llama al helper DESPUÉS de ligar, con el actor, y devuelve loyalty junto a los campos de siempre', async () => {
    const r = await attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: true } })
    expect(mockLate).toHaveBeenCalledWith({ venueId: VENUE, orderId: 'order-1', customerId: 'cust-1', staffId: 'staff-1', ligaNueva: true })
    expect(r).toEqual({ ...ORDEN_LIGADA, loyalty: SELLO })
  })

  it('helper devuelve null (venta abierta o falla): loyalty null, la liga responde igual', async () => {
    mockLate.mockResolvedValue(null)
    expect((await attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')).loyalty).toBeNull()
  })

  it('🔴 aunque el helper lanzara, la liga NO falla (ya quedó guardada)', async () => {
    mockLate.mockRejectedValue(new Error('boom'))
    await expect(attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')).resolves.toMatchObject({ id: 'order-1', loyalty: null })
  })

  it('regresión: cliente de otro negocio ⇒ 404 y ni liga ni lealtad', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'cust-1', venueId: 'otro' } as any)
    await expect(attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')).rejects.toThrow(NotFoundError)
    expect(mockLate).not.toHaveBeenCalled()
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
  })

  it('sin actor (cliente viejo del servicio): staffId null', async () => {
    await attachCustomerToPayment(VENUE, 'pay-1', 'cust-1')
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ staffId: null }))
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ staffId: null }))
  })

  it('🔴 reabre la lealtad DENTRO de la transacción de la liga y ANTES del intento inmediato (auditoría A #1)', async () => {
    await attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, { venueId: VENUE, orderId: 'order-1', customerId: 'cust-1', staffId: 'staff-1' })
    expect(reabrioDentroDeLaTransaccion).toBe(true)
    expect(mockReabrir.mock.invocationCallOrder[0]).toBeLessThan(mockLate.mock.invocationCallOrder[0])
  })

  it('🔴 la reapertura es la ÚLTIMA escritura de la transacción: después de crear el OrderCustomer y de escribir la orden', async () => {
    // Ruling del coordinador tras S3b: la reapertura deja una MARCA en la fila de la orden. Un cierre «sin cliente» que espera
    // el candado de fila de la liga sólo relee las columnas de la fila al soltarse; la marca tiene que ser lo último que se
    // escribe antes del commit, para que la ventana entre la marca y el commit sea mínima.
    await attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')
    const reapertura = mockReabrir.mock.invocationCallOrder[0]
    expect(reapertura).toBeGreaterThan(prismaMock.orderCustomer.create.mock.invocationCallOrder[0])
    expect(reapertura).toBeGreaterThan(prismaMock.order.update.mock.invocationCallOrder[0])
  })

  it('cliente ya ligado y no primario, sin primario en la venta: se promueve y TAMBIÉN se reabre', async () => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', isPrimary: false } as any)
    prismaMock.orderCustomer.updateMany.mockResolvedValue({ count: 1 } as any)
    await attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')
    // BAJO-3: la promoción es condicional (`isPrimary: false`): sólo UNA llamada simultánea la hace, y sólo ésa audita.
    expect(prismaMock.orderCustomer.updateMany).toHaveBeenCalledWith({ where: { id: 'oc-1', isPrimary: false }, data: { isPrimary: true } })
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, { venueId: VENUE, orderId: 'order-1', customerId: 'cust-1', staffId: 'staff-1' })
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ ligaNueva: true }))
  })

  it('BAJO-3: otra llamada simultánea ya lo promovió (la promoción condicional no tocó nada) ⇒ sigue, pero no audita', async () => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', isPrimary: false } as any)
    prismaMock.orderCustomer.updateMany.mockResolvedValue({ count: 0 } as any)
    const r = await attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')
    expect(r).toEqual({ ...ORDEN_LIGADA, loyalty: SELLO })
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ ligaNueva: false }))
  })

  it('si reabrir falla, la liga falla entera (misma transacción) y no se intenta la lealtad: el cajero reintenta', async () => {
    mockReabrir.mockRejectedValue(new Error('P1001'))
    await expect(attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')).rejects.toThrow('P1001')
    expect(mockLate).not.toHaveBeenCalled()
  })
})

describe('attachCustomerToLatestPayment — el actor no es el staffId del body', () => {
  it('🔴 el body filtra processedById; el sello lleva al usuario AUTENTICADO', async () => {
    await attachCustomerToLatestPayment(VENUE, {
      customerId: 'cust-1',
      amountCents: 5000,
      staffId: 'cobro-staff',
      actorStaffId: 'quien-ligo',
    })
    expect((prismaMock.payment.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({ processedById: 'cobro-staff' })
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'quien-ligo' }))
  })

  it('devuelve loyalty junto a los campos de siempre', async () => {
    const r = await attachCustomerToLatestPayment(VENUE, { customerId: 'cust-1', amountCents: 5000, actorStaffId: 'quien-ligo' })
    expect(r).toEqual({ ...ORDEN_LIGADA, loyalty: SELLO })
  })
})

/**
 * 🔴 BAJO-3 (full-testing, 15-oct-2026): seis «Agregar cliente» del MISMO cliente a la MISMA venta pagada, a la vez. El dinero
 * cuadró (un sello, unos puntos), pero una respuesta fue 500: dos transacciones leyeron «sin liga», las dos intentaron crear el
 * `OrderCustomer` y la segunda chocó con el único `(orderId, customerId)` (P2002). Y quedaron DOS filas de auditoría.
 * Ahora ese choque quiere decir «ya está ligado»: se reintenta la liga (la relectura ve la de la otra llamada) y se sigue como
 * éxito; sólo la llamada que CREÓ la liga audita.
 */
describe('🔴 BAJO-3: la liga es idempotente ante el MISMO cliente agregado a la vez', () => {
  /** El P2002 con la forma que Prisma reporta DE VERDAD (`meta.target` = columnas; medido en `turnoDeCaja.ts`). */
  const choque = (target: unknown) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`orderId`,`customerId`)', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName: 'OrderCustomer', target },
    })

  it('🔴 el choque con (orderId, customerId) se reintenta: la relectura ve la liga de la otra llamada, éxito sin 500 y sin crear otra', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(choque(['orderId', 'customerId']))
    // Segundo intento: la otra llamada ya hizo commit — el cliente está ligado y es el primario.
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', isPrimary: true } as any)
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-1' } as any)
    const r = await attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    expect(r).toEqual({ ...ORDEN_LIGADA, loyalty: SELLO })
    // La lealtad se completa (idempotente) y la reapertura corre como en cualquier re-liga, pero NO audita: la otra llamada sí.
    expect(mockReabrir).toHaveBeenCalledTimes(1)
    expect(mockLate).toHaveBeenCalledWith({
      venueId: VENUE,
      orderId: 'order-1',
      customerId: 'cust-1',
      staffId: 'staff-1',
      ligaNueva: false,
    })
  })

  it('el choque también se reconoce por el NOMBRE del índice (otra forma de `meta`)', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(choque('OrderCustomer_orderId_customerId_key'))
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', isPrimary: true } as any)
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-1' } as any)
    await expect(attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')).resolves.toMatchObject({ id: 'order-1' })
  })

  it('cliente ya ligado y primario (doble toque en serie): no crea otra liga y no audita', async () => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', isPrimary: true } as any)
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-1' } as any)
    await attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ ligaNueva: false }))
  })

  it('regresión: OTRO P2002 (no es la liga de este cliente, p. ej. el primario de otro cliente a la vez) se propaga, sin reintentar', async () => {
    const otro = choque(['orderId'])
    prismaMock.$transaction.mockRejectedValueOnce(otro)
    await expect(attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')).rejects.toBe(otro)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(mockLate).not.toHaveBeenCalled()
  })

  it('regresión: un error que no es choque (la base cayó) se propaga, sin reintentar', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(new Error('P1001'))
    await expect(attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')).rejects.toThrow('P1001')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('el reintento tiene tope: si el choque se repite (la liga aparece y desaparece), al tercer intento el error sube', async () => {
    const c = choque(['orderId', 'customerId'])
    prismaMock.$transaction.mockRejectedValueOnce(c).mockRejectedValueOnce(c).mockRejectedValueOnce(c)
    await expect(attachCustomerToPayment(VENUE, 'pay-1', 'cust-1', 'staff-1')).rejects.toBe(c)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(3)
    expect(mockLate).not.toHaveBeenCalled()
  })
})
