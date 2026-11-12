/**
 * 🔴 Ligas de pago: la lealtad de una liga pagada se RECUPERA si el proceso muere entre el cobro y el sello.
 *
 * Antes la liga acreditaba con `updateCustomerMetrics` + `earnPoints` sueltos después del commit y nunca dejaba la venta
 * marcada (`loyaltyEligibleAt`): si el proceso moría en medio, el reconciliador de lealtad (que sólo busca ventas con
 * `loyaltyEligibleAt` y sin `loyaltyProcessedAt`) no la veía y el cliente perdía su sello y sus puntos para siempre.
 *
 * Ahora la venta nace con su marca en la MISMA transacción que la deja pagada (sólo si hay cliente: sin cliente no hay nada
 * que recuperar), y la lealtad en línea pasa por el otorgamiento compartido, que la cierra al terminar. El reconciliador corre
 * de verdad aquí (con la fila de la orden doblada por `tablaDeUnaVenta`, cuyo `where` sí se evalúa).
 *
 * También (Codex r3 #1): los renglones de una liga de productos guardan la categoría del producto, como los demás canales.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('nanoid', () => ({ nanoid: jest.fn(() => 'abc12345') }))
const mockBlumonService = {
  tokenizeCard: jest.fn().mockResolvedValue({ token: 'tok_test_123', maskedPan: '424242******4242', cardBrand: 'VISA' }),
  authorizePayment: jest.fn().mockResolvedValue({ transactionId: 'txn_test_123', authorizationCode: 'AUTH123' }),
}
jest.mock('@/services/sdk/blumon-ecommerce.service', () => ({ getBlumonEcommerceService: jest.fn(() => mockBlumonService) }))
jest.mock('@/services/dashboard/productInventoryIntegration.service', () => ({ deductInventoryForProduct: jest.fn() }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn(),
}))
const mockEarnPoints = jest.fn()
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({
  __esModule: true,
  earnPoints: (...a: unknown[]) => mockEarnPoints(...a),
}))
const mockMetrics = jest.fn()
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  __esModule: true,
  updateCustomerMetrics: (...a: unknown[]) => mockMetrics(...a),
}))
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { tablaDeUnaVenta, type FilaDeLealtad } from '../../../__helpers__/ordenConMarcasDeLealtad'
import {
  categoriasDeLaLiga,
  completeCharge,
  finalizeMercadoPagoCheckout,
  finalizePaymentLinkCheckout,
} from '@/services/dashboard/paymentLink.service'
import { LoyaltyReconciliationJob } from '@/jobs/loyalty-reconciliation.job'

const VENUE = 'venue-123'
const STAFF = 'staff-creador-de-la-liga'
const CLIENTE = 'cus-registrado-1'
const ORDEN = 'order-liga-1'

const liga = (purpose = 'PAYMENT') => ({
  id: 'pl-123',
  shortCode: 'abc12345',
  venueId: VENUE,
  purpose,
  createdById: STAFF,
  attributions: [],
})
const base = {
  id: 'session-db-123',
  ecommerceMerchantId: 'merchant-123',
  paymentLinkId: 'pl-123',
  currency: 'MXN',
  description: 'Liga',
  customerEmail: 'ana@example.com',
  customerPhone: null,
  customerName: 'Ana',
  attributedCustomerId: null,
  status: 'PROCESSING',
  paymentId: null,
  applicationFeeCents: 0,
  expiresAt: new Date(Date.now() + 86_400_000),
  completedAt: null,
  blumonCheckoutId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}
const sesionBlumon = (amount = 100, metadata: Record<string, unknown> = {}, purpose = 'PAYMENT') => ({
  ...base,
  sessionId: 'cs_pl_test123',
  amount: new Decimal(amount),
  metadata: { cardToken: 'tok_test_123', maskedPan: '4242', cardBrand: 'VISA', cvv: '123', ...metadata },
  paymentLink: liga(purpose),
  ecommerceMerchant: { id: 'merchant-123', sandboxMode: true, providerCredentials: { accessToken: 't' }, provider: { code: 'BLUMON' } },
})
const sesionStripe = (amount = 100, metadata: Record<string, unknown> = {}, purpose = 'PAYMENT') => ({
  ...base,
  sessionId: 'cs_pl_test123',
  amount: new Decimal(amount),
  metadata,
  paymentLink: liga(purpose),
  ecommerceMerchant: { id: 'merchant-123', providerCredentials: {}, provider: { code: 'STRIPE_CONNECT' } },
})
const sesionMp = (amount = 100, metadata: Record<string, unknown> = {}, purpose = 'PAYMENT') => ({
  ...base,
  sessionId: 'mp_sess_1',
  amount: new Decimal(amount),
  metadata,
  paymentLink: liga(purpose),
  ecommerceMerchant: { id: 'merchant-123', venueId: VENUE },
})

const CANALES = {
  Stripe: {
    sesion: sesionStripe,
    pagar: () => finalizePaymentLinkCheckout({ stripeSessionId: 'cs_pl_test123', paymentIntentId: 'pi_1' }),
  },
  Blumon: { sesion: sesionBlumon, pagar: () => completeCharge('abc12345', 'cs_pl_test123') },
  MercadoPago: { sesion: sesionMp, pagar: () => finalizeMercadoPagoCheckout({ sessionId: 'mp_sess_1', mpPaymentId: 777 }) },
} as const
type Canal = keyof typeof CANALES

/** La orden que la liga crea, como fila con sus marcas de lealtad (la que leen el cierre y el reconciliador). */
let fila: FilaDeLealtad | null = null
let creadaDentroDeLaTransaccion: boolean | null = null
let dentro = false
const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0][0].data

