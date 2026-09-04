/**
 * 🔴 ESTADOS TERMINALES — un webhook tardío no puede revertir lo que ya pasó.
 *
 * La doc de B4Bit dice dos cosas que el código ignoraba: que los webhooks pueden
 * llegar FUERA DE ORDEN (hay que descartar el viejo por `edited_at`) y que B4Bit
 * NO reintenta. De ahí salen cuatro defectos de dinero, todos por escribir sin
 * mirar el estado actual:
 *
 * 1. `OC`/`EX` (monto insuficiente / expirada) marcaban `FAILED` un cobro YA
 *    COMPLETADO. El corte de caja y el de turno seleccionan `status: COMPLETED`,
 *    así que el dinero DESAPARECÍA del corte mientras la orden seguía PAID.
 * 2. Un `CO` reentregado sobre una cuenta REEMBOLSADA recalculaba el saldo
 *    contando el `Payment` negativo del reembolso: la venta devuelta reaparecía
 *    debiendo, en el estado contradictorio `status COMPLETED` + `PARTIAL`.
 * 3. Un `CO` sobre una orden CANCELADA la resucitaba a COMPLETED/PAID. La
 *    INICIACIÓN sí valida esto; el webhook no, y entre una y otra pasan minutos.
 * 4. Un webhook viejo pisaba el estado de uno nuevo.
 *
 * 🔑 La regla en las dos direcciones: el `Payment` COMPLETED nunca se degrada
 * (el dinero es real y no se puede perder), y la ORDEN nunca se resucita ni
 * reabre saldo — cuando algo no cuadra se grita en el log en vez de escribir.
 */

// ── Mocks (mismo harness que b4bit.partialPayment.test.ts) ───────────────────

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
  client.$transaction.mockImplementation((cb: any) => cb(client))
  return { __esModule: true, default: client }
})

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const mockBroadcastToVenue = jest.fn()
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: (...a: any[]) => mockBroadcastToVenue(...a) },
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
import logger from '@/config/logger'
import { processWebhook } from '@/services/b4bit/b4bit.service'
import type { B4BitWebhookPayload } from '@/services/b4bit/types'
import prisma from '@/utils/prismaClient'

const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock }

const mockPrisma = prisma as unknown as {
  payment: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock; create: jest.Mock }
  order: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock; create: jest.Mock }
  shift: { findFirst: jest.Mock; updateMany: jest.Mock }
  $queryRaw: jest.Mock
  $transaction: jest.Mock
}

const d = (v: string | number) => new Prisma.Decimal(v)

const VENUE_ID = 'cvenue0000000000000000001'
const ORDER_ID = 'corder0000000000000000001'
const PAYMENT_ID = 'cpay000000000000000000001'

const cryptoPayment = (over: Record<string, any> = {}) => ({
  id: PAYMENT_ID,
  venueId: VENUE_ID,
  orderId: ORDER_ID,
  amount: d('200.00'),
  tipAmount: d('0.00'),
  status: 'PENDING',
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

const webhook = (over: Partial<B4BitWebhookPayload> = {}): B4BitWebhookPayload => ({
  identifier: 'b4bit-uuid-1',
  reference: PAYMENT_ID,
  fiat_amount: 200,
  fiat_currency: 'MXN',
  crypto_amount: '0.0016',
  currency: 'BTC',
  status: 'CO',
  tx_hash: '0xdead',
  confirmations: 3,
  ...over,
})

/** La última escritura de Payment, sea CAS (`updateMany`) o update. */
const lastPaymentUpdate = () =>
  [
    ...mockPrisma.payment.update.mock.calls.map((call, index) => ({
      call,
      order: mockPrisma.payment.update.mock.invocationCallOrder[index],
    })),
    ...mockPrisma.payment.updateMany.mock.calls.map((call, index) => ({
      call,
      order: mockPrisma.payment.updateMany.mock.invocationCallOrder[index],
    })),
  ]
    .sort((a, b) => a.order - b.order)
    .at(-1)?.call[0]
const errorLogged = (needle: string) => mockLogger.error.mock.calls.some((c: any[]) => String(c[0]).includes(needle))
const warnLogged = (needle: string) => mockLogger.warn.mock.calls.some((c: any[]) => String(c[0]).includes(needle))
const failureBroadcast = () => mockBroadcastToVenue.mock.calls.filter(c => c[1] === 'crypto:payment_failed')

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
  mockPrisma.$queryRaw.mockResolvedValue([{ id: PAYMENT_ID }])
  mockPrisma.order.update.mockResolvedValue({})
  mockPrisma.order.updateMany.mockResolvedValue({ count: 1 })
})

