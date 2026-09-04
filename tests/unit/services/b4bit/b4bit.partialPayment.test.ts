/**
 * Cobro CRIPTO (b4bit): un abono parcial NO puede cerrar la cuenta.
 *
 * ── El defecto ──────────────────────────────────────────────────────────────
 * El webhook de confirmación (`status: 'CO'`) marcaba la orden así, sin mirar
 * nada más:
 *
 *     status: 'COMPLETED', paymentStatus: 'PAID',
 *     paidAmount: payment.amount,   ← PISA lo pagado antes, no acumula
 *     remainingBalance: 0,          ← incondicional
 *
 * Cuenta de $200, el cliente abona $50 en cripto → la cuenta se cierra PAGADA
 * con `paidAmount 50` y `remainingBalance 0`. Los $150 por cobrar DESAPARECEN y
 * no queda rastro de que faltaba dinero: ni el mesero, ni el corte, ni el
 * reporte se enteran.
 *
 * ── Lo que estos tests fijan ────────────────────────────────────────────────
 * 1. El saldo se recalcula desde los `Payment` COMPLETED **durables**, nunca
 *    desde `order.paidAmount` ni sumando `+= payment.amount` (un webhook
 *    repetido duplicaría el abono).
 * 2. Los efectos de "venta terminada" (`completedAt`, `status: COMPLETED`, el
 *    hook de referidos) ocurren SÓLO en la transición real a pagado.
 * 3. Un `CO` repetido no mueve los totales ni crea un segundo `Payment`.
 * 4. La INICIACIÓN no acepta una orden de otro venue ni una cuenta ya pagada.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────
// El servicio arrastra sockets, recibos y el guard de ventas al importarse.
// Nada de eso está bajo prueba: lo que se verifica es la aritmética del saldo.

jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    payment: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    orderItem: { findMany: jest.fn().mockResolvedValue([]) },
    venue: { findUnique: jest.fn() },
    venueCryptoConfig: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn().mockResolvedValue({ enableShifts: true }) },
    shift: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
    activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-without-shift' }) },
    terminal: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  }
  // El callback de la transacción recibe el MISMO cliente: así un test puede
  // afirmar sobre `order.updateMany` sin importar si corrió dentro o fuera.
  client.$transaction.mockImplementation((cb: any) => cb(client))
  return { __esModule: true, default: client }
})

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))

jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn().mockResolvedValue({ accessKey: 'recibo-test' }),
  generateReceiptUrl: jest.fn().mockReturnValue('https://recibo.test/abc'),
}))

jest.mock('@/services/venueSalesGuard', () => ({
  assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined),
}))

// El vale de inventario tiene su propia suite (`b4bit.inventoryPosting.test.ts`);
// aquí sólo se verifica que la liquidación no truene por su culpa.
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))

const onOrderPaid = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: (...a: any[]) => onOrderPaid(...a) }))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { initiateCryptoPayment, processWebhook } from '@/services/b4bit/b4bit.service'
import type { B4BitWebhookPayload } from '@/services/b4bit/types'

const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock }

const mockPrisma = prisma as unknown as {
  payment: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock; create: jest.Mock }
  order: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock; create: jest.Mock }
  venue: { findUnique: jest.Mock }
  shift: { findUnique: jest.Mock; findFirst: jest.Mock; updateMany: jest.Mock }
  terminal: { findFirst: jest.Mock }
  $queryRaw: jest.Mock
  $transaction: jest.Mock
}

const d = (v: string | number) => new Prisma.Decimal(v)

const VENUE_ID = 'cvenue0000000000000000001'
const ORDER_ID = 'corder0000000000000000001'
const PAYMENT_ID = 'cpay000000000000000000001'
const STAFF_ID = 'cstaff000000000000000001'

/** El `Payment` de cripto tal como lo devuelve el `findUnique` del webhook. */
const cryptoPayment = (over: Record<string, any> = {}) => ({
  id: PAYMENT_ID,
  venueId: VENUE_ID,
  orderId: ORDER_ID,
  amount: d('50.00'),
  tipAmount: d('0.00'),
  status: 'PENDING',
  externalId: 'b4bit-req-1',
  processorData: {},
  order: { id: ORDER_ID, orderNumber: 'ORD-1', tableId: null },
  venue: { id: VENUE_ID, name: 'Testarudo Cafe', organizationId: 'corg00000000000000000001' },
  ...over,
})

/** La orden tal como la relee la transacción del webhook. */
const freshOrder = (over: Record<string, any> = {}) => ({
  id: ORDER_ID,
  venueId: VENUE_ID,
  status: 'PENDING',
  paymentStatus: 'PENDING',
  subtotal: d('200.00'),
  discountAmount: d('0.00'),
  serviceChargeAmount: d('0.00'),
  completedAt: null,
  version: 1,
  ...over,
})