function prepararCobro(canal: Canal, sesion: Record<string, unknown>) {
  prismaMock.checkoutSession.findUnique.mockReset()
  prismaMock.checkoutSession.findUnique.mockResolvedValueOnce(sesion as any)
  // MercadoPago vuelve a leer la sesión DENTRO de la transacción: todavía sin pago.
  if (canal === 'MercadoPago') prismaMock.checkoutSession.findUnique.mockResolvedValueOnce({ paymentId: null } as any)
}

async function reconciliar() {
  // La foto del beneficiario que lee el envoltorio de reembolsos: la venta no le ha dado nada a nadie.
  prismaMock.$queryRaw.mockResolvedValue([{ staffId: fila?.loyaltyStaffId ?? null, primario: null, clientes: 0, sellos: [], puntos: [] }])
  const tabla = tablaDeUnaVenta(fila!)
  const job = new LoyaltyReconciliationJob({
    prisma: { order: tabla, payment: prismaMock.payment } as any,
    cron: { start: jest.fn(), stop: jest.fn() },
    now: () => new Date(),
    barrerCupones: async () => 0,
    barrerWallet: (async () => undefined) as any,
  })
  return job.runNow()
}

/** `updateCustomerMetrics` real deduplica por (cliente, venta) con `CustomerOrderMetric` (customer.dashboard.service.ts). */
const visitasAplicadas = new Map<string, number>()
/** `earnPoints` real deduplica por (cliente, venta, EARN) con índice único. */
const puntosOtorgados = new Map<string, number>()