describe('b4bit — un fallo TARDÍO no degrada un cobro ya confirmado', () => {
  it('🔴 un EX que llega DESPUÉS del CO no marca FAILED el Payment', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ status: 'COMPLETED' }))

    const result = await processWebhook(webhook({ status: 'EX' }))

    const update = lastPaymentUpdate()
    expect(update).toBeDefined()
    // 🔑 Lo único que importa: el estado del cobro NO se toca.
    expect(update.data.status).toBeUndefined()
    expect(update.data.processorData).toMatchObject({ lateFailureIgnored: true, lastStatus: 'EX' })
    expect(result.success).toBe(true)
    expect(warnLogged('[B4Bit] estado tardío')).toBe(true)
  })

  it('🔴 un OC tardío tampoco degrada un pago COMPLETED', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ status: 'COMPLETED' }))

    await processWebhook(webhook({ status: 'OC' }))

    expect(lastPaymentUpdate().data.status).toBeUndefined()
    expect(lastPaymentUpdate().data.processorData).toMatchObject({ lateFailureIgnored: true, lastStatus: 'OC' })
  })

  it('🔴 y NO le avisa a la terminal que el cobro falló', async () => {
    // Emitir `crypto:payment_failed` sobre un cobro real le diría al POS que
    // vuelva a cobrar algo que el cliente YA pagó.
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ status: 'COMPLETED' }))

    await processWebhook(webhook({ status: 'EX' }))

    expect(failureBroadcast()).toHaveLength(0)
  })

  it('REGRESIÓN: un EX sobre un pago PENDIENTE sí lo marca FAILED y avisa', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ status: 'PENDING' }))

    const result = await processWebhook(webhook({ status: 'EX' }))

    expect(lastPaymentUpdate().data.status).toBe('FAILED')
    expect(lastPaymentUpdate().where).toEqual({ id: PAYMENT_ID, venueId: VENUE_ID, status: { not: 'COMPLETED' } })
    expect(failureBroadcast()).toHaveLength(1)
    expect(result.action).toBe('EXPIRED')
  })
})