const webhookCO = (): B4BitWebhookPayload => ({
  identifier: 'b4bit-uuid-1',
  reference: PAYMENT_ID,
  fiat_amount: 50,
  fiat_currency: 'MXN',
  crypto_amount: '0.0004',
  currency: 'BTC',
  status: 'CO',
  tx_hash: '0xdead',
  confirmations: 3,
})

/** Lo que se escribió en la orden (única llamada de transición esperada). */
const orderWrite = () => {
  const call = mockPrisma.order.updateMany.mock.calls[0] ?? mockPrisma.order.update.mock.calls[0]
  expect(call).toBeDefined()
  return call[0].data as Record<string, any>
}

beforeEach(() => {
  jest.clearAllMocks()
  // 🔴 `clearAllMocks` NO vacía la cola de `mockResolvedValueOnce`: un "once" que
  // un test deje sin consumir se filtraría al siguiente y lo volvería mentiroso.
  // Los que usan `once` se resetean a mano.
  mockPrisma.order.updateMany.mockReset()
  mockPrisma.order.findUnique.mockReset()
  mockPrisma.payment.findMany.mockReset()
  mockPrisma.payment.updateMany.mockReset()
  mockPrisma.shift.findFirst.mockReset()
  mockPrisma.shift.updateMany.mockReset()
  mockPrisma.$queryRaw.mockReset()

  mockPrisma.$transaction.mockImplementation((cb: any) => cb(prisma))
  mockPrisma.payment.update.mockResolvedValue({})
  mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.shift.findFirst.mockResolvedValue(null)
  mockPrisma.shift.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.$queryRaw.mockResolvedValue([{ id: PAYMENT_ID }])
  mockPrisma.order.update.mockResolvedValue({})
  mockPrisma.order.updateMany.mockResolvedValue({ count: 1 })
})

