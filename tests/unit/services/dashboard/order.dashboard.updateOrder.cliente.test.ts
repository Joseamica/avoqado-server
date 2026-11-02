/**
 * Postventa: el editor genérico conserva cuentas abiertas y reenvíos del mismo cliente.
 * Una venta pagada anónima exige autoridad histórica o recibo propio reciente;
 * nunca permite reemplazar o quitar un cliente existente, incluso con permiso.
 * Todas las decisiones ocurren bajo el candado, sin guardar parcialmente la petición.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { ForbiddenError, ConflictError } from '@/errors/AppError'
import { updateOrder } from '@/services/dashboard/order.dashboard.service'

const VENUE = 'venue-1'
const ORDER = 'order-1'
const MENSAJE = 'Sólo un gerente o superior con permiso puede asignar un cliente a esta venta.'

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
  prismaMock.orderCustomer.findFirst.mockResolvedValue(null)
  prismaMock.payment.findFirst.mockResolvedValue({
    status: 'COMPLETED',
    type: 'REGULAR',
    createdAt: new Date('2026-01-01'),
    processedById: 'cashier',
  } as any)
  prismaMock.customer.findFirst.mockResolvedValue({ id: 'cust-B' })
  prismaMock.order.update.mockImplementation(async (args: any) => orden(args.data))
})

const escribio = () => prismaMock.order.update.mock.calls.length > 0

describe('PUT del panel — autoridad histórica e inmutabilidad del cliente cobrado', () => {
  it('PAID anónima sin autoridad: 403 y no guarda ningún campo', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden())
    const error = await updateOrder(VENUE, ORDER, { customerId: 'cust-B', customerName: 'Kev' } as any).catch(e => e)
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error).toMatchObject({ statusCode: 403, message: MENSAJE })
    expect(escribio()).toBe(false)
  })

  it.each([
    ['REFUNDED, sin cliente', { paymentStatus: 'REFUNDED', customerId: null }, 'cust-B', 'SALE_NOT_ELIGIBLE_FOR_CUSTOMER'],
    ['PAID, cliente A a B', { customerId: 'cust-A' }, 'cust-B', 'SALE_CUSTOMER_ALREADY_ASSIGNED'],
    ['PAID, cliente A a vacío', { customerId: 'cust-A' }, '', 'SALE_CUSTOMER_ALREADY_ASSIGNED'],
    ['PAID, cliente A a null', { customerId: 'cust-A' }, null, 'SALE_CUSTOMER_ALREADY_ASSIGNED'],
  ])('%s: conflicto aun para gerente y no guarda ningún campo', async (_n, actual, nuevo, code) => {
    prismaMock.order.findFirst.mockResolvedValue(orden(actual as Record<string, unknown>))
    const error = await updateOrder(VENUE, ORDER, { customerId: nuevo, customerName: 'Kev' } as any, {
      customerAttribution: { staffId: 'manager', canAssignHistorical: true },
    }).catch(e => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({ statusCode: 409, code })
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

  it('gerente autorizado fija el cliente olvidado de una venta elegible', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden())
    await updateOrder(VENUE, ORDER, { customerId: 'cust-B' } as any, {
      customerAttribution: { staffId: 'manager', canAssignHistorical: true },
    })
    expect(prismaMock.order.update.mock.calls[0][0].data).toMatchObject({ customerId: 'cust-B' })
  })

  it('el antiguo booleano payments:create no concede autoridad histórica', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden())
    await expect(
      updateOrder(VENUE, ORDER, { customerId: 'cust-B' } as any, { puedeCambiarClienteEnVentaCobrada: true }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'CUSTOMER_ASSIGNMENT_REQUIRES_MANAGER' })
    expect(escribio()).toBe(false)
  })

  it('el primario existente bloquea reemplazar aunque la cabecera esté vacía', async () => {
    prismaMock.order.findFirst.mockResolvedValue(orden())
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ customerId: 'cust-A' } as any)
    await expect(
      updateOrder(VENUE, ORDER, { customerId: 'cust-B' } as any, {
        customerAttribution: { canAssignHistorical: true },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SALE_CUSTOMER_ALREADY_ASSIGNED' })
    expect(escribio()).toBe(false)
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
    await updateOrder(VENUE, ORDER, { customerId: 'cust-B' } as any)
    expect(prismaMock.order.update.mock.calls[0][0].data).toMatchObject({ customerId: 'cust-B' })
  })

  // 🔴 R7-2 (ronda 7; Codex recheck-11 P2): la ronda 6 trataba como «cobrada» toda cuenta con un reembolso, y bloqueaba cuentas
  // que NUNCA se saldaron (abono de $20 y devolución de $10). «Cobrada» vuelve a ser PAID/REFUNDED, sin contar reembolsos.
  it.each([['PARTIAL'], ['PENDING']])(
    '🔴 R7-2: cuenta %s con un abono devuelto (nunca se saldó), SIN permiso ⇒ como hoy, fija el cliente y no cuenta reembolsos',
    async paymentStatus => {
      prismaMock.order.findFirst.mockResolvedValue(orden({ status: 'PENDING', paymentStatus }))
      prismaMock.payment.count.mockResolvedValue(1) // tiene un reembolso: ya no importa
      await updateOrder(VENUE, ORDER, { customerId: 'cust-B', customerName: 'Kev' } as any)
      expect(prismaMock.order.update.mock.calls[0][0].data).toMatchObject({ customerId: 'cust-B' })
      expect(prismaMock.payment.count).not.toHaveBeenCalled()
    },
  )

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
