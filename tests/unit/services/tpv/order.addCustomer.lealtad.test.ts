/**
 * La TPV también liga clientes (`orders/:orderId/customers` y `.../customers/create`). Si la venta ya está pagada, la regla
 * del sello tardío aplica igual que en el POS: cualquier camino que ligue un cliente a una venta pagada sella.
 */
const mockLate = jest.fn()
const mockReabrir = jest.fn()
const mockAuditSinPermiso = jest.fn()
jest.mock('@/services/shared/loyaltyOnLateCustomer', () => ({
  awardLoyaltyForLateCustomer: (...a: unknown[]) => mockLate(...a),
  reabrirLealtadSiAplica: (...a: unknown[]) => mockReabrir(...a),
  auditarLigaSinPermisoDeCobro: (...a: unknown[]) => mockAuditSinPermiso(...a),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { addCustomerToOrder, createAndAddCustomerToOrder } from '@/services/tpv/order.tpv.service'

const VENUE = 'venue-1'
const LISTA = [{ id: 'oc-1', orderId: 'order-1', customerId: 'cust-1', isPrimary: true, customer: { id: 'cust-1' } }]
const SELLO = { stampsEnabled: true, stamped: true, reason: null, stampsEarned: 1, stampsRequired: 7, rewardReady: false }
/** MEDIO-1: quien liga TIENE `payments:create` (lo decide el controller con el resolvedor de permisos). */
const CON_PERMISO = { otorgarLealtad: true, customerAttribution: { staffId: 'staff-1', canAssignHistorical: true } }
const SIN_PERMISO = { otorgarLealtad: false }
/** El presupuesto de toda transacción que toma el candado canónico de la venta (`ORDER_LOCK_WAIT_BUDGET`), en Serializable. */
const OPCIONES_DE_LA_TX = { isolationLevel: 'Serializable', timeout: 15_000, maxWait: 5_000 }
/** Un P2002 como lo deja Prisma (`code` + `meta.target`). */
const choque = (target: unknown) => Object.assign(new Error('unique'), { code: 'P2002', meta: { target } })

let enTransaccion = false
let reabrioDentro: boolean | null = null
/** ¿Cada `SELECT … FOR UPDATE` de la venta (`lockExistingOrderForPayment`) ocurrió dentro de la transacción? */
let candadosDentro: boolean[] = []
/** El `paymentStatus` que ve cada lectura DENTRO de la transacción (en orden); vacío ⇒ PAID. */
let estadoDentro: string[] = []
/** ¿Cada lectura de estado ocurrió dentro de la transacción? */
let lecturasDeEstado: boolean[] = []

beforeEach(() => {
  reabrioDentro = null
  estadoDentro = []
  lecturasDeEstado = []
  candadosDentro = []
  prismaMock.$transaction.mockImplementation(async (cb: any) => {
    enTransaccion = true
    try {
      return await cb(prismaMock)
    } finally {
      enTransaccion = false
    }
  })
  prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1' } as any)
  // F1 (segunda ola): el estado de la venta se lee DENTRO de la transacción de la liga (tx = prismaMock aquí).
  prismaMock.order.findFirst.mockReset()
  prismaMock.order.findFirst.mockImplementation((async () => {
    lecturasDeEstado.push(enTransaccion)
    return { paymentStatus: estadoDentro.shift() ?? 'PAID', status: 'COMPLETED', customerId: null }
  }) as never)
  // F1 (ronda 1): el candado canónico de la venta (`SELECT … FOR UPDATE`) es la primera sentencia de la liga.
  prismaMock.$queryRaw.mockReset()
  prismaMock.$queryRaw.mockImplementation((async () => {
    candadosDentro.push(enTransaccion)
    return [{ id: 'order-1' }]
  }) as never)
  // R7-2: los reembolsos ya no deciden «cobrada»; el conteo no debe preguntarse (las pruebas lo vigilan).
  prismaMock.payment.count.mockReset()
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.payment.findFirst.mockResolvedValue({
    status: 'COMPLETED',
    type: null,
    createdAt: new Date(),
    processedById: 'staff-1',
  } as any)
  prismaMock.orderCustomer.findUnique.mockReset()
  prismaMock.orderCustomer.findUnique.mockResolvedValue(null)
  // El primario VIGENTE (dentro de la transacción): sin primario por defecto.
  prismaMock.orderCustomer.findFirst.mockReset()
  prismaMock.orderCustomer.findFirst.mockResolvedValue(null)
  prismaMock.orderCustomer.create.mockResolvedValue({ id: 'oc-1' } as any)
  prismaMock.orderCustomer.updateMany.mockResolvedValue({ count: 1 } as any)
  mockAuditSinPermiso.mockResolvedValue(undefined)
  prismaMock.orderCustomer.findMany.mockResolvedValue(LISTA as any)
  mockLate.mockResolvedValue(SELLO)
  mockReabrir.mockImplementation(async () => {
    reabrioDentro = enTransaccion
    return true
  })
})

describe('TPV addCustomerToOrder', () => {
  beforeEach(() => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'cust-1', venueId: VENUE, firstName: 'Dany', lastName: null } as any)
  })

  it('🔴 liga, llama al helper con el actor y conserva la lista de siempre', async () => {
    const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    expect(mockLate).toHaveBeenCalledWith({
      venueId: VENUE,
      orderId: 'order-1',
      customerId: 'cust-1',
      staffId: 'staff-1',
      ligaNueva: true,
      ventaCobrada: true,
    })
    expect(r).toEqual({ orderCustomers: LISTA, loyalty: SELLO })
  })

  it('helper que lanza no rompe la liga: loyalty null', async () => {
    mockLate.mockRejectedValue(new Error('boom'))
    expect((await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)).loyalty).toBeNull()
  })

  it('helper devuelve null (cuenta abierta, lo normal en la TPV): loyalty null y la lista de siempre', async () => {
    mockLate.mockResolvedValue(null)
    expect(await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)).toEqual({ orderCustomers: LISTA, loyalty: null })
  })

  it('sin actor (llamador viejo del servicio): staffId null', async () => {
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', undefined, CON_PERMISO)
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ staffId: null }))
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ staffId: null }))
  })

  // ── F3 (ronda 1, revierte el ruling de conservar el 400): el MISMO cliente ya ligado es éxito idempotente ─────────────
  it('🔴 F3: cliente YA ligado (primario) y con permiso: éxito sin crear otra liga; reabre y pasa por el helper como el POS, sin auditar', async () => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', isPrimary: true } as any)
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-1', customerId: 'cust-1' } as any)
    const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    expect(r).toEqual({ orderCustomers: LISTA, loyalty: SELLO })
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    expect(prismaMock.orderCustomer.updateMany).not.toHaveBeenCalled()
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, { venueId: VENUE, orderId: 'order-1', customerId: 'cust-1', staffId: 'staff-1' })
    expect(mockLate).toHaveBeenCalledWith({
      venueId: VENUE,
      orderId: 'order-1',
      customerId: 'cust-1',
      staffId: 'staff-1',
      ligaNueva: false,
      ventaCobrada: true,
    })
  })

  it('🔴 F3: cliente YA ligado y SIN permiso: éxito con la lista de siempre, sin reabrir, sin sello y sin auditar (no creó nada)', async () => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', isPrimary: false } as any)
    const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', SIN_PERMISO)
    expect(r).toEqual({ orderCustomers: LISTA, loyalty: null })
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    // Venta PAGADA y sin permiso: no se promueve a primario (F1).
    expect(prismaMock.orderCustomer.updateMany).not.toHaveBeenCalled()
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
    expect(mockAuditSinPermiso).not.toHaveBeenCalled()
  })

  it('🔴 F3 + F1: ligado como acompañante (sin permiso) y SIN primario; quien SÍ tiene permiso lo re-liga ⇒ se PROMUEVE (condicional), reabre y audita', async () => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', isPrimary: false } as any)
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    expect(prismaMock.orderCustomer.updateMany).toHaveBeenCalledWith({ where: { id: 'oc-1', isPrimary: false }, data: { isPrimary: true } })
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    expect(mockReabrir).toHaveBeenCalledTimes(1)
    expect(mockReabrir.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.orderCustomer.updateMany.mock.invocationCallOrder[0])
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', ligaNueva: true }))
  })

  it('F3: otra llamada simultánea ya lo promovió (la promoción condicional no tocó nada): éxito, pero no cuenta como liga nueva', async () => {
    prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', isPrimary: false } as any)
    prismaMock.orderCustomer.updateMany.mockResolvedValue({ count: 0 } as any)
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ ligaNueva: false }))
  })

  it('regresión: cliente de otro negocio ⇒ 404, ni liga ni lealtad', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'cust-1', venueId: 'otro', firstName: 'Dany', lastName: null } as any)
    await expect(addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)).rejects.toThrow('Customer not found')
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
  })

  it('🔴 el primer cliente (primario) reabre la lealtad DENTRO de la transacción, antes del intento inmediato (auditoría A #1)', async () => {
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, { venueId: VENUE, orderId: 'order-1', customerId: 'cust-1', staffId: 'staff-1' })
    expect(reabrioDentro).toBe(true)
    expect(mockReabrir.mock.invocationCallOrder[0]).toBeLessThan(mockLate.mock.invocationCallOrder[0])
  })

  it('🔴 la reapertura es la ÚLTIMA escritura de la transacción: después de crear el OrderCustomer', async () => {
    // Ruling tras S3b/S4: la reapertura deja una MARCA en la fila de la orden. Un cierre «sin cliente» que espera el candado
    // de esa fila sólo relee sus columnas al soltarse; la marca tiene que ser lo último que se escribe antes del commit.
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: true } })
    expect(mockReabrir.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.orderCustomer.create.mock.invocationCallOrder[0])
  })

  it('si reabrir falla, la liga falla entera (misma transacción) y no se intenta la lealtad: el cajero reintenta', async () => {
    mockReabrir.mockRejectedValue(new Error('P1001'))
    await expect(addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)).rejects.toThrow('P1001')
    expect(mockLate).not.toHaveBeenCalled()
  })

  it('un segundo cliente (no primario) no reabre nada', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'cust-2', venueId: VENUE, firstName: 'Beto', lastName: null } as any)
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-1', customerId: 'cust-1' } as any)
    await addCustomerToOrder(VENUE, 'order-1', 'cust-2', 'staff-1', CON_PERMISO)
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-2', isPrimary: false } })
    expect(mockReabrir).not.toHaveBeenCalled()
  })

  // ── F1 (revisión final Minor 1, 15-oct-2026) ─────────────────────────────────────────────────────────────────────────
  it.each(['PENDING', 'PARTIAL'])(
    '🔴 F1: cuenta %s (lo normal en la TPV): NO se llama a la reapertura (no ensancha la lectura Serializable de una cuenta abierta)',
    async paymentStatus => {
      estadoDentro = [paymentStatus]
      mockLate.mockResolvedValue(null) // cuenta abierta: el helper no pinta nada
      const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
      expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: true } })
      expect(mockReabrir).not.toHaveBeenCalled()
      expect(r).toEqual({ orderCustomers: LISTA, loyalty: null })
    },
  )

  // ── F1, segunda ola (recheck de Codex, 15-oct-2026): el estado VIGENTE, leído dentro de la transacción ───────────────────
  it('🔴 F1: el estado se lee DENTRO de la transacción, filtrando por negocio, antes de mirar las ligas', async () => {
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    // R11-2: la regla compartida lee también la base del saldo (por si los cobros capturados ya la cubren).
    expect(prismaMock.order.findFirst).toHaveBeenCalledWith({
      where: { id: 'order-1', venueId: VENUE },
      select: expect.objectContaining({ paymentStatus: true, subtotal: true }),
    })
    expect(lecturasDeEstado.length).toBeGreaterThan(0)
    expect(lecturasDeEstado.every(Boolean)).toBe(true)
    expect(prismaMock.order.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.orderCustomer.findFirst.mock.invocationCallOrder[0],
    )
  })

  // ── F1 (ronda 1, P1 de Codex): la decisión se toma bajo el candado de la VENTA, el mismo del cobro ──────────────────────
  it('🔴 F1: la PRIMERA sentencia de la liga es el candado canónico de la venta (FOR UPDATE), y con su presupuesto de espera', async () => {
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', SIN_PERMISO)
    expect(candadosDentro).toEqual([true])
    const [sql] = prismaMock.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray]
    expect(sql.join('?')).toMatch(/FROM "Order"[\s\S]*FOR NO KEY UPDATE/)
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.order.findFirst.mock.invocationCallOrder[0])
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), OPCIONES_DE_LA_TX)
  })

  it('F1: la venta ya no es de este negocio bajo el candado ⇒ 404, sin liga', async () => {
    prismaMock.$queryRaw.mockResolvedValue([] as never)
    await expect(addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)).rejects.toThrow('Order not found')
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
  })

  it('🔴 F1: PENDIENTE en la lectura previa y PAGADA dentro de la transacción (se cobró en medio) ⇒ SÍ reabre', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', paymentStatus: 'PENDING' } as any)
    estadoDentro = ['PAID']
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    expect(mockReabrir).toHaveBeenCalledTimes(1)
    expect(reabrioDentro).toBe(true)
  })

  it('🔴 F1: un reintento por P2034 vuelve a leer el estado: PENDIENTE en el 1.er intento, PAGADA en el 2.º ⇒ reabre en el 2.º', async () => {
    estadoDentro = ['PENDING', 'PAID']
    prismaMock.$transaction.mockImplementationOnce((async (cb: any) => {
      enTransaccion = true
      try {
        await cb(prismaMock)
      } finally {
        enTransaccion = false
      }
      throw Object.assign(new Error('could not serialize access'), { code: 'P2034' })
    }) as never)
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    expect(lecturasDeEstado.length).toBeGreaterThanOrEqual(2)
    expect(lecturasDeEstado.every(Boolean)).toBe(true)
    expect(mockReabrir).toHaveBeenCalledTimes(1)
  })

  it('camino de rescate por P2002 (otro quedó primario a la vez): se reintenta bajo el candado y lo liga NO primario, sin reabrir', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(choque(['orderId']))
    // El reintento ve al primario que ganó.
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-otro', customerId: 'cust-otro' } as any)
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: false } })
    expect(mockReabrir).not.toHaveBeenCalled()
    // Esta llamada SÍ creó la liga (no primaria): es la que audita.
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', ligaNueva: true }))
  })

  // ── BAJO-3 (full-testing, 15-oct-2026): el MISMO cliente agregado varias veces a la vez ───────────────────────────────────
  it.each([
    ['las columnas del único', ['orderId', 'customerId']],
    ['el primario (otro orden de revisión de índices)', ['orderId']],
    ['el nombre del índice', 'OrderCustomer_orderId_customerId_key'],
  ])(
    '🔴 BAJO-3 + M1: CUALQUIER P2002 (%s) ⇒ se relee la liga: OTRA llamada ya ligó a este cliente ⇒ éxito, sin crear otra, sin auditar',
    async (_c, target) => {
      prismaMock.$transaction.mockRejectedValueOnce(choque(target))
      // El reintento ve la liga (y al primario) que dejó la llamada que ganó.
      prismaMock.orderCustomer.findUnique.mockResolvedValue({ id: 'oc-1', isPrimary: true } as any)
      prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-1', customerId: 'cust-1' } as any)
      const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
      expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
      expect(r).toEqual({ orderCustomers: LISTA, loyalty: SELLO })
      // La lealtad se completa (idempotente), pero la fila de auditoría es de quien SÍ ligó.
      expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', ligaNueva: false }))
    },
  )

  // ── MEDIO-1 (full-testing, 15-oct-2026; decisión «A» del founder) ────────────────────────────────────────────────────────
  // Ligar un cliente a una venta YA pagada le da su sello/puntos SÓLO si quien liga tiene `payments:create` en el negocio
  // (el mismo permiso que el «Agregar cliente» del POS). Un KITCHEN (sólo `orders:update`) sí liga, pero no sella.
  it('🔴 MEDIO-1 + F1: sin payments:create la liga a una venta PAGADA entra como ACOMPAÑANTE (no primaria): ni reapertura ni sello, y SÍ audita', async () => {
    const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', SIN_PERMISO)
    // Sin primario y aun así NO primaria: nunca es la beneficiaria de esta venta (ni del cobro en curso ni del reconciliador).
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: false } })
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
    expect(r).toEqual({ orderCustomers: LISTA, loyalty: null })
    // F2: la llamada que CREA la liga audita siempre; sin permiso, la fila lo dice.
    expect(mockAuditSinPermiso).toHaveBeenCalledWith({
      venueId: VENUE,
      orderId: 'order-1',
      customerId: 'cust-1',
      staffId: 'staff-1',
      orderNumber: 'ORD-1',
    })
  })

  // 🔴 R11-2 (Codex recheck-15 #2): la terminal capturó $100 de $100 pero la finalización falló y la venta sigue PENDING (la recupera
  // el reenvío o el barrido). COCINA (sin `payments:create`) liga a Y en esa ventana: con el dinero ya adentro es «venta ya cobrada»
  // y Y entra como ACOMPAÑANTE (la recuperación no le da sello ni puntos); con un abono que no la cubre, la liga de siempre.
  it.each([
    ['$100 capturados de $100 (la finalización falló)', '100.00', false],
    ['$60 de $100 (un abono)', '60.00', true],
  ])('🔴 R11-2: venta PENDING con %s, sin permiso ⇒ primario = %s', async (_caso, cobrado, primario) => {
    prismaMock.order.findFirst.mockImplementation((async () => ({
      paymentStatus: 'PENDING',
      status: 'PENDING',
      subtotal: '100.00',
      discountAmount: '0.00',
      serviceChargeAmount: '0.00',
      contratoDePrecio: 'IVA_INCLUIDO',
      taxAmount: '0.00',
      customerId: null,
    })) as never)
    prismaMock.payment.aggregate.mockResolvedValueOnce({ _sum: { amount: cobrado, tipAmount: null } } as any)

    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', SIN_PERMISO)

    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({
      data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: primario },
    })
    expect(mockReabrir).not.toHaveBeenCalled()
  })

  it.each(['REFUNDED'])('F1: venta %s (ya cobrada) sin permiso: también acompañante', async paymentStatus => {
    estadoDentro = [paymentStatus]
    await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', SIN_PERMISO)
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: false } })
  })

  it.each(['PENDING', 'PARTIAL'])(
    '🔴 F1 (prueba 5): cuenta %s y sin permiso: la liga de siempre (PRIMARIA; el cobro sí acreditará) y sin fila de auditoría',
    async paymentStatus => {
      estadoDentro = [paymentStatus]
      const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', SIN_PERMISO)
      expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: true } })
      expect(mockAuditSinPermiso).not.toHaveBeenCalled()
      expect(r.loyalty).toBeNull()
    },
  )

  // 🔴 R7-2 (ronda 7; Codex recheck-11 P2): una cuenta con un abono devuelto NUNCA se saldó: el cliente queda PRIMARIO como antes
  // de la ronda 6 (el cobro acreditará), sin auditoría y sin contar reembolsos.
  it.each(['PARTIAL', 'PENDING'])(
    '🔴 R7-2: cuenta %s con un abono devuelto, sin permiso: PRIMARIA como antes, sin auditoría y sin contar reembolsos',
    async paymentStatus => {
      estadoDentro = [paymentStatus]
      prismaMock.payment.count.mockResolvedValue(1)
      const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', SIN_PERMISO)
      expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: true } })
      expect(mockAuditSinPermiso).not.toHaveBeenCalled()
      expect(r.loyalty).toBeNull()
      expect(prismaMock.payment.count).not.toHaveBeenCalled()
    },
  )

  it('🔴 MEDIO-1: sin decir el permiso (llamador interno viejo) falla CERRADO: liga como acompañante, sin lealtad', async () => {
    const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1')
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'cust-1', isPrimary: false } })
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
    expect(r.loyalty).toBeNull()
  })

  it('MEDIO-1: sin payments:create y un reintento por P2002 tampoco llama al sello', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(choque(['orderId']))
    const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', SIN_PERMISO)
    expect(mockLate).not.toHaveBeenCalled()
    expect(r.loyalty).toBeNull()
  })

  it.each([
    ['la serialización del candado crudo (P2010/40001)', { code: 'P2010', meta: { code: '40001' } }],
    ['un bloqueo mutuo (P2010/40P01)', { code: 'P2010', meta: { code: '40P01' } }],
    ['la serialización de una consulta de modelo (P2034)', { code: 'P2034' }],
  ])('🔴 ronda 1: %s se reintenta y la liga sale', async (_c, forma) => {
    prismaMock.$transaction.mockRejectedValueOnce(Object.assign(new Error('conflicto'), forma))
    const r = await addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)
    expect(r).toEqual({ orderCustomers: LISTA, loyalty: SELLO })
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledTimes(1)
  })

  it('el reintento por P2002 tiene tope: si el choque se repite, sube el conflicto persistente (400) sin sello', async () => {
    const c = choque(['orderId'])
    for (let i = 0; i < 5; i++) prismaMock.$transaction.mockRejectedValueOnce(c)
    await expect(addCustomerToOrder(VENUE, 'order-1', 'cust-1', 'staff-1', CON_PERMISO)).rejects.toThrow(
      'Conflicto de concurrencia persistente',
    )
    expect(mockLate).not.toHaveBeenCalled()
  })
})

