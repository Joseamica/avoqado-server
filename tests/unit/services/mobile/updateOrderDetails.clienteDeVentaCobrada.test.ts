/**
 * 🔴 R4-2 (ronda 4 post-QA de sellos tardíos; decisión «A» del founder): el «detalle de la cuenta» del POS
 * (`POST /mobile/venues/:venueId/orders/:orderId/details`, `orders:update` — lo trae COCINA; también el intent offline
 * `UPDATE_DETAILS` y la tool `set_table_check_details` del MCP) escribe `Order.customerId`. Ya rechazaba las cuentas COMPLETED,
 * pero una venta PAGADA puede no estar COMPLETED (p. ej. la liquidó el panel con `settleOrder`, que no cambia el estado, o el
 * PUT del panel le cambió el estado). Ahí aplica la MISMA regla que el PUT del panel: cambiar el cliente de una venta COBRADA
 * sin `payments:create` ⇒ 403 y no se guarda nada; mismo cliente, venta abierta o con permiso ⇒ como hoy.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { updateOrderDetails, updateOrderDetailsInTransaction } from '@/services/mobile/order.mobile.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const MENSAJE = 'Para cambiar el cliente de una venta ya cobrada necesitas el permiso de cobrar. Pídeselo a tu administrador.'

/** `reembolsos`: los `Payment` REFUND COMPLETED de la venta (R7-2: ya no cuentan para «cobrada»; la prueba lo vigila). */
function crearTx(orden: Record<string, unknown>, reembolsos = 0) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'order' }]),
    payment: { count: jest.fn().mockResolvedValue(reembolsos) },
    order: {
      findFirst: jest.fn().mockResolvedValue({ id: 'order', status: 'CONFIRMED', customerName: null, ...orden }),
      update: jest.fn().mockImplementation(async (a: { data: Record<string, unknown> }) => ({
        customerName: a.data.customerName ?? null,
        specialRequests: null,
        covers: 2,
        customerId: 'customerId' in a.data ? a.data.customerId : (orden.customerId ?? null),
        type: 'DINE_IN',
      })),
    },
    customer: { findFirst: jest.fn().mockResolvedValue({ id: 'cust-B', firstName: 'Kev', lastName: null }) },
  }
}

