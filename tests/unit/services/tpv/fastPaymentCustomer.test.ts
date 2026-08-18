/**
 * El cobro rápido (`POST /fast`) debe ACEPTAR y PERSISTIR el cliente de la venta.
 *
 * 🔴 El defecto que ancla esta suite (confirmado por dos auditorías independientes y
 * reproducido en un POS Android real): el cajero seleccionaba cliente, cobraba $100, y
 * la orden `FAST-*` nacía con `customerId NULL`. Se perdían historial, CFDI y
 * atribución. Y no era sólo del cliente móvil: el server ni siquiera aceptaba el dato —
 *
 *   1. `recordPaymentBodySchema` no declaraba `customerId`, y
 *   2. `validation.ts` REEMPLAZA `req.body` con lo parseado por Zod,
 *
 * así que el campo se descartaba EN SILENCIO antes de llegar al servicio.
 *
 * 🔴 Por qué un cliente inválido NO rechaza el cobro: cuando `/fast` se llama, el dinero
 * YA se recibió (efectivo en mano, o tarjeta ya aprobada por Blumon). Un 404 aquí
 * mandaría el cobro a la cola de reintentos de la TPV con un error PERMANENTE — el
 * cobro nunca aterriza y el cajero se queda con un banner que no puede quitar. Es la
 * misma trampa ya documentada en `terminalPaymentRequestId` (min(1), no min(8)) y el
 * mismo criterio que `createOrderWithItems` usa con un `reservationId` desconocido:
 * se tira el vínculo con aviso, nunca la venta. Contrasta a propósito con `POST /orders`,
 * que SÍ lanza `NotFoundError`: ahí todavía no se ha movido dinero, así que fallar es
 * gratis.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/utils/staff-venue.util', () => ({
  __esModule: true,
  validateStaffVenue: jest.fn().mockResolvedValue('staff-1'),
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { broadcastToVenue: jest.fn() },
  socketManager: { broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  __esModule: true,
  generateDigitalReceipt: jest.fn(),
}))
jest.mock('@/services/payments/transactionCost.service', () => ({
  __esModule: true,
  createTransactionCost: jest.fn(),
}))
jest.mock('@/services/dashboard/commission/commission-calculation.service', () => ({
  __esModule: true,
  createCommissionForPayment: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({
  __esModule: true,
  runAutoReorderForVenue: jest.fn().mockResolvedValue({ ran: false }),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({
  __esModule: true,
  onOrderPaid: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue({ id: 'posting-test', status: 'PENDING' }),
  applySalePosting: jest.fn(),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import { linkCustomerToExistingOrder } from '@/services/tpv/fastPaymentCustomer'
import { recordPaymentBodySchema } from '@/schemas/tpv.schema'

const prismaMock = prisma as any

const VENUE = 'venue-1'
const CLIENTE = {
  id: 'cust-1',
  venueId: VENUE,
  firstName: 'Ana',
  lastName: 'Ruiz',
  email: 'ana@ejemplo.mx',
  phone: '5512345678',
}

/** Payload mínimo de una venta rápida en efectivo. */
function cobroRapido(extra: Record<string, unknown> = {}) {
  return {
    amount: 10000, // $100.00 en centavos
    tip: 0,
    status: 'COMPLETED',
    method: 'CASH',
    source: 'TPV',
    splitType: 'FULLPAYMENT',
    staffId: 'staff-1',
    paidProductsId: [],
    currency: 'MXN',
    isInternational: false,
    ...extra,
  } as any
}

let orders: any[] = []
let payments: any[] = []