describe('b4bit — webhook de confirmación y saldo de la cuenta', () => {
  it('🔴 ABONO PARCIAL: $50 sobre una cuenta de $200 NO cierra la cuenta ni borra el saldo', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    // Tras completar el pago actual, los COMPLETED durables de la orden son sólo éste.
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('50.00'), tipAmount: d('0.00') }])

    const result = await processWebhook(webhookCO())

    expect(result.success).toBe(true)

    const data = orderWrite()
    expect(data.paymentStatus).toBe('PARTIAL')
    expect(Number(data.paidAmount)).toBe(50)
    expect(Number(data.remainingBalance)).toBe(150)
    // Nada de "venta terminada": la cuenta sigue viva y cobrable.
    expect(data.status).not.toBe('COMPLETED')
    expect(data.completedAt).toBeUndefined()
  })

  it('el hook de referidos NO corre en un abono parcial', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('50.00'), tipAmount: d('0.00') }])

    await processWebhook(webhookCO())

    expect(onOrderPaid).not.toHaveBeenCalled()
  })

  it('ABONO FINAL: con $150 ya pagados, el abono de $50 sí salda la cuenta', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ paymentStatus: 'PARTIAL' }))
    mockPrisma.payment.findMany.mockResolvedValue([
      { amount: d('150.00'), tipAmount: d('0.00') },
      { amount: d('50.00'), tipAmount: d('0.00') },
    ])

    await processWebhook(webhookCO())

    const data = orderWrite()
    expect(data.paymentStatus).toBe('PAID')
    expect(data.status).toBe('COMPLETED')
    expect(data.completedAt).toBeInstanceOf(Date)
    expect(Number(data.paidAmount)).toBe(200)
    expect(Number(data.remainingBalance)).toBe(0)
  })

  it('el hook de referidos SÍ corre en la transición real a pagado', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ paymentStatus: 'PARTIAL' }))
    mockPrisma.payment.findMany.mockResolvedValue([
      { amount: d('150.00'), tipAmount: d('0.00') },
      { amount: d('50.00'), tipAmount: d('0.00') },
    ])

    await processWebhook(webhookCO())

    expect(onOrderPaid).toHaveBeenCalledTimes(1)
    expect(onOrderPaid).toHaveBeenCalledWith({ orderId: ORDER_ID, venueId: VENUE_ID })
  })

  it('usa el TOTAL CANÓNICO (cargo por servicio + propinas), no `subtotal` a secas', async () => {
    // $200 mercancía + $30 de cargo por servicio + $20 de propina = $250 a cobrar.
    // Pagados: $100 + $20 de propina (previo) y $50 de cripto = $170. Faltan $80.
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ paymentStatus: 'PARTIAL', serviceChargeAmount: d('30.00') }))
    mockPrisma.payment.findMany.mockResolvedValue([
      { amount: d('100.00'), tipAmount: d('20.00') },
      { amount: d('50.00'), tipAmount: d('0.00') },
    ])

    await processWebhook(webhookCO())

    const data = orderWrite()
    expect(data.paymentStatus).toBe('PARTIAL')
    expect(Number(data.paidAmount)).toBe(170)
    // 🔑 Aquí están los dientes: si la DECISIÓN usara `subtotal` a secas, el
    // restante sería 200 − 170 = 30. Los 80 sólo salen si el cargo por servicio y
    // la propina entraron al total canónico — aunque ese total NO se escriba.
    expect(Number(data.remainingBalance)).toBe(80)
  })

  it('🔁 WEBHOOK REPETIDO: el mismo `CO` dos veces deja totales idénticos y un solo Payment', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('50.00'), tipAmount: d('0.00') }])

    await processWebhook(webhookCO())
    const first = { ...orderWrite() }

    jest.clearAllMocks()
    mockPrisma.$transaction.mockImplementation((cb: any) => cb(prisma))
    mockPrisma.payment.update.mockResolvedValue({})
    mockPrisma.order.update.mockResolvedValue({})
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 })
    // Segunda entrega: el pago YA está COMPLETED y la orden ya quedó PARTIAL.
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ status: 'COMPLETED' }))
    mockPrisma.order.findUnique.mockResolvedValue(
      freshOrder({ paymentStatus: 'PARTIAL', paidAmount: d('50.00'), remainingBalance: d('150.00'), version: 2 }),
    )
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('50.00'), tipAmount: d('0.00') }])

    await processWebhook(webhookCO())
    const second = orderWrite()

    expect(Number(second.paidAmount)).toBe(Number(first.paidAmount))
    expect(Number(second.remainingBalance)).toBe(Number(first.remainingBalance))
    expect(second.paymentStatus).toBe('PARTIAL')
    // 🔴 Ni un segundo cobro ni un `paidAmount += amount`: la reentrega ACTUALIZA
    // el mismo `Payment` y el saldo sigue en 50, no en 100.
    expect(mockPrisma.payment.update).toHaveBeenCalledTimes(1)
    expect(mockPrisma.payment.update.mock.calls[0][0].where).toEqual({ id: PAYMENT_ID, venueId: VENUE_ID })
    expect(Number(second.paidAmount)).toBe(50)
  })

  it('🔴 NO reescribe `Order.total` ni `tipAmount` (la cuota de envío de un pedido de agregador se perdería)', async () => {
    // Pedido Deliverect/Uber: subtotal 200 + envío 40 = total 240 que puso el
    // proveedor. La fórmula canónica omite `deliveryFeeAmount`, así que recalcular
    // el total lo dejaría en 200 habiendo cobrado 240.
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ amount: d('240.00') }))
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ subtotal: d('200.00') }))
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('240.00'), tipAmount: d('0.00') }])

    await processWebhook(webhookCO())

    const data = orderWrite()
    expect(data).not.toHaveProperty('total')
    expect(data).not.toHaveProperty('tipAmount')
    // Sí escribe el derivado del cobro, que es lo que este trabajo arregla.
    expect(Number(data.paidAmount)).toBe(240)
  })
})