describe('b4bit — un CO reentregado sobre una cuenta REEMBOLSADA no reabre el saldo', () => {
  it('🔴 recalcula y el saldo queda IGUAL, porque el reembolso ya no cuenta', async () => {
    // 🔑 Esto ANTES se resolvía con un guard que se SALTABA el recálculo
    // (`isRedelivery && orderHasRefund`). El guard desapareció el 2026-08-18: la
    // aritmética canónica excluye los `Payment` `type: REFUND`, así que
    // recalcular una cuenta reembolsada llega al MISMO resultado que ya tenía.
    // Se prueba el recálculo, no la evasión: es lo que garantiza que ningún
    // camino futuro se olvide del guard.
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ status: 'COMPLETED' }))
    mockPrisma.order.findUnique.mockResolvedValue(
      freshOrder({ status: 'COMPLETED', paymentStatus: 'PAID', paidAmount: d('200.00'), remainingBalance: d('0.00') }),
    )
    // El cobro (+200) y su reembolso (−200), ambos COMPLETED sobre la misma orden.
    mockPrisma.payment.findMany.mockResolvedValue([
      { amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' },
      { amount: d('-200.00'), tipAmount: d('0.00'), type: 'REFUND' },
    ])

    const result = await processWebhook(webhook())

    // 🔑 Antes esto escribía paidAmount 0 / remainingBalance 200 / paymentStatus
    // PARTIAL: la venta devuelta reaparecía por cobrar.
    expect(mockPrisma.order.updateMany).toHaveBeenCalledTimes(1)
    const data = mockPrisma.order.updateMany.mock.calls[0][0].data
    expect(data.paymentStatus).toBe('PAID')
    expect(Number(data.paidAmount)).toBe(200)
    expect(Number(data.remainingBalance)).toBe(0)
    expect(result.action).toBe('CONFIRMED')
    // La cuenta con reembolsos sigue siendo digna de una mirada humana.
    expect(warnLogged('[Reembolso] cobro sobre una cuenta con reembolsos')).toBe(true)
  })

  it('el Payment igual queda COMPLETED (el dinero es real) y no se dispara el referido', async () => {
    // `becamePaid` es false: la cuenta YA estaba PAID antes de esta reentrega,
    // así que el hook de referidos no se vuelve a disparar.
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ status: 'COMPLETED' }))
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ status: 'COMPLETED', paymentStatus: 'PAID' }))
    mockPrisma.payment.findMany.mockResolvedValue([
      { amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' },
      { amount: d('-200.00'), tipAmount: d('0.00'), type: 'REFUND' },
    ])

    await processWebhook(webhook())

    expect(lastPaymentUpdate().data.status).toBe('COMPLETED')
    expect(onOrderPaid).not.toHaveBeenCalled()
  })

  it('🔴 un CO PRIMERIZO sobre una orden PARTIAL con un refund previo SÍ liquida', async () => {
    // Cuenta de $200. El cliente abonó $100 en efectivo y ese cobro se reembolsó
    // (tender equivocado) → la orden quedó PARTIAL con un `Payment` −100 de tipo
    // REFUND colgado. Ahora paga los $200 en cripto: la cuenta queda SALDADA.
    //
    // 🔑 `paidAmount` es BRUTO (100 + 200 = 300), no neto: el reembolso vive en su
    // propio carril y NO resta de lo cobrado — es el modelo de Square/Toast, y lo
    // que hace que la cuenta no pueda "volver a deber". Antes esto daba 200
    // porque el −100 se restaba, y ese mismo mecanismo era el que dejaba una
    // venta reembolsada reapareciendo por cobrar.
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ status: 'PENDING' }))
    mockPrisma.order.findUnique.mockResolvedValue(
      freshOrder({ paymentStatus: 'PARTIAL', paidAmount: d('100.00'), remainingBalance: d('100.00') }),
    )
    mockPrisma.payment.findMany.mockResolvedValue([
      { amount: d('100.00'), tipAmount: d('0.00'), type: 'REGULAR' },
      { amount: d('-100.00'), tipAmount: d('0.00'), type: 'REFUND' },
      { amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' },
    ])

    await processWebhook(webhook())

    expect(mockPrisma.order.updateMany).toHaveBeenCalledTimes(1)
    const data = mockPrisma.order.updateMany.mock.calls[0][0].data
    expect(data.paymentStatus).toBe('PAID')
    expect(Number(data.paidAmount)).toBe(300)
    expect(Number(data.remainingBalance)).toBe(0)
    expect(data.status).toBe('COMPLETED')
  })

  it('REGRESIÓN: sin reembolsos el saldo se sigue recalculando normal', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    await processWebhook(webhook())

    expect(mockPrisma.order.updateMany).toHaveBeenCalledTimes(1)
    expect(mockPrisma.order.updateMany.mock.calls[0][0].data.paymentStatus).toBe('PAID')
  })
})