function installFakes() {
  orders = []
  payments = []

  prismaMock.order.create.mockImplementation(async ({ data }: any) => {
    const created = { id: `fast-order-${orders.length + 1}`, venueId: VENUE, orderNumber: data.orderNumber, ...data }
    orders.push(created)
    return created
  })
  prismaMock.payment.create.mockImplementation(async ({ data }: any) => {
    const created = {
      id: `pay-${payments.length + 1}`,
      feeAmount: 0,
      netAmount: 0,
      tipAmount: 0,
      processedBy: null,
      receipts: [],
      ...data,
    }
    payments.push(created)
    return created
  })
  prismaMock.payment.findUnique.mockResolvedValue(null)
  prismaMock.payment.findFirst.mockResolvedValue(null)
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vt-1' })
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' })
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.customer.findUnique.mockResolvedValue(null)
  prismaMock.order.findFirst.mockResolvedValue(null)
  prismaMock.order.update.mockResolvedValue({ id: 'fast-order-1' })
  prismaMock.activityLog.create.mockResolvedValue({ id: 'log-1' })
  // `cashDrawerSession` y `orderCustomer` no existen en el prismaMock compartido
  // (tests/__helpers__/setup.ts); se crean aquí en vez de tocar el helper global,
  // que usan ~200 suites.
  prismaMock.cashDrawerSession = prismaMock.cashDrawerSession ?? {}
  prismaMock.cashDrawerSession.findFirst = jest.fn().mockResolvedValue(null)
  prismaMock.orderCustomer = prismaMock.orderCustomer ?? {}
  prismaMock.orderCustomer.findUnique = jest.fn().mockResolvedValue(null)
  prismaMock.orderCustomer.findFirst = jest.fn().mockResolvedValue(null)
  prismaMock.orderCustomer.findMany = jest.fn().mockResolvedValue([])
  prismaMock.orderCustomer.create = jest.fn().mockResolvedValue({ id: 'oc-1' })
  prismaMock.orderCustomer.update = jest.fn().mockResolvedValue({ id: 'oc-1' })
  // Sólo para el camino de delegación (recordOrderPayment corre de verdad).
  prismaMock.terminalPaymentRequest.findUnique.mockResolvedValue(null)
  prismaMock.terminalPaymentRequest.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  prismaMock.areaTicketInventoryReservation = prismaMock.areaTicketInventoryReservation ?? {}
  prismaMock.areaTicketInventoryReservation.findMany = jest.fn().mockResolvedValue([])
}

/** El P2002 que lanza Postgres al chocar contra el índice único parcial del primario. */
function choqueDePrimario() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'OrderCustomer_orderId_isPrimary_unique' },
  })
}

/** Los datos con los que se creó la orden FAST (lo que de verdad se persistió). */
function datosDeLaOrdenFast() {
  return prismaMock.order.create.mock.calls[0]?.[0]?.data
}