describe('b4bit — CAS: qué pasa si otro cobro gana la carrera', () => {
  it('pierde la CAS una vez y reintenta RELEYENDO el estado del ganador', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())

    // 1ª lectura: cuenta virgen, version 1. La CAS se pierde (otro cobró $150).
    // 2ª lectura: el estado YA commiteado por el ganador, version 2.
    mockPrisma.order.findUnique
      .mockResolvedValueOnce(freshOrder({ version: 1 }))
      .mockResolvedValueOnce(freshOrder({ paymentStatus: 'PARTIAL', version: 2 }))
    mockPrisma.payment.findMany.mockResolvedValueOnce([{ amount: d('50.00'), tipAmount: d('0.00') }]).mockResolvedValueOnce([
      { amount: d('150.00'), tipAmount: d('0.00') },
      { amount: d('50.00'), tipAmount: d('0.00') },
    ])
    mockPrisma.order.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })

    await processWebhook(webhookCO())

    expect(mockPrisma.order.findUnique).toHaveBeenCalledTimes(2)
    expect(mockPrisma.order.updateMany).toHaveBeenCalledTimes(2)

    // El primer intento habría escrito PARTIAL/150; el segundo escribe sobre el
    // estado real del ganador y salda la cuenta. No se pisó al ganador.
    const first = mockPrisma.order.updateMany.mock.calls[0][0]
    const second = mockPrisma.order.updateMany.mock.calls[1][0]
    expect(first.where.version).toBe(1)
    expect(second.where.version).toBe(2)
    expect(second.data.paymentStatus).toBe('PAID')
    expect(Number(second.data.paidAmount)).toBe(200)
    expect(Number(second.data.remainingBalance)).toBe(0)
  })

  it('🚨 pierde las 3: deja el Payment COMPLETED igual y grita en el log', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('50.00'), tipAmount: d('0.00') }])
    mockPrisma.order.updateMany.mockResolvedValue({ count: 0 })

    await expect(processWebhook(webhookCO())).rejects.toThrow()

    expect(mockPrisma.order.updateMany).toHaveBeenCalledTimes(3)

    // 🔴 Lo que de verdad importa: el `payment.updateMany` de los 3 intentos vive DENTRO
    // de la transacción y se revirtió con cada rollback. Sin la CAS de rescate en
    // una transacción NUEVA, los $50 quedarían en la blockchain sin ningún
    // `Payment` COMPLETED — y el controlador ya le dijo 200 a B4Bit.
    const rescue = mockPrisma.payment.updateMany.mock.calls.at(-1)![0]
    // Ni siquiera el rescate puede resucitar FAILED/PROCESSING: la transición
    // durable autorizada por CO sigue siendo exactamente PENDING → COMPLETED.
    expect(rescue.where).toEqual({ id: PAYMENT_ID, venueId: VENUE_ID, status: 'PENDING' })
    expect(rescue.data.status).toBe('COMPLETED')
    expect(rescue.data.processorData.orderSettlementFailed).toBe(true)

    // Alerta greppable con todo lo necesario para reconstruir el caso sin la DB.
    const alert = mockLogger.error.mock.calls.find((c: any[]) => String(c[0]).includes('🚨 [B4Bit settlement] EXHAUSTED'))
    expect(alert).toBeDefined()
    expect(alert![1]).toMatchObject({
      paymentId: PAYMENT_ID,
      venueId: VENUE_ID,
      orderId: ORDER_ID,
      amount: '50',
      b4bitReference: 'b4bit-req-1',
    })
  })

  it('un `CO` repetido sobre una cuenta YA pagada no vuelve a disparar el hook de referidos', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ status: 'COMPLETED', amount: d('200.00') }))
    mockPrisma.order.findUnique.mockResolvedValue(
      freshOrder({ paymentStatus: 'PAID', status: 'COMPLETED', completedAt: new Date('2026-08-17T10:00:00Z') }),
    )
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('200.00'), tipAmount: d('0.00') }])

    await processWebhook(webhookCO())

    expect(onOrderPaid).not.toHaveBeenCalled()
    // Y `completedAt` no se mueve: la venta se cerró una vez, no dos.
    const data = orderWrite()
    expect(data.completedAt).toEqual(new Date('2026-08-17T10:00:00Z'))
  })
})

describe('b4bit — iniciación: la orden tiene que admitir el cobro', () => {
  beforeEach(() => {
    mockPrisma.shift.findUnique.mockResolvedValue({ id: 'cshift00000000000000001', status: 'OPEN' })
    mockPrisma.terminal.findFirst.mockResolvedValue(null)
    // Si la validación fallara en dejar pasar algo, esto evita salir a la red real.
    global.fetch = jest.fn().mockRejectedValue(new Error('no debió llamarse a B4Bit')) as any
  })

  const initiate = (over: Record<string, any> = {}) =>
    initiateCryptoPayment({
      venueId: VENUE_ID,
      orgId: 'corg00000000000000000001',
      amount: 5000,
      staffId: STAFF_ID,
      orderId: ORDER_ID,
      ...over,
    } as any)

  it('🔴 rechaza una orden de OTRO venue', async () => {
    // El tenant se filtra en la consulta: para este venue, la orden no existe.
    mockPrisma.order.findUnique.mockResolvedValue(null)

    await expect(initiate()).rejects.toThrow(/no existe|no pertenece/i)
    expect(mockPrisma.payment.create).not.toHaveBeenCalled()
  })

  it('rechaza una cuenta ya PAGADA', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ paymentStatus: 'PAID', status: 'COMPLETED' }))

    await expect(initiate()).rejects.toThrow(/ya está pagada/i)
    expect(mockPrisma.payment.create).not.toHaveBeenCalled()
  })

  it('rechaza una cuenta CANCELADA', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ status: 'CANCELLED' }))

    await expect(initiate()).rejects.toThrow(/cancelada|no admite/i)
    expect(mockPrisma.payment.create).not.toHaveBeenCalled()
  })

  it('la consulta de la orden filtra por venue (aislamiento de tenant)', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null)

    await expect(initiate()).rejects.toThrow()

    const where = mockPrisma.order.findUnique.mock.calls[0][0].where
    expect(where).toMatchObject({ id: ORDER_ID, venueId: VENUE_ID })
  })
})