describe('TPV createAndAddCustomerToOrder', () => {
  beforeEach(() => {
    prismaMock.customer.findUnique.mockResolvedValue(null) // sin duplicados de correo/teléfono
    prismaMock.customer.create.mockResolvedValue({ id: 'nuevo' } as any)
  })

  it('🔴 crea, liga y llama al helper con el id del cliente NUEVO', async () => {
    const r = await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany', phone: '5543453965' }, 'staff-1', CON_PERMISO)
    expect(mockLate).toHaveBeenCalledWith({
      venueId: VENUE,
      orderId: 'order-1',
      customerId: 'nuevo',
      staffId: 'staff-1',
      ligaNueva: true,
      ventaCobrada: true,
    })
    expect(r).toEqual({ orderCustomers: LISTA, loyalty: SELLO })
  })

  it('el cliente nuevo y primario también reabre la lealtad dentro de la transacción', async () => {
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, { venueId: VENUE, orderId: 'order-1', customerId: 'nuevo', staffId: 'staff-1' })
    expect(reabrioDentro).toBe(true)
    expect(mockReabrir.mock.invocationCallOrder[0]).toBeLessThan(mockLate.mock.invocationCallOrder[0])
  })

  it('🔴 la reapertura es la ÚLTIMA escritura: después de crear el cliente y el OrderCustomer', async () => {
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)
    const reapertura = mockReabrir.mock.invocationCallOrder[0]
    expect(reapertura).toBeGreaterThan(prismaMock.customer.create.mock.invocationCallOrder[0])
    expect(reapertura).toBeGreaterThan(prismaMock.orderCustomer.create.mock.invocationCallOrder[0])
  })

  it('🔴 F1: cuenta abierta DENTRO de la transacción: el cliente nuevo queda primario pero NO se llama a la reapertura', async () => {
    estadoDentro = ['PENDING']
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'nuevo', isPrimary: true } })
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(lecturasDeEstado).toEqual([true])
  })

  it('🔴 F1: PENDIENTE en la lectura previa y PAGADA dentro de la transacción ⇒ el cliente NUEVO SÍ reabre', async () => {
    prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', paymentStatus: 'PENDING' } as any)
    estadoDentro = ['PAID']
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)
    expect(mockReabrir).toHaveBeenCalledWith(prismaMock, { venueId: VENUE, orderId: 'order-1', customerId: 'nuevo', staffId: 'staff-1' })
    expect(prismaMock.order.findFirst.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.customer.create.mock.invocationCallOrder[0])
  })

  it('cuenta que ya tenía primario: el cliente nuevo entra NO primario y no reabre', async () => {
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-p', customerId: 'otro' } as any)
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'nuevo' }))
  })

  it('helper que lanza no rompe el alta: loyalty null', async () => {
    mockLate.mockRejectedValue(new Error('boom'))
    expect(await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)).toEqual({
      orderCustomers: LISTA,
      loyalty: null,
    })
  })

  it('🔴 MEDIO-1 + F1 (prueba 3): sin payments:create crea al cliente y lo liga como ACOMPAÑANTE a la venta pagada; sin sello y SÍ audita', async () => {
    const r = await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', SIN_PERMISO)
    expect(prismaMock.customer.create).toHaveBeenCalled()
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'nuevo', isPrimary: false } })
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
    expect(r).toEqual({ orderCustomers: LISTA, loyalty: null })
    expect(mockAuditSinPermiso).toHaveBeenCalledWith({
      venueId: VENUE,
      orderId: 'order-1',
      customerId: 'nuevo',
      staffId: 'staff-1',
      orderNumber: 'ORD-1',
    })
  })

  it('F1: cuenta ABIERTA y sin permiso: el cliente nuevo queda primario (el cobro acreditará), sin auditoría', async () => {
    estadoDentro = ['PENDING']
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', SIN_PERMISO)
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'nuevo', isPrimary: true } })
    expect(mockAuditSinPermiso).not.toHaveBeenCalled()
  })

  it('🔴 R7-2: cuenta PARTIAL con un abono devuelto, sin permiso: el cliente nuevo queda PRIMARIO como antes, sin auditoría', async () => {
    estadoDentro = ['PARTIAL']
    prismaMock.payment.count.mockResolvedValue(1)
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', SIN_PERMISO)
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'nuevo', isPrimary: true } })
    expect(mockAuditSinPermiso).not.toHaveBeenCalled()
    expect(prismaMock.payment.count).not.toHaveBeenCalled()
  })

  it('🔴 F1: el candado de la venta es la PRIMERA sentencia, con su presupuesto de espera', async () => {
    await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)
    expect(candadosDentro).toEqual([true])
    const [sql] = prismaMock.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray]
    // R3-2: `FOR NO KEY UPDATE` — serializa contra el cobro (`FOR UPDATE`) sin chocar con el `FOR KEY SHARE` de las llaves foráneas.
    expect(sql.join('?')).toMatch(/FROM "Order"[\s\S]*FOR NO KEY UPDATE/)
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.order.findFirst.mock.invocationCallOrder[0])
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), OPCIONES_DE_LA_TX)
  })

  it('MEDIO-1: sin decir el permiso falla CERRADO (sin lealtad)', async () => {
    const r = await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1')
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
    expect(r.loyalty).toBeNull()
  })

  // ── R3-3 (ronda 3; Important N1 + Codex P2-3): mismo reintento que «agregar cliente» ────────────────────────────────────────
  it.each([
    ['la serialización del candado crudo (P2010/40001)', { code: 'P2010', meta: { code: '40001' } }],
    ['un bloqueo mutuo (P2010/40P01)', { code: 'P2010', meta: { code: '40P01' } }],
    ['la serialización de una consulta de modelo (P2034)', { code: 'P2034' }],
  ])('🔴 R3-3: %s se reintenta y el cliente se crea y liga UNA vez (antes: 500)', async (_c, forma) => {
    prismaMock.$transaction.mockRejectedValueOnce(Object.assign(new Error('conflicto'), forma))
    const r = await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)
    expect(r).toEqual({ orderCustomers: LISTA, loyalty: SELLO })
    expect(prismaMock.customer.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 R3-3: un P2002 que NO es correo/teléfono (el primario de otro a la vez) se reintenta bajo el candado', async () => {
    prismaMock.$transaction.mockRejectedValueOnce(choque(['orderId']))
    prismaMock.orderCustomer.findFirst.mockResolvedValue({ id: 'oc-otro', customerId: 'cust-otro' } as any)
    const r = await createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)
    expect(r.orderCustomers).toEqual(LISTA)
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith({ data: { orderId: 'order-1', customerId: 'nuevo', isPrimary: false } })
  })

  it.each([
    ['correo', ['venueId', 'email'], 'Ya existe un cliente con ese email en este venue'],
    ['teléfono', ['venueId', 'phone'], 'Ya existe un cliente con ese teléfono en este venue'],
  ])('regresión R3-3: un P2002 por %s duplicado (carrera) sigue siendo su 400 específico, sin reintentar', async (_c, target, mensaje) => {
    prismaMock.$transaction.mockRejectedValueOnce(choque(target))
    await expect(createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)).rejects.toThrow(mensaje)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('R3-3: el reintento tiene tope: conflicto persistente ⇒ 400, sin sello', async () => {
    const c = { code: 'P2010', meta: { code: '40001' } }
    for (let i = 0; i < 5; i++) prismaMock.$transaction.mockRejectedValueOnce(Object.assign(new Error('conflicto'), c))
    await expect(createAndAddCustomerToOrder(VENUE, 'order-1', { firstName: 'Dany' }, 'staff-1', CON_PERMISO)).rejects.toThrow(
      'Conflicto de concurrencia persistente',
    )
    expect(mockLate).not.toHaveBeenCalled()
  })

  it('regresión: teléfono repetido ⇒ 400, sin alta ni lealtad', async () => {
    prismaMock.customer.findUnique.mockResolvedValue({ id: 'ya-existe' } as any)
    await expect(createAndAddCustomerToOrder(VENUE, 'order-1', { phone: '5543453965' }, 'staff-1', CON_PERMISO)).rejects.toThrow(
      'Ya existe un cliente con ese teléfono en este venue',
    )
    expect(prismaMock.customer.create).not.toHaveBeenCalled()
    expect(mockReabrir).not.toHaveBeenCalled()
    expect(mockLate).not.toHaveBeenCalled()
  })
})