describe('b4bit — un CO sobre una orden CANCELADA no la resucita', () => {
  it('🔴 no la marca COMPLETED/PAID', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ status: 'CANCELLED' }))
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    await processWebhook(webhook())

    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled()
    expect(mockPrisma.order.update).not.toHaveBeenCalled()
  })

  it('sí deja el Payment COMPLETED y grita en el log con todo lo necesario', async () => {
    // El dinero llegó de verdad: perderlo sería peor que el estado raro.
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ status: 'CANCELLED' }))
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    const result = await processWebhook(webhook())

    expect(lastPaymentUpdate().data.status).toBe('COMPLETED')
    expect(result.action).toBe('CONFIRMED')

    const alert = mockLogger.error.mock.calls.find((c: any[]) => String(c[0]).includes('🚨 [B4Bit] cobro confirmado sobre orden cancelada'))
    expect(alert).toBeDefined()
    expect(alert![1]).toMatchObject({ paymentId: PAYMENT_ID, venueId: VENUE_ID, orderId: ORDER_ID })
    expect(alert![1].amount).toBe('200')
  })

  it('una orden DELETED recibe el mismo trato', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder({ status: 'DELETED' }))
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    await processWebhook(webhook())

    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled()
    expect(errorLogged('🚨 [B4Bit] cobro confirmado sobre orden cancelada')).toBe(true)
  })

  it('🔴 la CAS excluye CANCELLED/DELETED (carrera: la cancelan entre la relectura y el write)', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment())
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    await processWebhook(webhook())

    const where = mockPrisma.order.updateMany.mock.calls[0][0].where
    expect(where.status).toEqual({ notIn: ['CANCELLED', 'DELETED'] })
  })
})

describe('b4bit — webhooks fuera de orden (`edited_at`)', () => {
  it('🔴 un webhook con `edited_at` ANTERIOR al último aplicado se ignora', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(
      cryptoPayment({ status: 'COMPLETED', processorData: { lastStatus: 'CO', lastEditedAt: '2026-08-17T10:05:00Z' } }),
    )

    const result = await processWebhook(webhook({ status: 'EX', edited_at: '2026-08-17T10:00:00Z' }))

    expect(mockPrisma.payment.update).not.toHaveBeenCalled()
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.action).toBe('IGNORED')
  })

  it('el webhook MÁS NUEVO sí se aplica y deja guardado su `edited_at`', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(
      cryptoPayment({ processorData: { lastStatus: 'AC', lastEditedAt: '2026-08-17T10:00:00Z' } }),
    )
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    await processWebhook(webhook({ edited_at: '2026-08-17T10:05:00Z' }))

    expect(lastPaymentUpdate().data.processorData).toMatchObject({ lastEditedAt: '2026-08-17T10:05:00Z' })
  })

  it('🔴 un `edited_at` INVÁLIDO se trata como ausente y NO se guarda como marca de agua', async () => {
    // Una fecha basura da `NaN` al compararla: el webhook se procesa (dirección
    // segura), pero si además se GUARDA como `lastEditedAt`, toda comparación
    // futura contra `NaN` es `false` y la protección de orden queda apagada para
    // ese pago, en silencio. La marca de agua buena tiene que sobrevivir.
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ processorData: { lastEditedAt: '2026-08-17T10:00:00Z' } }))
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    const result = await processWebhook(webhook({ edited_at: 'no-es-una-fecha' }))

    expect(result.action).toBe('CONFIRMED')
    expect(lastPaymentUpdate().data.processorData.lastEditedAt).toBe('2026-08-17T10:00:00Z')
  })

  it('una marca de agua GUARDADA que sea basura no bloquea el webhook nuevo', async () => {
    // El otro lado de la comparación: si `lastEditedAt` quedó corrupto, un
    // `edited_at` válido no puede quedar atrapado detrás de un `NaN`.
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ processorData: { lastEditedAt: 'basura' } }))
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    const result = await processWebhook(webhook({ edited_at: '2026-08-17T10:05:00Z' }))

    expect(result.action).toBe('CONFIRMED')
    expect(lastPaymentUpdate().data.processorData.lastEditedAt).toBe('2026-08-17T10:05:00Z')
  })

  it('sin `edited_at` (payload viejo de B4Bit) todo sigue funcionando igual', async () => {
    mockPrisma.payment.findUnique.mockResolvedValue(cryptoPayment({ processorData: { lastEditedAt: '2026-08-17T10:00:00Z' } }))
    mockPrisma.order.findUnique.mockResolvedValue(freshOrder())
    mockPrisma.payment.findMany.mockResolvedValue([{ amount: d('200.00'), tipAmount: d('0.00'), type: 'REGULAR' }])

    const result = await processWebhook(webhook())

    expect(result.action).toBe('CONFIRMED')
    expect(mockPrisma.order.updateMany).toHaveBeenCalledTimes(1)
  })
})
