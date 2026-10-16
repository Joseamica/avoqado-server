/**
 * 🔴 R4-2 (ronda 4 post-QA de sellos tardíos; decisión «A» del founder): el PUT del panel
 * (`PUT /dashboard/venues/:venueId/orders/:orderId`, `orders:update` — lo trae COCINA) escribía `Order.customerId` en una venta
 * PAGADA. En una venta pagada con la lealtad pendiente y sin primario, el reconciliador premia a ese cliente por el respaldo
 * heredado. Ahora:
 *   · venta PAGADA o REEMBOLSADA + la petición CAMBIA el cliente (distinto del actual, también ponerlo donde no había o quitarlo)
 *     + quien edita NO tiene `payments:create` ⇒ 403 en español y NO se guarda nada de esa petición;
 *   · mismo cliente que el actual, venta abierta, o quien edita tiene el permiso ⇒ como hoy;
 *   · decidido bajo el candado de la venta (`bloquearVentaParaLiga`, primera sentencia de la transacción).
 * Por qué 403 y no ignorarlo en silencio: el panel sólo sabe mostrar `Order.customerId`; si el servidor lo ignorara, el panel
 * diría «guardado» con el cliente viejo.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { ForbiddenError } from '@/errors/AppError'
import { updateOrder } from '@/services/dashboard/order.dashboard.service'

const VENUE = 'venue-1'
const ORDER = 'order-1'
const MENSAJE = 'Para cambiar el cliente de una venta ya cobrada necesitas el permiso de cobrar. Pídeselo a tu administrador.'

/** Cada sentencia cruda, en orden (el candado de la venta y, con topología, el de la mesa). */
let sentencias: string[]

function orden(over: Record<string, unknown> = {}) {
  return { id: ORDER, venueId: VENUE, status: 'COMPLETED', paymentStatus: 'PAID', customerId: null, items: [], ...over }
}

beforeEach(() => {
  sentencias = []
  for (const m of [
    prismaMock.$queryRaw,
    prismaMock.order.findFirst,
    prismaMock.order.update,
    prismaMock.customer.findFirst,
    prismaMock.payment.count,
  ] as jest.Mock[])
    m.mockReset()
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
    const sql = Array.isArray(query) ? query.join(' ') : String((query as { sql?: string })?.sql ?? query)
    sentencias.push(sql)
    if (sql.includes('FROM "Venue"')) return [{ id: VENUE }]
    if (sql.includes('FROM "Order"')) return [{ id: ORDER }]
    if (sql.includes('FROM "Table"')) return [{ id: 'table-1' }]
    return []
  })
  prismaMock.order.findMany.mockResolvedValue([
    { id: ORDER, tableId: null, status: 'COMPLETED', paymentStatus: 'PAID', createdAt: new Date('2026-10-01T00:00:00Z') },
  ])
  prismaMock.table.findMany.mockResolvedValue([])
  prismaMock.table.findFirst.mockResolvedValue({ id: 'table-1' })
  prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust-B' })
  prismaMock.order.update.mockImplementation(async (args: any) => orden(args.data))
})

const escribio = () => prismaMock.order.update.mock.calls.length > 0