describe('recordFastPayment — el CLIENTE de la venta rápida', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    installFakes()
  })

  // ---------------------------------------------------------------------------
  // (e) La frontera: el schema tiene que dejar PASAR el campo.
  // ---------------------------------------------------------------------------
  it('el schema conserva customerId (hoy el middleware lo descartaba en silencio)', () => {
    const parsed = recordPaymentBodySchema.parse({ body: cobroRapido({ venueId: 'cmvenue00000000000000000', customerId: 'cust-1' }) })

    // 🔴 Zod hace strip por defecto y `validation.ts` reasigna `req.body` con ESTE
    // objeto: si el campo no está declarado, desaparece antes de tocar el servicio.
    expect((parsed.body as any).customerId).toBe('cust-1')
  })

  it('el schema acepta la venta anónima: sin customerId y con null explícito', () => {
    const sinCampo = recordPaymentBodySchema.parse({ body: cobroRapido({ venueId: 'cmvenue00000000000000000' }) })
    expect((sinCampo.body as any).customerId).toBeUndefined()

    // iOS manda `null` explícito en las ventas sin cliente (mismo patrón que
    // `externalSource`): exigir string|undefined rechazaría cada cobro anónimo del iPad.
    const conNull = recordPaymentBodySchema.parse({ body: cobroRapido({ venueId: 'cmvenue00000000000000000', customerId: null }) })
    expect((conNull.body as any).customerId).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // (a) Camino feliz: el cliente queda en la orden, en la MISMA transacción.
  // ---------------------------------------------------------------------------
  it('con customerId válido, la orden FAST nace con el cliente y su OrderCustomer primario', async () => {
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1' }), 'user-1')

    const data = datosDeLaOrdenFast()
    expect(data.customerId).toBe('cust-1')
    // Vínculo moderno (`OrderCustomer`) creado en el MISMO `order.create` — no en una
    // segunda petición ni en un attach posterior, que podría fallar DESPUÉS de
    // registrar el dinero y dejar la venta sin cliente otra vez.
    expect(data.orderCustomers).toEqual({ create: [{ customerId: 'cust-1', isPrimary: true }] })
    // Denormalizado, igual que `attachCustomerToOrder`: el recibo y el CFDI lo leen de aquí.
    expect(data.customerName).toBe('Ana Ruiz')
    expect(data.customerPhone).toBe('5512345678')
    expect(data.customerEmail).toBe('ana@ejemplo.mx')

    expect(result.customerLink).toEqual({
      status: 'LINKED',
      customerId: 'cust-1',
      requestedCustomerId: 'cust-1',
      warning: null,
    })
  })

  it('el cliente se busca SIEMPRE contra el venue del token (aislamiento de inquilino)', async () => {
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)

    await recordFastPayment(VENUE, cobroRapido({ customerId: '  cust-1  ' }), 'user-1')

    // Se normaliza el id antes de consultar (el POS puede mandar espacios).
    expect(prismaMock.customer.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'cust-1' } }))
    expect(datosDeLaOrdenFast().customerId).toBe('cust-1')
  })

  // ---------------------------------------------------------------------------
  // (b) REGRESIÓN: sin cliente, la venta rápida se comporta EXACTAMENTE como hoy.
  // ---------------------------------------------------------------------------
  it('sin customerId la venta rápida es idéntica a hoy: ni cliente, ni consulta de más', async () => {
    const result: any = await recordFastPayment(VENUE, cobroRapido(), 'user-1')

    const data = datosDeLaOrdenFast()
    expect(data.customerId).toBeUndefined()
    expect(data.orderCustomers).toBeUndefined()
    // Ni una consulta extra en el camino más caliente del producto.
    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled()

    expect(payments).toHaveLength(1)
    expect(result.customerLink).toEqual({
      status: 'NOT_REQUESTED',
      customerId: null,
      requestedCustomerId: null,
      warning: null,
    })
  })

  // ---------------------------------------------------------------------------
  // (c) Cliente inválido: el DINERO se registra igual, el vínculo se tira con aviso.
  // ---------------------------------------------------------------------------
  it('un cliente de OTRO venue NO se vincula y la venta SÍ se registra (anónima + aviso)', async () => {
    // El id existe, pero pertenece a otro negocio. Vincularlo sería una fuga de
    // inquilino; rechazar el cobro sería perder dinero ya recibido.
    prismaMock.customer.findUnique.mockResolvedValue({ ...CLIENTE, venueId: 'venue-AJENO' })

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1' }), 'user-1')

    const data = datosDeLaOrdenFast()
    expect(data.customerId).toBeNull()
    expect(data.orderCustomers).toBeUndefined()
    expect(payments).toHaveLength(1) // el dinero SÍ quedó registrado

    expect(result.customerLink.status).toBe('NOT_FOUND')
    expect(result.customerLink.customerId).toBeNull()
    expect(result.customerLink.requestedCustomerId).toBe('cust-1')
    expect(result.customerLink.warning).toMatch(/cliente/i)
  })

  it('un customerId inexistente tampoco tumba el cobro', async () => {
    prismaMock.customer.findUnique.mockResolvedValue(null)

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'no-existe' }), 'user-1')

    expect(payments).toHaveLength(1)
    expect(datosDeLaOrdenFast().customerId).toBeNull()
    expect(result.customerLink.status).toBe('NOT_FOUND')
  })

  it('si la consulta del cliente truena, el cobro se registra igual (fail-open)', async () => {
    // Un fallo de infraestructura jamás puede impedir registrar dinero que YA se cobró.
    prismaMock.customer.findUnique.mockRejectedValue(new Error('connection refused'))

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1' }), 'user-1')

    expect(payments).toHaveLength(1)
    expect(result.customerLink.status).toBe('UNVERIFIED')
    expect(result.customerLink.customerId).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // (d) Idempotencia: un reintento con cliente RELLENA la venta que nació anónima.
  // ---------------------------------------------------------------------------
  it('reintento idempotente con cliente: NO duplica el cobro y RELLENA la orden que nació anónima', async () => {
    // Codex lo advirtió: "una petición idempotente ya creada como anónima no se
    // arreglará automáticamente al reenviarla con cliente". Rellenar un hueco es
    // aditivo y no toca dinero, así que sí se arregla.
    const pagoPrevio = { id: 'pay-existente', orderId: 'fast-order-previa', receipts: [], idempotencyKey: 'idem-1' }
    prismaMock.payment.findUnique.mockResolvedValue(pagoPrevio)
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'fast-order-previa', venueId: VENUE, customerId: null })

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1', idempotencyKey: 'idem-1' }), 'user-1')

    // El dinero NO se vuelve a registrar: se devuelve el pago existente.
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(result.id).toBe('pay-existente')

    // …y el cliente sí se rellena sobre la orden que ya existía.
    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'fast-order-previa' },
        data: expect.objectContaining({ customerId: 'cust-1' }),
      }),
    )
    expect(prismaMock.orderCustomer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { orderId: 'fast-order-previa', customerId: 'cust-1', isPrimary: true } }),
    )
    expect(result.customerLink.status).toBe('LINKED')
  })

  it('reintento idempotente NUNCA reasigna una venta que ya tenía OTRO cliente', async () => {
    // Reatribuir una venta ya cerrada por un payload reenviado sería mover el
    // historial (y el CFDI) de un cliente a otro sin que nadie lo pida.
    const pagoPrevio = { id: 'pay-existente', orderId: 'fast-order-previa', receipts: [], idempotencyKey: 'idem-1' }
    prismaMock.payment.findUnique.mockResolvedValue(pagoPrevio)
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'fast-order-previa', venueId: VENUE, customerId: 'OTRO-cliente' })

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1', idempotencyKey: 'idem-1' }), 'user-1')

    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(result.customerLink.status).toBe('CONFLICT')
    expect(result.customerLink.customerId).toBe('OTRO-cliente')
    expect(result.customerLink.requestedCustomerId).toBe('cust-1')
  })

  it('reintento idempotente SIN cliente no toca la orden existente', async () => {
    const pagoPrevio = { id: 'pay-existente', orderId: 'fast-order-previa', receipts: [], idempotencyKey: 'idem-1' }
    prismaMock.payment.findUnique.mockResolvedValue(pagoPrevio)

    const result: any = await recordFastPayment(VENUE, cobroRapido({ idempotencyKey: 'idem-1' }), 'user-1')

    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled()
    expect(result.customerLink.status).toBe('NOT_REQUESTED')
  })

  // ---------------------------------------------------------------------------
  // El CLIENTE PRIMARIO: `Order.customerId` NO es la única señal de "ya tiene dueño".
  //
  // 🔴 `addCustomerToOrder` de la TPV (`order.tpv.service.ts`) escribe `OrderCustomer`
  // y JAMÁS toca `Order.customerId`. Mirar sólo el campo legacy hace invisible a un
  // cliente puesto desde la terminal — y encima choca contra el índice único parcial
  // `OrderCustomer_orderId_isPrimary_unique` (migración 20251211171115).
  // ---------------------------------------------------------------------------
  it('un cliente puesto desde la TPV (sólo OrderCustomer, sin Order.customerId) cuenta como dueño → CONFLICT', async () => {
    const pagoPrevio = { id: 'pay-existente', orderId: 'fast-order-previa', receipts: [], idempotencyKey: 'idem-1' }
    prismaMock.payment.findUnique.mockResolvedValue(pagoPrevio)
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    // Estado REAL alcanzable: la TPV agregó al cliente B; `Order.customerId` sigue null.
    prismaMock.order.findFirst.mockResolvedValue({ id: 'fast-order-previa', venueId: VENUE, customerId: null })
    prismaMock.orderCustomer.findMany.mockResolvedValue([{ id: 'oc-B', customerId: 'cust-B', isPrimary: true }])

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1', idempotencyKey: 'idem-1' }), 'user-1')

    // Ni se intenta escribir: antes se estrellaba contra el índice único.
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(result.customerLink.status).toBe('CONFLICT')
    expect(result.customerLink.customerId).toBe('cust-B')
  })

  it('si nuestro cliente ya estaba vinculado como NO primario y no hay primario, se PROMUEVE (no se duplica)', async () => {
    // Sin promover, la lealtad (que lee `isPrimary`) y los denormalizados de la orden
    // apuntarían a personas distintas: la atribución partida en dos.
    const pagoPrevio = { id: 'pay-existente', orderId: 'fast-order-previa', receipts: [], idempotencyKey: 'idem-1' }
    prismaMock.payment.findUnique.mockResolvedValue(pagoPrevio)
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'fast-order-previa', venueId: VENUE, customerId: null })
    prismaMock.orderCustomer.findMany.mockResolvedValue([{ id: 'oc-nuestro', customerId: 'cust-1', isPrimary: false }])

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1', idempotencyKey: 'idem-1' }), 'user-1')

    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    expect(prismaMock.orderCustomer.update).toHaveBeenCalledWith({ where: { id: 'oc-nuestro' }, data: { isPrimary: true } })
    expect(result.customerLink.status).toBe('LINKED')
  })

  it('con un primario AJENO ya existente, nuestra fila nueva NO se crea como primaria', async () => {
    // Caso de orden inconsistente: `Order.customerId` ya es NUESTRO cliente, pero el
    // primario es otro. No se toca nada — este camino no tiene autoridad para resolverlo.
    const pagoPrevio = { id: 'pay-existente', orderId: 'fast-order-previa', receipts: [], idempotencyKey: 'idem-1' }
    prismaMock.payment.findUnique.mockResolvedValue(pagoPrevio)
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'fast-order-previa', venueId: VENUE, customerId: 'cust-1' })
    prismaMock.orderCustomer.findMany.mockResolvedValue([{ id: 'oc-B', customerId: 'cust-B', isPrimary: true }])

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1', idempotencyKey: 'idem-1' }), 'user-1')

    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(result.customerLink.status).toBe('CONFLICT')
    expect(result.customerLink.customerId).toBe('cust-B')
  })

  it('si la orden ya está completa con NUESTRO cliente, es un no-op (ninguna escritura)', async () => {
    const pagoPrevio = { id: 'pay-existente', orderId: 'fast-order-previa', receipts: [], idempotencyKey: 'idem-1' }
    prismaMock.payment.findUnique.mockResolvedValue(pagoPrevio)
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'fast-order-previa', venueId: VENUE, customerId: 'cust-1' })
    prismaMock.orderCustomer.findMany.mockResolvedValue([{ id: 'oc-nuestro', customerId: 'cust-1', isPrimary: true }])

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1', idempotencyKey: 'idem-1' }), 'user-1')

    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(prismaMock.orderCustomer.create).not.toHaveBeenCalled()
    expect(result.customerLink.status).toBe('LINKED')
  })

  it('🔴 P2002 contra el índice único del primario ⇒ CONFLICT honesto, NUNCA "se registró sin cliente"', async () => {
    // 🔴 Este es el caso que un unit NO puede provocar de verdad: `prismaMock` no hace
    // cumplir un índice PARCIAL de Postgres. Se simula el P2002 que la base lanzaría, y
    // se afirma lo que de verdad importa: que el veredicto salga de RELEER la tabla y no
    // de adivinar. Antes devolvía UNVERIFIED con el texto "La venta se registró sin
    // cliente" — falso dos veces: el cliente sí se verificó y la venta sí tiene cliente.
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'orden-1', venueId: VENUE, customerId: null })
    // 1ª lectura: hueco. Tras el choque, la relectura revela al ganador de la carrera.
    prismaMock.orderCustomer.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'oc-B', customerId: 'cust-B', isPrimary: true }])
    prismaMock.$transaction.mockRejectedValueOnce(choqueDePrimario())

    const link = await linkCustomerToExistingOrder(VENUE, 'orden-1', 'cust-1')

    expect(link.status).toBe('CONFLICT')
    expect(link.customerId).toBe('cust-B')
    expect(link.warning).not.toMatch(/sin cliente/i)
  })

  it('P2002 cuando la carrera la ganó una petición idéntica ⇒ LINKED', async () => {
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'orden-1', venueId: VENUE, customerId: 'cust-1' })
    prismaMock.orderCustomer.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'oc-nuestro', customerId: 'cust-1', isPrimary: true }])
    prismaMock.$transaction.mockRejectedValueOnce(choqueDePrimario())

    const link = await linkCustomerToExistingOrder(VENUE, 'orden-1', 'cust-1')

    expect(link.status).toBe('LINKED')
    expect(link.customerId).toBe('cust-1')
  })

  // ---------------------------------------------------------------------------
  // 🔴 CARGA ESTRUCTURAL: `linkCustomerToExistingOrder` NO PUEDE LANZAR.
  //
  // En el camino de delegación (`payment.tpv.service.ts`) esta llamada vive DENTRO del
  // `try` cuyo `catch` cae a crear una venta FAST nueva. Si algún día lanzara, un fallo
  // al vincular un cliente podría convertirse en un SEGUNDO cobro. La propiedad se
  // afirma aquí explícitamente en vez de quedar como suposición.
  // ---------------------------------------------------------------------------
  describe('linkCustomerToExistingOrder nunca lanza (garantía anti-doble-cobro)', () => {
    const explota = () => new Error('connection refused')

    it('aunque truene la consulta del cliente', async () => {
      prismaMock.customer.findUnique.mockRejectedValue(explota())
      await expect(linkCustomerToExistingOrder(VENUE, 'orden-1', 'cust-1')).resolves.toMatchObject({ status: 'UNVERIFIED' })
    })

    it('aunque truene la lectura de la orden', async () => {
      prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
      prismaMock.order.findFirst.mockRejectedValue(explota())
      await expect(linkCustomerToExistingOrder(VENUE, 'orden-1', 'cust-1')).resolves.toMatchObject({ status: 'UNVERIFIED' })
    })

    it('aunque truene la lectura de OrderCustomer', async () => {
      prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
      prismaMock.order.findFirst.mockResolvedValue({ id: 'orden-1', venueId: VENUE, customerId: null })
      prismaMock.orderCustomer.findMany.mockRejectedValue(explota())
      await expect(linkCustomerToExistingOrder(VENUE, 'orden-1', 'cust-1')).resolves.toMatchObject({ status: 'UNVERIFIED' })
    })

    it('aunque truene la transacción de escritura', async () => {
      prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
      prismaMock.order.findFirst.mockResolvedValue({ id: 'orden-1', venueId: VENUE, customerId: null })
      prismaMock.$transaction.mockRejectedValueOnce(explota())
      await expect(linkCustomerToExistingOrder(VENUE, 'orden-1', 'cust-1')).resolves.toMatchObject({ status: 'UNVERIFIED' })
    })

    it('aunque el P2002 llegue y la RELECTURA también truene', async () => {
      prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
      prismaMock.order.findFirst.mockResolvedValueOnce({ id: 'orden-1', venueId: VENUE, customerId: null }).mockRejectedValue(explota())
      prismaMock.$transaction.mockRejectedValueOnce(choqueDePrimario())
      await expect(linkCustomerToExistingOrder(VENUE, 'orden-1', 'cust-1')).resolves.toMatchObject({ status: 'UNVERIFIED' })
    })
  })

  // ---------------------------------------------------------------------------
  // `customerLink` en LAS OTRAS SALIDAS. Son las de más riesgo justamente porque no
  // pasan por la creación de la venta: si una se olvidara, el POS recibiría `undefined`
  // y no tendría cómo distinguir "server viejo" de "no se vinculó".
  // ---------------------------------------------------------------------------
  it('SALIDA delegación (el cobro pertenece a una orden que ya existe): trae customerLink', async () => {
    prismaMock.terminalPaymentRequest.findUnique.mockResolvedValue({
      requestId: 'req-1',
      orderId: 'order-real',
      venueId: VENUE,
      status: 'CANCELLED',
    })
    // Orden real que hace COMPLETAR a recordOrderPayment sin disparar el pre-flight:
    // pago PARCIAL (total 1000 > 100 cobrados) ⇒ no hay deducción de inventario.
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-real',
      venueId: VENUE,
      splitType: null,
      items: [],
      payments: [],
      total: 1000,
      source: 'TPV',
      externalId: null,
    })
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'order-real', venueId: VENUE, customerId: null })

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1', terminalPaymentRequestId: 'req-1' }), 'user-1')

    // No se creó venta FAST sintética (delegó) …
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    // … y aun así el POS sabe qué pasó con su cliente.
    expect(result.customerLink).toMatchObject({ status: 'LINKED', customerId: 'cust-1', requestedCustomerId: 'cust-1' })
  })

  it('SALIDA referenceNumber (reintento legacy sin idempotencyKey): trae customerLink', async () => {
    prismaMock.payment.findFirst.mockResolvedValue({
      id: 'pay-legacy',
      orderId: 'fast-order-legacy',
      receipts: [],
      referenceNumber: 'REF-123',
    })
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'fast-order-legacy', venueId: VENUE, customerId: null })

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1', referenceNumber: 'REF-123' }), 'user-1')

    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(result.id).toBe('pay-legacy')
    expect(result.customerLink).toMatchObject({ status: 'LINKED', customerId: 'cust-1' })
  })

  it('SALIDA P2002 (ganador de la carrera del índice de idempotencia): trae customerLink', async () => {
    // La transacción del cobro pierde la carrera; el ganador se devuelve como si fuera
    // un reintento idempotente normal.
    const winner = { id: 'pay-winner', orderId: 'fast-order-winner', receipts: [], idempotencyKey: 'idem-race' }
    prismaMock.payment.findUnique.mockResolvedValueOnce(null).mockResolvedValue(winner)
    prismaMock.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['venueId', 'idempotencyKey'] },
      }),
    )
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'fast-order-winner', venueId: VENUE, customerId: null })

    const result: any = await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1', idempotencyKey: 'idem-race' }), 'user-1')

    expect(result.id).toBe('pay-winner')
    expect(result.customerLink).toMatchObject({ status: 'LINKED', customerId: 'cust-1' })
  })

  // ---------------------------------------------------------------------------
  // La cota del schema: acota el string SIN reintroducir un 400.
  // ---------------------------------------------------------------------------
  it('un customerId absurdamente largo se DESCARTA, no rechaza el cobro', () => {
    // Con BODY_JSON_LIMIT de 1 MB, sin cota un cliente empuja ~1 MB al findUnique y al
    // meta del logger en CADA cobro. Pero un 400 aquí tumbaría dinero ya recibido.
    const parsed = recordPaymentBodySchema.parse({
      body: cobroRapido({ venueId: 'cmvenue00000000000000000', customerId: 'x'.repeat(5000) }),
    })

    expect((parsed.body as any).customerId).toBeUndefined()
    // Y sobre todo: NO lanzó — el resto del cobro sigue intacto.
    expect((parsed.body as any).amount).toBe(10000)
  })

  it('un customerId de tipo equivocado tampoco rechaza el cobro', () => {
    const parsed = recordPaymentBodySchema.parse({
      body: cobroRapido({ venueId: 'cmvenue00000000000000000', customerId: { nope: true } }),
    })

    expect((parsed.body as any).customerId).toBeUndefined()
    expect((parsed.body as any).amount).toBe(10000)
  })
})