beforeEach(() => {
  fila = null
  creadaDentroDeLaTransaccion = null
  dentro = false
  visitasAplicadas.clear()
  puntosOtorgados.clear()
  mockMetrics.mockReset()
  mockMetrics.mockImplementation(async (customerId: string, monto: number, orderId: string) => {
    const llave = `${customerId}:${orderId}`
    if (!visitasAplicadas.has(llave)) visitasAplicadas.set(llave, monto)
  })
  mockEarnPoints.mockReset()
  mockEarnPoints.mockImplementation(async (_v: string, customerId: string, monto: number, orderId: string) => {
    const llave = `${customerId}:${orderId}`
    if (!puntosOtorgados.has(llave)) puntosOtorgados.set(llave, monto)
    return { pointsEarned: Math.floor(monto), newBalance: Math.floor(monto) }
  })
  prismaMock.$transaction.mockImplementation((async (cb: any) => {
    dentro = true
    try {
      return await cb(prismaMock)
    } finally {
      dentro = false
    }
  }) as any)
  prismaMock.checkoutSession.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.checkoutSession.update.mockResolvedValue({} as any)
  prismaMock.paymentLink.update.mockResolvedValue({} as any)
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-1' } as any)
  prismaMock.customer.findFirst.mockReset()
  prismaMock.customer.findFirst.mockResolvedValue({ id: CLIENTE } as any)
  prismaMock.orderCustomer.findMany.mockResolvedValue([])
  prismaMock.orderItem.findFirst.mockResolvedValue(null)
  prismaMock.exchange.findUnique.mockResolvedValue(null)
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.product.findMany.mockReset()
  prismaMock.order.create.mockImplementation((async ({ data }: any) => {
    creadaDentroDeLaTransaccion = dentro
    fila = {
      id: ORDEN,
      venueId: data.venueId,
      total: new Decimal(data.total),
      tipAmount: new Decimal(data.tipAmount ?? 0),
      loyaltyEligibleAt: data.loyaltyEligibleAt ?? null,
      loyaltyProcessedAt: null,
      loyaltyProcessingAt: null,
      loyaltyLastError: null,
      loyaltyAttempts: 0,
      loyaltyStaffId: data.loyaltyStaffId ?? null,
      customer: data.customerId ? { id: data.customerId, firstName: null, lastName: null } : null,
      clientes: 0,
    }
    return { id: ORDEN, orderNumber: 'PL-1', items: [] }
  }) as any)
  // El cierre y el error de la lealtad escriben sobre la MISMA fila (con su `where` evaluado).
  prismaMock.order.updateMany.mockImplementation((async (args: any) =>
    fila ? tablaDeUnaVenta(fila).updateMany(args) : { count: 0 }) as any)
})

afterAll(() => {
  prismaMock.$transaction.mockImplementation(((cb: any) => cb(prismaMock)) as any)
})

