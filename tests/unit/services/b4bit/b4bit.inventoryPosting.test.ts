/**
 * Cobro CRIPTO (b4bit): la venta que se salda TIENE que dejar su vale de inventario.
 *
 * ── El defecto (verificado el 3-sep-2026) ───────────────────────────────────
 * `settleOrderForConfirmedCryptoPayment` cerraba la orden —`status: COMPLETED`,
 * `paymentStatus: PAID`— sin llamar NUNCA a `createSalePostingInTx` y sin deducir
 * nada. Un venue con recetas que cobrara en cripto vendía y su inventario no
 * bajaba, **en silencio**: el mismo defecto que costó el capuchino de Testarudo
 * (ORD-1788276418170), pero en otro camino de cobro.
 *
 * Que la omisión NO era deliberada lo prueba el propio docstring de esa función:
 * enumera CAS, reembolsos, orden cancelada, cuota de envío de agregador… y no
 * menciona el inventario ni una vez. Y `.claude/rules/payments.md` —la regla que
 * dice "stock deduction ONLY when fully paid"— no carga sobre `src/services/b4bit/**`.
 *
 * ── Lo que estos tests fijan ────────────────────────────────────────────────
 * 1. El vale nace SÓLO en la transición real a pagado, y DENTRO de la misma
 *    transacción que la cierra (fase 2: un crash después del commit deja un
 *    posting PENDING visible, no una deducción perdida invisible).
 * 2. Un abono parcial, una reentrega del `CO` y una orden cancelada NO crean vale.
 * 3. El vale se APLICA fuera de la transacción y de forma no bloqueante: si la
 *    deducción truena, el cobro ya registrado no se cae.
 * 4. 🔴 Si CREAR el vale falla, el dinero NO se pierde: se reintenta y, agotados
 *    los intentos, el `Payment` queda COMPLETED por el camino de rescate que ya
 *    existía. En este camino el `payment.update` vive DENTRO de la transacción
 *    —a diferencia del TPV, donde el Payment ya está commiteado—, así que dejar
 *    que un fallo del vale se propague convertiría un cobro bueno en dinero
 *    perdido: B4Bit no reintenta (el controlador contesta 200 siempre).
 */

// ── Mocks ────────────────────────────────────────────────────────────────────
jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    payment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    orderItem: { findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    venueCryptoConfig: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
    shift: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
    activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-without-shift' }) },
    terminal: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  }
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

jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))

const createSalePostingInTx = jest.fn()
const applySalePosting = jest.fn()
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: (...a: any[]) => createSalePostingInTx(...a),
  applySalePosting: (...a: any[]) => applySalePosting(...a),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { processWebhook } from '@/services/b4bit/b4bit.service'
import type { B4BitWebhookPayload } from '@/services/b4bit/types'

const mockPrisma = prisma as unknown as {
  payment: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock }
  order: { findUnique: jest.Mock; updateMany: jest.Mock }
  orderItem: { findMany: jest.Mock }
  shift: { findFirst: jest.Mock; updateMany: jest.Mock }
  $queryRaw: jest.Mock
  $transaction: jest.Mock
}

const d = (v: string | number) => new Prisma.Decimal(v)

const VENUE_ID = 'cvenue0000000000000000001'
const ORDER_ID = 'corder0000000000000000001'
const PAYMENT_ID = 'cpay000000000000000000001'
const STAFF_ID = 'cstaff000000000000000001'
const POSTING_ID = 'cpost000000000000000001'

const cryptoPayment = (over: Record<string, any> = {}) => ({
  id: PAYMENT_ID,
  venueId: VENUE_ID,
  orderId: ORDER_ID,
  amount: d('50.00'),
  tipAmount: d('0.00'),
  status: 'PENDING',
  processedById: STAFF_ID,
  externalId: 'b4bit-req-1',
  processorData: {},
  order: { id: ORDER_ID, orderNumber: 'ORD-1', tableId: null },
  venue: { id: VENUE_ID, name: 'Testarudo Cafe', organizationId: 'corg00000000000000000001' },
  ...over,
})