/**
 * 🔴 EL COBRO CON TARJETA: el cliente lo siembra el RELAY, no la terminal.
 *
 * En EFECTIVO el POS registra el cobro él mismo y manda `customerId` en el body, así que
 * la venta nace con cliente. Con TARJETA el camino es otro: el POS manda el cobro a la
 * terminal (`POST /mobile/venues/:venueId/terminal-payment`), la TPV cobra y registra el
 * dinero con SU propio payload (`POST /tpv/venues/:venueId/fast`) — que lleva
 * `terminalPaymentRequestId` pero NO lleva cliente. La TPV no conoce ese dato y no debe
 * conocerlo: sería PII viajando al aparato sin nadie que la consuma.
 *
 * Resultado hasta hoy: la MISMA venta, con el MISMO cliente elegido en pantalla, nacía
 * con cliente si se pagaba en efectivo y anónima si se pagaba con tarjeta.
 *
 * El arreglo no toca la TPV. El POS manda el cliente en el relay, se guarda en la fila de
 * arbitraje, y `recordFastPayment` la usa como fallback — la misma fila que ya lee para
 * decidir a qué venta pertenece el dinero.
 */
describe('recordFastPayment — el cliente SEMBRADO por la solicitud de la terminal', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    installFakes()
  })

  /** La fila de arbitraje que el POS dejó al mandar el cobro a la terminal. */
  function filaDeArbitraje(extra: Record<string, unknown> = {}) {
    prismaMock.terminalPaymentRequest.findUnique.mockResolvedValue({
      requestId: 'req-1',
      orderId: null,
      venueId: VENUE,
      status: 'COMPLETED',
      customerId: null,
      ...extra,
    })
  }

  it('la venta con TARJETA nace con el cliente aunque la TPV no lo mande', async () => {
    filaDeArbitraje({ customerId: 'cust-1' })
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)

    // Payload REAL de la TPV: trae `terminalPaymentRequestId` y NO trae `customerId`.
    const result: any = await recordFastPayment(VENUE, cobroRapido({ method: 'CREDIT_CARD', terminalPaymentRequestId: 'req-1' }), 'user-1')

    const data = datosDeLaOrdenFast()
    expect(data.customerId).toBe('cust-1')
    expect(data.orderCustomers).toEqual({ create: [{ customerId: 'cust-1', isPrimary: true }] })
    expect(result.customerLink).toMatchObject({ status: 'LINKED', customerId: 'cust-1' })

    // 🔴 El mock devuelve la fila entera pase lo que pase en el `select`; sin esta
    // aserción, olvidar `customerId: true` dejaría el test verde y la feature muerta
    // (Prisma devolvería `undefined` en producción).
    expect(prismaMock.terminalPaymentRequest.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ customerId: true }) }),
    )
  })

  it('el cliente del BODY gana sobre el de la fila', async () => {
    // El body es el dato MÁS FRESCO: si algún día la TPV empieza a mandarlo, o si es un
    // POS registrando el cobro directamente, ese cliente es el que el cajero acaba de
    // elegir — la fila puede llevar minutos escrita.
    filaDeArbitraje({ customerId: 'cust-DE-LA-FILA' })
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)

    await recordFastPayment(VENUE, cobroRapido({ customerId: 'cust-1', terminalPaymentRequestId: 'req-1' }), 'user-1')

    expect(prismaMock.customer.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'cust-1' } }))
    expect(datosDeLaOrdenFast().customerId).toBe('cust-1')
  })

  it('🔴 una fila de OTRO venue NO presta su cliente — la venta se registra anónima', async () => {
    // `requestId` es `@unique` GLOBAL y lo genera el cliente: dos inquilinos pueden
    // colisionar. Tomar el cliente de esa fila metería a una persona de otro negocio en
    // el historial (y el CFDI) de esta venta.
    filaDeArbitraje({ venueId: 'venue-AJENO', customerId: 'cust-del-vecino' })
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)

    const result: any = await recordFastPayment(VENUE, cobroRapido({ method: 'CREDIT_CARD', terminalPaymentRequestId: 'req-1' }), 'user-1')

    expect(datosDeLaOrdenFast().customerId).toBeUndefined()
    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled() // ni se consulta
    expect(payments).toHaveLength(1) // …pero el dinero SÍ se registra
    expect(result.customerLink.status).toBe('NOT_REQUESTED')
  })

  it('una fila SIN cliente deja la venta anónima, exactamente como hoy', async () => {
    filaDeArbitraje({ customerId: null })

    const result: any = await recordFastPayment(VENUE, cobroRapido({ method: 'CREDIT_CARD', terminalPaymentRequestId: 'req-1' }), 'user-1')

    expect(datosDeLaOrdenFast().customerId).toBeUndefined()
    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled()
    expect(result.customerLink.status).toBe('NOT_REQUESTED')
  })

  it('REGRESIÓN: sin terminalPaymentRequestId el camino queda idéntico — ni una consulta de más', async () => {
    const result: any = await recordFastPayment(VENUE, cobroRapido({ method: 'CREDIT_CARD' }), 'user-1')

    expect(prismaMock.terminalPaymentRequest.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.customer.findUnique).not.toHaveBeenCalled()
    expect(datosDeLaOrdenFast().customerId).toBeUndefined()
    expect(result.customerLink.status).toBe('NOT_REQUESTED')
  })

  it('el camino con orden EXISTENTE también usa el cliente sembrado', async () => {
    // El cajero mandó el cobro desde una cuenta abierta, canceló, y la terminal cobró
    // igual: el dinero es de ESA venta. El cliente que eligió también.
    filaDeArbitraje({ orderId: 'order-real', status: 'CANCELLED', customerId: 'cust-1' })
    prismaMock.order.findUnique.mockResolvedValue({
      id: 'order-real',
      venueId: VENUE,
      splitType: null,
      items: [],
      payments: [],
      total: 1000, // pago PARCIAL ⇒ sin pre-flight de inventario
      source: 'TPV',
      externalId: null,
    })
    prismaMock.customer.findUnique.mockResolvedValue(CLIENTE)
    prismaMock.order.findFirst.mockResolvedValue({ id: 'order-real', venueId: VENUE, customerId: null })

    const result: any = await recordFastPayment(VENUE, cobroRapido({ method: 'CREDIT_CARD', terminalPaymentRequestId: 'req-1' }), 'user-1')

    expect(prismaMock.order.create).not.toHaveBeenCalled() // delegó, no creó venta sintética
    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'order-real' }, data: expect.objectContaining({ customerId: 'cust-1' }) }),
    )
    expect(result.customerLink).toMatchObject({ status: 'LINKED', customerId: 'cust-1' })
  })

  it('un cliente sembrado que ya no existe NO tumba el cobro', async () => {
    // El id se guardó minutos antes; el cliente pudo borrarse. El dinero ya se cobró.
    filaDeArbitraje({ customerId: 'cust-borrado' })
    prismaMock.customer.findUnique.mockResolvedValue(null)

    const result: any = await recordFastPayment(VENUE, cobroRapido({ method: 'CREDIT_CARD', terminalPaymentRequestId: 'req-1' }), 'user-1')

    expect(payments).toHaveLength(1)
    expect(datosDeLaOrdenFast().customerId).toBeNull()
    expect(result.customerLink.status).toBe('NOT_FOUND')
  })

  it('si la lectura de la fila truena, el cobro se registra igual (fail-open)', async () => {
    prismaMock.terminalPaymentRequest.findUnique.mockRejectedValue(new Error('connection refused'))

    const result: any = await recordFastPayment(VENUE, cobroRapido({ method: 'CREDIT_CARD', terminalPaymentRequestId: 'req-1' }), 'user-1')

    expect(payments).toHaveLength(1)
    expect(result.customerLink.status).toBe('NOT_REQUESTED')
  })
})