describe('🔴 R4-2: PUT del panel — cambiar el cliente de una venta COBRADA exige payments:create', () => {
  it.each([
    ['PAID, sin cliente ⇒ ponerlo', { paymentStatus: 'PAID', customerId: null }, 'cust-B'],
    ['REFUNDED, sin cliente ⇒ ponerlo', { paymentStatus: 'REFUNDED', customerId: null }, 'cust-B'],
    ['PAID, cliente A ⇒ cambiarlo a B', { paymentStatus: 'PAID', customerId: 'cust-A' }, 'cust-B'],
    ['PAID, cliente A ⇒ quitarlo ("")', { paymentStatus: 'PAID', customerId: 'cust-A' }, ''],
    ['PAID, cliente A ⇒ quitarlo (null)', { paymentStatus: 'PAID', customerId: 'cust-A' }, null],
  ])('🔴 %s, SIN permiso ⇒ 403 en español y no se guarda NADA de la petición', async (_n, actual, nuevo) => {
    prismaMock.order.findFirst.mockResolvedValue(orden(actual))
    const error = await updateOrder(VENUE, ORDER, { customerId: nuevo, customerName: 'Kev' } as any).catch(e => e)
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error).toMatchObject({ statusCode: 403, message: MENSAJE })
    expect(escribio()).toBe(false)
  })

  it('🔴 sin decir el permiso (llamador interno) falla CERRADO: 403', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden())
    await expect(updateOrder(VENUE, ORDER, { customerId: 'cust-B' } as any)).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      updateOrder(VENUE, ORDER, { customerId: 'cust-B' } as any, { puedeCambiarClienteEnVentaCobrada: false }),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(escribio()).toBe(false)
  })

  it('🔴 la decisión se toma bajo el candado de la venta: `FOR NO KEY UPDATE` es la PRIMERA sentencia, con el presupuesto único', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden())
    await updateOrder(VENUE, ORDER, { customerId: 'cust-B' } as any).catch(() => undefined)
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000, maxWait: 5_000 })
    expect(sentencias[0]).toMatch(/FROM "Order"[\s\S]*FOR NO KEY UPDATE/)
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.order.findFirst.mock.invocationCallOrder[0])
    // Lo que decide (cobrada y cliente vigente) se lee DENTRO, después del candado.
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ paymentStatus: true, customerId: true }) }),
    )
  })

  it('🔴 con topología (mesa + cliente) en una venta cobrada y sin permiso: 403 y no se guarda la mesa tampoco', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden())
    prismaMock.table.findMany.mockResolvedValue([{ id: 'table-1', number: '1', status: 'AVAILABLE', currentOrderId: null }])
    await expect(updateOrder(VENUE, ORDER, { tableId: 'table-1', customerId: 'cust-B' } as any)).rejects.toMatchObject({
      statusCode: 403,
    })
    expect(escribio()).toBe(false)
  })

  it('con payments:create: como hoy, fija el cliente', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden())
    await updateOrder(VENUE, ORDER, { customerId: 'cust-B' } as any, { puedeCambiarClienteEnVentaCobrada: true })
    expect(prismaMock.order.update.mock.calls[0][0].data).toMatchObject({ customerId: 'cust-B' })
  })

  it('regresión: el MISMO cliente que ya tiene (el panel lo reenvía) ⇒ como hoy, sin permiso', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden({ customerId: 'cust-B' }))
    await updateOrder(VENUE, ORDER, { customerId: 'cust-B', customerName: 'Kev' } as any)
    expect(prismaMock.order.update.mock.calls[0][0].data).toMatchObject({ customerId: 'cust-B', customerName: 'Kev' })
  })

  it('regresión: sin cliente y la petición manda "" (sin cliente) ⇒ no es cambio: como hoy', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden({ customerId: null }))
    await updateOrder(VENUE, ORDER, { customerId: '', customerName: 'Kev' } as any)
    expect(prismaMock.order.update).toHaveBeenCalled()
  })

  it.each([['PENDING'], ['PARTIAL']])('regresión: venta ABIERTA (%s) y sin permiso ⇒ como hoy, fija el cliente', async paymentStatus => {
    prismaMock.order.findFirst.mockResolvedValue(orden({ status: 'PENDING', paymentStatus }))
    prismaMock.payment.count.mockResolvedValue(0) // nunca se cobró: sin reembolso
    await updateOrder(VENUE, ORDER, { customerId: 'cust-B' } as any)
    expect(prismaMock.order.update.mock.calls[0][0].data).toMatchObject({ customerId: 'cust-B' })
  })

  // 🔴 R6-1 (ronda 6; Codex recheck-10 P2): una venta que YA se cobró (tiene reembolso) y que un abono posterior dejó PARTIAL
  // sigue siendo «cobrada»: COCINA no le cambia el cliente.
  it.each([['PARTIAL'], ['PENDING']])(
    '🔴 R6-1: venta %s que YA se cobró (con reembolso), SIN permiso ⇒ 403 y no se guarda nada; la marca se lee bajo el candado',
    async paymentStatus => {
      prismaMock.order.findFirst.mockResolvedValue(orden({ status: 'PENDING', paymentStatus }))
      prismaMock.payment.count.mockResolvedValue(1)
      const error = await updateOrder(VENUE, ORDER, { customerId: 'cust-B', customerName: 'Kev' } as any).catch(e => e)
      expect(error).toBeInstanceOf(ForbiddenError)
      expect(error).toMatchObject({ statusCode: 403, message: MENSAJE })
      expect(escribio()).toBe(false)
      expect(prismaMock.payment.count).toHaveBeenCalledWith({
        where: { orderId: ORDER, venueId: VENUE, type: 'REFUND', status: 'COMPLETED' },
      })
      expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.payment.count.mock.invocationCallOrder[0])
    },
  )

  it('R6-1: venta PARTIAL que ya se cobró CON payments:create ⇒ como hoy, fija el cliente', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden({ status: 'PENDING', paymentStatus: 'PARTIAL' }))
    prismaMock.payment.count.mockResolvedValue(1)
    await updateOrder(VENUE, ORDER, { customerId: 'cust-B' } as any, { puedeCambiarClienteEnVentaCobrada: true })
    expect(prismaMock.order.update.mock.calls[0][0].data).toMatchObject({ customerId: 'cust-B' })
  })

  it('regresión: una venta cobrada a la que sólo se le cambia el nombre (sin `customerId`) ⇒ como hoy, sin candado nuevo', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden())
    await updateOrder(VENUE, ORDER, { customerName: 'Kev' } as any)
    expect(prismaMock.order.update.mock.calls[0][0].data).toEqual({ customerName: 'Kev' })
    expect(sentencias).toEqual([])
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('regresión: un cliente que no es de este negocio sigue siendo 404', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden({ paymentStatus: 'PENDING', status: 'PENDING' }))
    prismaMock.customer.findFirst.mockResolvedValue(null)
    await expect(updateOrder(VENUE, ORDER, { customerId: 'cust-X' } as any)).rejects.toMatchObject({ statusCode: 404 })
  })
})