describe('🔴 R4-2: detalle de la cuenta del POS — cambiar el cliente de una venta COBRADA exige payments:create', () => {
  it.each([
    ['PAID, sin cliente ⇒ ponerlo', { paymentStatus: 'PAID', customerId: null }, 'cust-B'],
    ['REFUNDED, sin cliente ⇒ ponerlo', { paymentStatus: 'REFUNDED', customerId: null }, 'cust-B'],
    ['PAID, cliente A ⇒ cambiarlo a B', { paymentStatus: 'PAID', customerId: 'cust-A' }, 'cust-B'],
    ['PAID, cliente A ⇒ quitarlo ("")', { paymentStatus: 'PAID', customerId: 'cust-A' }, ''],
  ])('🔴 %s (estado CONFIRMED), SIN permiso ⇒ 403 en español y no se guarda NADA', async (_n, orden, nuevo) => {
    const tx = crearTx(orden)
    const error = await updateOrderDetailsInTransaction(tx as any, 'venue', 'order', { name: 'Kev', customerId: nuevo }, {}).catch(e => e)
    expect(error).toMatchObject({ statusCode: 403, message: MENSAJE })
    expect(tx.order.update).not.toHaveBeenCalled()
  })

  it('🔴 sin decir el permiso (el llamador de siempre) falla CERRADO', async () => {
    const tx = crearTx({ paymentStatus: 'PAID', customerId: null })
    await expect(updateOrderDetailsInTransaction(tx as any, 'venue', 'order', { customerId: 'cust-B' })).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('🔴 lo decide con lo leído BAJO el candado de la venta (el candado va primero y la lectura trae cobro y cliente)', async () => {
    const tx = crearTx({ paymentStatus: 'PAID', customerId: null })
    await updateOrderDetailsInTransaction(tx as any, 'venue', 'order', { customerId: 'cust-B' }).catch(() => undefined)
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.order.findFirst.mock.invocationCallOrder[0])
    expect(tx.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ paymentStatus: true, customerId: true }) }),
    )
  })

  it('con payments:create: como hoy, fija el cliente', async () => {
    const tx = crearTx({ paymentStatus: 'PAID', customerId: null })
    const r = await updateOrderDetailsInTransaction(
      tx as any,
      'venue',
      'order',
      { customerId: 'cust-B' },
      { puedeCambiarClienteEnVentaCobrada: true },
    )
    expect(r.data.customerId).toBe('cust-B')
  })

  it('regresión: el MISMO cliente que ya tiene ⇒ como hoy, sin permiso', async () => {
    const tx = crearTx({ paymentStatus: 'PAID', customerId: 'cust-B' })
    await updateOrderDetailsInTransaction(tx as any, 'venue', 'order', { name: 'Kev', customerId: 'cust-B' })
    expect(tx.order.update).toHaveBeenCalled()
  })

  it('regresión: `customerId: null` (Android serializa los defaults: «sin cambio») en una venta cobrada ⇒ como hoy', async () => {
    const tx = crearTx({ paymentStatus: 'PAID', customerId: 'cust-A' })
    await updateOrderDetailsInTransaction(tx as any, 'venue', 'order', { name: 'Kev', customerId: null })
    expect(tx.order.update.mock.calls[0][0].data).toEqual({ customerName: 'Kev' })
  })

  it('regresión: cuenta ABIERTA y sin permiso ⇒ como hoy, fija el cliente', async () => {
    const tx = crearTx({ paymentStatus: 'PENDING', customerId: null })
    const r = await updateOrderDetailsInTransaction(tx as any, 'venue', 'order', { customerId: 'cust-B' })
    expect(r.data.customerId).toBe('cust-B')
  })

  // 🔴 R7-2 (ronda 7; Codex recheck-11 P2): una cuenta con un abono devuelto que NUNCA se saldó ya no cuenta como «cobrada».
  it.each(['PARTIAL', 'PENDING'])(
    '🔴 R7-2: cuenta %s con un abono devuelto (nunca se saldó), SIN permiso ⇒ como hoy, sin contar reembolsos',
    async estado => {
      const tx = crearTx({ paymentStatus: estado, customerId: null }, 1)
      const r = await updateOrderDetailsInTransaction(tx as any, 'venue', 'order', { name: 'Kev', customerId: 'cust-B' }, {})
      expect(r.data.customerId).toBe('cust-B')
      expect(tx.payment.count).not.toHaveBeenCalled()
    },
  )

  it('regresión: una cuenta COMPLETED sigue cerrada (400), como siempre', async () => {
    const tx = crearTx({ status: 'COMPLETED', paymentStatus: 'PAID', customerId: null })
    await expect(updateOrderDetailsInTransaction(tx as any, 'venue', 'order', { customerId: 'cust-B' })).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('el envoltorio `updateOrderDetails` (intent offline y MCP) pasa el permiso a la transacción', async () => {
    const tx = crearTx({ paymentStatus: 'PAID', customerId: null })
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => cb(tx))
    expect(await updateOrderDetails('venue', 'order', { customerId: 'cust-B' }, { puedeCambiarClienteEnVentaCobrada: true })).toMatchObject(
      {
        customerId: 'cust-B',
      },
    )
    prismaMock.$transaction.mockImplementationOnce(async (cb: any) => cb(crearTx({ paymentStatus: 'PAID', customerId: null })))
    await expect(updateOrderDetails('venue', 'order', { customerId: 'cust-B' })).rejects.toMatchObject({ statusCode: 403 })
  })
})