describe('liga de pago · la lealtad se recupera si el proceso muere', () => {
  it.each(Object.keys(CANALES) as Canal[])('%s: pagar una liga deja loyaltyEligibleAt en la misma transacción, sin cajero', async canal => {
    prepararCobro(canal, CANALES[canal].sesion())

    await CANALES[canal].pagar()

    const datos = datosDeLaOrden()
    expect(datos.paymentStatus).toBe('PAID')
    expect(datos.loyaltyEligibleAt).toBeInstanceOf(Date)
    expect(creadaDentroDeLaTransaccion).toBe(true)
    // La liga no tiene cajero: `createdById` es quien CREÓ la liga (Staff.id), no un StaffVenue.id.
    expect(datos.loyaltyStaffId ?? null).toBeNull()
  })

  it('una liga anónima (sin cliente) no deja obligación: no hay nada que recuperar', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(null)
    prepararCobro('Blumon', sesionBlumon())

    await completeCharge('abc12345', 'cs_pl_test123')

    expect(datosDeLaOrden()).not.toHaveProperty('loyaltyEligibleAt')
    expect(mockEarnPoints).not.toHaveBeenCalled()
    expect(mockMetrics).not.toHaveBeenCalled()
  })

  it.each(Object.keys(CANALES) as Canal[])(
    '%s: liga pagada con éxito en línea marca loyaltyProcessedAt y el reconciliador ya no la toma (métricas una sola vez)',
    async canal => {
      prepararCobro(canal, CANALES[canal].sesion())

      await CANALES[canal].pagar()

      expect(fila!.loyaltyProcessedAt).toBeInstanceOf(Date)
      const vuelta = await reconciliar()

      expect(vuelta.scanned).toBe(0)
      expect(mockMetrics).toHaveBeenCalledTimes(1)
      expect(mockEarnPoints).toHaveBeenCalledTimes(1)
      // Sin cajero: el quinto argumento (StaffVenue.id) va vacío, nunca el Staff.id de quien creó la liga.
      expect(mockEarnPoints.mock.calls[0][4]).toBeUndefined()
    },
  )

  it('si el otorgamiento en línea falla, el reconciliador otorga sello y puntos una vez', async () => {
    prepararCobro('Blumon', sesionBlumon())
    mockEarnPoints.mockRejectedValueOnce(new Error('pool agotado'))

    const cobro = await completeCharge('abc12345', 'cs_pl_test123')

    expect(cobro.status).toBe('COMPLETED')
    expect(fila!.loyaltyProcessedAt).toBeNull()
    expect(fila!.loyaltyLastError).toMatch(/loyalty:/)

    const primera = await reconciliar()
    const segunda = await reconciliar()

    expect(primera).toEqual(expect.objectContaining({ scanned: 1, applied: 1, failed: 0 }))
    expect(segunda.scanned).toBe(0)
    expect(fila!.loyaltyProcessedAt).toBeInstanceOf(Date)
    expect([...puntosOtorgados.entries()]).toEqual([[`${CLIENTE}:${ORDEN}`, 100]])
    // La visita se aplicó UNA vez (en línea); la recuperación no la duplica.
    expect([...visitasAplicadas.entries()]).toEqual([[`${CLIENTE}:${ORDEN}`, 100]])
    // La recuperación tampoco inventa un cajero.
    expect(mockEarnPoints.mock.calls.every(c => c[4] === undefined)).toBe(true)
  })

  it('el monto base de los puntos es el mismo que hoy: $500 con $50 de propina dan puntos sobre $450, en línea y al recuperar', async () => {
    prepararCobro('Blumon', sesionBlumon(500, { tipAmount: 50 }))
    await completeCharge('abc12345', 'cs_pl_test123')
    // (venueId, cliente, base, venta): lo mismo que hoy; el quinto (cajero) va vacío en ambos.
    expect(mockEarnPoints.mock.calls[0].slice(0, 4)).toEqual([VENUE, CLIENTE, 450, ORDEN])
    expect(mockEarnPoints.mock.calls[0][4]).toBeUndefined()
    expect(mockMetrics).toHaveBeenCalledWith(CLIENTE, 450, ORDEN, VENUE)

    // La misma venta, recuperada por el reconciliador tras una caída.
    puntosOtorgados.clear()
    fila!.loyaltyProcessedAt = null
    await reconciliar()
    expect([...puntosOtorgados.values()]).toEqual([450])
  })

  it.each(Object.keys(CANALES) as Canal[])('%s: los renglones de una liga de productos guardan la categoría del producto', async canal => {
    const items = [
      { productId: 'prod-cafe', productName: 'Café', quantity: 2, unitPrice: 50, modifiers: [] },
      { productId: 'prod-pan', productName: 'Pan', quantity: 1, unitPrice: 30, modifiers: [] },
    ]
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'prod-cafe', category: { name: 'Bebidas' } },
      { id: 'prod-pan', category: { name: 'Panadería' } },
    ] as any)
    prepararCobro(canal, CANALES[canal].sesion(130, { items }, 'ITEM'))

    await CANALES[canal].pagar()

    const renglones = datosDeLaOrden().items.create
    expect(renglones.map((r: any) => [r.productId, r.categoryName])).toEqual([
      ['prod-cafe', 'Bebidas'],
      ['prod-pan', 'Panadería'],
    ])
    // Sólo los productos de la liga y del negocio.
    expect(prismaMock.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: VENUE, id: { in: ['prod-cafe', 'prod-pan'] } }) }),
    )
  })

  it('un renglón malformado del snapshot no lanza: el helper devuelve un mapa vacío', async () => {
    const mapa = await categoriasDeLaLiga(VENUE, [null as any, { productId: 'prod-cafe' } as any])

    expect(mapa.size).toBe(0)
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
  })

  it('si leer las categorías falla, la venta cobrada se registra igual (sin categoría)', async () => {
    const items = [{ productId: 'prod-cafe', productName: 'Café', quantity: 1, unitPrice: 100, modifiers: [] }]
    prismaMock.product.findMany.mockRejectedValue(new Error('conexión perdida'))
    prepararCobro('Blumon', sesionBlumon(100, { items }, 'ITEM'))

    const cobro = await completeCharge('abc12345', 'cs_pl_test123')

    expect(cobro.status).toBe('COMPLETED')
    expect(datosDeLaOrden().items.create[0].categoryName).toBeNull()
  })
})