const freshOrder = (over: Record<string, any> = {}) => ({
  id: ORDER_ID,
  venueId: VENUE_ID,
  status: 'PENDING',
  paymentStatus: 'PENDING',
  subtotal: d('200.00'),
  discountAmount: d('0.00'),
  serviceChargeAmount: d('0.00'),
  paidAmount: d('0.00'),
  remainingBalance: d('200.00'),
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

/** Un renglón de catálogo: es lo que hace que la venta deba descontar stock. */
const ITEMS = [{ id: 'coitem00000000000000001', productId: 'cprod00000000000000001', quantity: 1, modifiers: [] }]

/** Los pagos COMPLETED durables que dejan la cuenta de $200 SALDADA. */
const pagosQueSaldan = () => [
  { amount: d('150.00'), tipAmount: d('0.00') },
  { amount: d('50.00'), tipAmount: d('0.00') },
]

beforeEach(() => {
  jest.clearAllMocks()
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
  ;(prisma as any).venueSettings.findUnique.mockResolvedValue({ enableShifts: true })
  mockPrisma.$queryRaw.mockResolvedValue([{ id: PAYMENT_ID }])
  mockPrisma.order.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.orderItem.findMany.mockResolvedValue(ITEMS)
  createSalePostingInTx.mockResolvedValue({ id: POSTING_ID })
  applySalePosting.mockResolvedValue({ postingId: POSTING_ID, applied: true, issues: [] })
})

describe('b4bit — el vale de inventario de la venta saldada', () => {
  it('🔴 TRANSICIÓN REAL A PAGADO: nace el vale, con los renglones y el staff del cobro', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ paymentStatus: 'PARTIAL' }))
    mockPrisma.payment.findMany.mockResolvedValue(pagosQueSaldan())

    await processWebhook(webhookCO())

    expect(createSalePostingInTx).toHaveBeenCalledTimes(1)
    expect(createSalePostingInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ venueId: VENUE_ID, orderId: ORDER_ID, items: ITEMS, staffId: STAFF_ID }),
    )
  })

  it('el vale nace DENTRO de la transacción que cierra la orden (mismo commit)', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ paymentStatus: 'PARTIAL' }))
    mockPrisma.payment.findMany.mockResolvedValue(pagosQueSaldan())

    // 🔑 Los dientes están en la IDENTIDAD del cliente, no en un booleano de
    // "estoy dentro del callback": el mock por defecto le pasa a la transacción
    // el MISMO objeto `prisma`, así que una bandera encendida durante el callback
    // sigue encendida aunque el código llame con `prisma` en vez de con `tx` — la
    // prueba pasaría con el defecto vivo. Aquí la transacción recibe un cliente
    // DISTINGUIBLE, y se exige que el vale se haya creado con ÉSE.
    // Los renglones llevan su propio mock para poder exigir que se lean con el
    // cliente de la TRANSACCIÓN: compartir el de `prisma` haría indistinguibles
    // las dos lecturas y la aserción no probaría nada.
    const txOrderItemFindMany = jest.fn().mockResolvedValue(ITEMS)
    const txClient = {
      payment: mockPrisma.payment,
      order: mockPrisma.order,
      orderItem: { findMany: txOrderItemFindMany },
      shift: mockPrisma.shift,
      venueSettings: (prisma as any).venueSettings,
      activityLog: (prisma as any).activityLog,
      $queryRaw: mockPrisma.$queryRaw,
    }
    mockPrisma.$transaction.mockImplementation((cb: any) => cb(txClient))

    await processWebhook(webhookCO())

    expect(createSalePostingInTx).toHaveBeenCalledTimes(1)
    expect(createSalePostingInTx.mock.calls[0][0]).toBe(txClient)
    expect(txOrderItemFindMany).toHaveBeenCalledTimes(1)
    expect(mockPrisma.orderItem.findMany).not.toHaveBeenCalled()
  })

  it('ABONO PARCIAL: no se salda la cuenta, así que NO nace vale', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('50.00'), tipAmount: d('0.00') }])

    await processWebhook(webhookCO())

    expect(createSalePostingInTx).not.toHaveBeenCalled()
    expect(applySalePosting).not.toHaveBeenCalled()
  })

  it('🔁 REENTREGA del `CO` sobre una cuenta YA pagada: no nace un segundo vale', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ status: 'COMPLETED' }))
    mockPrisma.order.findUnique.mockResolvedValue(
      freshOrder({ status: 'COMPLETED', paymentStatus: 'PAID', completedAt: new Date('2026-09-01T10:00:00Z') }),
    )
    mockPrisma.payment.findMany.mockResolvedValue(pagosQueSaldan())

    await processWebhook(webhookCO())

    // Doble deducción por un webhook repetido es justo lo que no puede pasar.
    expect(createSalePostingInTx).not.toHaveBeenCalled()
  })

  it('ORDEN CANCELADA: no se resucita ni se descuenta su mercancía', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ status: 'CANCELLED' }))
    mockPrisma.payment.findMany.mockResolvedValue(pagosQueSaldan())

    await processWebhook(webhookCO())

    expect(createSalePostingInTx).not.toHaveBeenCalled()
  })

  it('el vale se APLICA después del commit, con el staff del cobro', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ paymentStatus: 'PARTIAL' }))
    mockPrisma.payment.findMany.mockResolvedValue(pagosQueSaldan())

    await processWebhook(webhookCO())

    expect(applySalePosting).toHaveBeenCalledTimes(1)
    expect(applySalePosting).toHaveBeenCalledWith(POSTING_ID, STAFF_ID)
  })

  it('🛡️ si APLICAR el vale truena, el cobro NO se cae (la deducción nunca bloquea el dinero)', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ paymentStatus: 'PARTIAL' }))
    mockPrisma.payment.findMany.mockResolvedValue(pagosQueSaldan())
    applySalePosting.mockRejectedValue(new Error('stock explotó'))

    const result = await processWebhook(webhookCO())

    expect(result.success).toBe(true)
    expect(result.action).toBe('CONFIRMED')
  })

  it('🔴 si CREAR el vale falla siempre, el DINERO no se pierde: el Payment queda COMPLETED', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ paymentStatus: 'PARTIAL' }))
    mockPrisma.payment.findMany.mockResolvedValue(pagosQueSaldan())
    createSalePostingInTx.mockRejectedValue(new Error('la base se cayó'))

    // El camino de rescate ya existente lanza tras agotar los intentos; lo que
    // importa es que ANTES haya dejado el cobro registrado fuera de la transacción.
    await expect(processWebhook(webhookCO())).rejects.toThrow()

    // Se reintentó, no se rindió al primer fallo.
    expect(createSalePostingInTx).toHaveBeenCalledTimes(3)

    // 🔑 Los dientes: la CAS del rescate corre en una transacción NUEVA,
    // separada de la liquidación revertida. Sin ella, un fallo del vale dejaría
    // el pago PENDING con el dinero ya en la blockchain — y B4Bit no reintenta.
    const rescate = mockPrisma.payment.updateMany.mock.calls.at(-1)?.[0]
    expect(rescate?.data?.status).toBe('COMPLETED')
  })

  it('rechaza una orden anormalmente grande sin crear un vale parcial y conserva el cobro', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ paymentStatus: 'PARTIAL' }))
    mockPrisma.payment.findMany.mockResolvedValue(pagosQueSaldan())
    mockPrisma.orderItem.findMany.mockResolvedValue(Array(1_001).fill(ITEMS[0]))

    await expect(processWebhook(webhookCO())).rejects.toThrow('No se pudo actualizar el saldo de la cuenta tras confirmar el pago cripto')

    expect(mockPrisma.orderItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1_001 }))
    expect(createSalePostingInTx).not.toHaveBeenCalled()
    const rescate = mockPrisma.payment.updateMany.mock.calls.at(-1)?.[0]
    expect(rescate?.data?.status).toBe('COMPLETED')
  })
})
