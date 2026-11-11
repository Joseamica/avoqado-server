// tests/unit/services/online-ordering/card/capture.service.test.ts
/**
 * La captura en aislamiento (la máquina de estados va espiada): qué se decide bajo el candado, qué se manda a Stripe y qué se
 * escribe con cada desenlace. La prueba de punta a punta, con Postgres real, está en `card.integration.test.ts`.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

const capture = jest.fn()
const getAuthorization = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: jest.fn(() => ({ capture, getAuthorization })),
}))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ __esModule: true, debeMarcarCocina: jest.fn(async () => false) }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  __esModule: true,
  createSalePostingInTx: jest.fn(async () => ({ id: 'post1' })),
  applySalePosting: jest.fn(async () => null),
}))
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  __esModule: true,
  activarSobresDeCuentaPagadaEnTx: jest.fn(async () => ({ activated: [] })),
}))
jest.mock('@/services/online-ordering/card/release.service', () => ({ __esModule: true, releaseCharge: jest.fn(async () => 'RELEASED') }))
jest.mock('@/services/online-ordering/transitions.service', () => ({
  __esModule: true,
  prepMinutes: jest.fn(async () => 15),
  casTransitionInTx: jest.fn(),
  rejectOnlineOrder: jest.fn(async () => ({ outcome: 'OK', status: 'REJECTED' })),
  expireOnlineOrder: jest.fn(async () => ({ outcome: 'OK', status: 'EXPIRED' })),
  acceptWithoutCapture: jest.fn(async () => ({ outcome: 'OK', status: 'ACCEPTED' })),
  announceAccepted: jest.fn(() => ({ outcome: 'OK', status: 'ACCEPTED', estimatedReadyAt: 'x' })),
}))

import { logAction } from '@/services/dashboard/activity-log.service'
import { releaseCharge } from '@/services/online-ordering/card/release.service'
import { acceptCardOnlineOrder, failCapture } from '@/services/online-ordering/card/capture.service'
import {
  acceptWithoutCapture,
  casTransitionInTx,
  expireOnlineOrder,
  rejectOnlineOrder,
} from '@/services/online-ordering/transitions.service'

const D = (v: string) => new Prisma.Decimal(v)
const NOW = new Date('2026-10-28T18:00:00.000Z')
const base = { venueId: 'v1', orderId: 'ord1', staffId: 'staff1', now: NOW }
const CHARGE = {
  id: 'ch1',
  venueId: 'v1',
  onlineOrderId: 'oo1',
  ecommerceMerchantId: 'em1',
  paymentIntentId: 'pi_1',
  amount: D('250.00'),
  applicationFeeCents: 290,
  status: 'AUTHORIZED',
  merchantSnapshot: { connectAccountId: 'acct_A', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
}
const row = (
  o: { charge?: Record<string, unknown> | null; order?: Record<string, unknown>; status?: string; acceptDeadlineAt?: Date } = {},
) => ({
  status: o.status ?? 'PENDING_ACCEPTANCE',
  acceptDeadlineAt: o.acceptDeadlineAt ?? new Date(NOW.getTime() + 300_000),
  charge: o.charge === null ? null : { ...CHARGE, ...(o.charge ?? {}) },
  order: { status: 'PENDING', total: D('250.00'), paymentStatus: 'PENDING', paidAmount: D('0'), ...(o.order ?? {}) },
})
const succeeded = (funding = 'credit') => ({
  sessionStatus: null,
  paymentIntentId: 'pi_1',
  piStatus: 'succeeded',
  amountCapturableCents: 0,
  amountReceivedCents: 25_000,
  captureBefore: null,
  card: { brand: 'visa', last4: '4242', funding },
  paymentMethodType: 'card',
})
const OK_CAS = { r: 'OK', now: NOW, onlineOrderId: 'oo1', orderNumber: 'WABCD', orderWritten: true, orderStatus: 'CONFIRMED' }

beforeEach(() => {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
  ;(prismaMock.$queryRaw as jest.Mock).mockResolvedValue([{ id: 'ord1' }])
  prismaMock.onlineOrder.findFirst.mockReset()
  prismaMock.onlineOrder.findFirst.mockResolvedValue(row() as any)
  prismaMock.onlineOrderCharge.updateMany.mockReset()
  prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.onlineOrderCharge.findUnique.mockReset()
  prismaMock.onlineOrderCharge.findUnique.mockResolvedValue({ ...CHARGE, status: 'CAPTURING', onlineOrder: { orderId: 'ord1' } } as any)
  prismaMock.order.findUniqueOrThrow.mockResolvedValue({ total: D('250.00'), paidAmount: D('0'), items: [] } as any)
  prismaMock.payment.create.mockResolvedValue({ id: 'pay1' } as any)
  prismaMock.order.update.mockResolvedValue({} as any)
  ;(casTransitionInTx as jest.Mock).mockResolvedValue(OK_CAS)
  capture.mockReset()
  getAuthorization.mockReset()
})

describe('acceptCardOnlineOrder', () => {
  it('captura con la clave del pedido, la comisión congelada y la cuenta de la foto; registra el Payment y acepta en la MISMA tx', async () => {
    capture.mockResolvedValue(succeeded())
    await expect(acceptCardOnlineOrder(base)).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })

    expect(prismaMock.onlineOrderCharge.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'ch1', status: 'AUTHORIZED' },
      data: { status: 'CAPTURING', attempts: { increment: 1 } },
    })
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ providerCredentials: { connectAccountId: 'acct_A' } }), {
      paymentIntentId: 'pi_1',
      amountCents: 25_000,
      applicationFeeCents: 290,
      idempotencyKey: 'online-order:ord1:capture',
    })
    const data = (prismaMock.payment.create.mock.calls[0][0] as any).data
    expect(data).toMatchObject({
      venueId: 'v1',
      orderId: 'ord1',
      fundsFlow: 'AVOQADO_PROCESSED',
      ecommerceMerchantId: 'em1',
      method: 'CREDIT_CARD',
      source: 'WEB',
      status: 'COMPLETED',
      type: 'REGULAR',
      processor: 'stripe',
      processorId: 'pi_1',
      cardBrand: 'VISA',
      maskedPan: '************4242',
      idempotencyKey: 'online-order:ord1:capture',
    })
    expect(data.shiftId).toBeUndefined()
    expect(data.feeAmount.toFixed(2)).toBe('2.90')
    expect(data.netAmount.toFixed(2)).toBe('247.10')
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 'ord1' },
      data: {
        paymentStatus: 'PAID',
        paidAmount: D('250.00'),
        remainingBalance: 0,
        loyaltyEligibleAt: expect.any(Date),
        loyaltyStaffId: 'staff1',
      },
    })
    expect(casTransitionInTx).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ kind: 'ACCEPT', allowCapturing: true }))
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_CARD_CAPTURED' }))
  })

  it.each([new Date('2026-11-08T05:58:00Z'), null])(
    'R-P2-S3-3: PAID durante Stripe conserva marca/actor previos (%s), sin backfill',
    async loyaltyEligibleAt => {
      prismaMock.order.findUniqueOrThrow.mockResolvedValue({
        total: D('250.00'),
        paidAmount: D('250.00'),
        paymentStatus: 'PAID',
        loyaltyEligibleAt,
        loyaltyStaffId: 'otro-actor',
        items: [],
      } as any)
      capture.mockResolvedValue(succeeded())
      await expect(acceptCardOnlineOrder(base)).resolves.toMatchObject({ outcome: 'OK' })
      const data = prismaMock.order.update.mock.calls[0][0].data
      expect(data.paidAmount).toEqual(D('500.00'))
      expect(data).not.toHaveProperty('loyaltyEligibleAt')
      expect(data).not.toHaveProperty('loyaltyStaffId')
    },
  )

  it('R-P2-S3-3: PARTIAL saldada por captura deja marca y actor junto a PAID', async () => {
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({
      total: D('250.00'),
      paidAmount: D('50.00'),
      paymentStatus: 'PARTIAL',
      items: [],
    } as any)
    capture.mockResolvedValue(succeeded())
    await expect(acceptCardOnlineOrder(base)).resolves.toMatchObject({ outcome: 'OK' })
    expect(prismaMock.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentStatus: 'PAID', loyaltyEligibleAt: expect.any(Date), loyaltyStaffId: 'staff1' }),
      }),
    )
  })

  it('T8 fix r1: la cuenta ya tenía dinero de otro camino → se registra igual, lo cobrado suma los dos y deja ONLINE_ORDER_CARD_DOUBLE_PAYMENT', async () => {
    capture.mockResolvedValue(succeeded())
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({
      total: D('250.00'),
      paidAmount: D('250.00'),
      paymentStatus: 'PAID',
      items: [],
    } as any)
    await expect(acceptCardOnlineOrder(base)).resolves.toMatchObject({ outcome: 'OK' })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 'ord1' },
      data: { paymentStatus: 'PAID', paidAmount: D('500.00'), remainingBalance: 0 },
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ONLINE_ORDER_CARD_DOUBLE_PAYMENT',
        entityId: 'ord1',
        data: expect.objectContaining({ source: 'ONLINE_CAPTURE' }),
      }),
    )
  })

  it('débito → DEBIT_CARD', async () => {
    capture.mockResolvedValue(succeeded('debit'))
    await acceptCardOnlineOrder(base)
    expect((prismaMock.payment.create.mock.calls[0][0] as any).data.method).toBe('DEBIT_CARD')
  })

  it('si la aceptación no gana, se revierte (lanza dentro de la tx) y responde CONFIRMING_PAYMENT: nunca un Payment suelto', async () => {
    capture.mockResolvedValue(succeeded())
    ;(casTransitionInTx as jest.Mock).mockResolvedValue({ r: 'STALE', now: NOW, status: 'REJECTED', deadlinePassed: false })
    let threw = false
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      try {
        return await fn(prismaMock)
      } catch (e) {
        threw = true
        throw e
      }
    })
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    expect(threw).toBe(true)
  })

  it('respuesta perdida y el PaymentIntent sigue requires_capture → deja lastError y CONFIRMING_PAYMENT, sin Payment', async () => {
    capture.mockRejectedValue(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))
    getAuthorization.mockResolvedValue({ ...succeeded(), piStatus: 'requires_capture', amountReceivedCents: 0 })
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    expect(getAuthorization).toHaveBeenCalledWith(expect.anything(), { paymentIntentId: 'pi_1' })
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'ch1', status: 'CAPTURING' },
      data: { lastError: 'timeout' },
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('respuesta perdida pero ya cobrado → termina igual con un Payment', async () => {
    capture.mockRejectedValue(Object.assign(new Error('timeout'), { type: 'StripeConnectionError' }))
    getAuthorization.mockResolvedValue(succeeded())
    await expect(acceptCardOnlineOrder(base)).resolves.toMatchObject({ outcome: 'OK' })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('Stripe canceló el PaymentIntent → rechaza con PAYMENT_FAILED permitiendo CAPTURING, y el cargo CAPTURE_FAILED en esa tx', async () => {
    capture.mockRejectedValue(Object.assign(new Error('canceled'), { type: 'StripeInvalidRequestError' }))
    getAuthorization.mockResolvedValue({ ...succeeded(), piStatus: 'canceled', amountReceivedCents: 0 })
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    const args = (rejectOnlineOrder as jest.Mock).mock.calls[0][0]
    expect(args).toMatchObject({ venueId: 'v1', orderId: 'ord1', reason: 'PAYMENT_FAILED', allowCapturing: true })
    prismaMock.onlineOrderCharge.updateMany.mockClear()
    await args.afterCas(prismaMock, OK_CAS)
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', status: 'CAPTURING' },
      data: { status: 'CAPTURE_FAILED', lastError: 'CAPTURE_FAILED' },
    })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('el cargo ya está CAPTURING → CONFIRMING_PAYMENT sin llamar a Stripe', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ charge: { status: 'CAPTURING' } }) as any)
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    expect(capture).not.toHaveBeenCalled()
  })

  it.each(['RELEASED', 'CAPTURE_FAILED'])('cargo %s → rechaza con PAYMENT_FAILED sin capturar', async status => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ charge: { status } }) as any)
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    expect(rejectOnlineOrder).toHaveBeenCalledWith(expect.objectContaining({ reason: 'PAYMENT_FAILED' }))
    expect(capture).not.toHaveBeenCalled()
  })

  it('Order.total distinto del cargo → rechaza con PAYMENT_FAILED sin capturar ni pasar a CAPTURING', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ order: { total: D('300.00') } }) as any)
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    expect(rejectOnlineOrder).toHaveBeenCalledWith(expect.objectContaining({ reason: 'PAYMENT_FAILED' }))
    expect(prismaMock.onlineOrderCharge.updateMany).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })

  it('vencido → el camino de hoy (vencer) y responde EXPIRED', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ acceptDeadlineAt: new Date(NOW.getTime() - 1) }) as any)
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'STALE', status: 'EXPIRED' })
    expect(expireOnlineOrder).toHaveBeenCalledWith({ venueId: 'v1', orderId: 'ord1', now: NOW })
    expect(capture).not.toHaveBeenCalled()
  })

  it('la cuenta ya trae dinero → suelta la tarjeta (RELEASING) y acepta como hoy, sin capturar', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ order: { paymentStatus: 'PAID', paidAmount: D('250.00') } }) as any)
    await expect(acceptCardOnlineOrder(base)).resolves.toMatchObject({ outcome: 'OK', status: 'ACCEPTED' })
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', status: 'AUTHORIZED' },
      data: { status: 'RELEASING' },
    })
    expect(acceptWithoutCapture).toHaveBeenCalledWith(base)
    expect(releaseCharge).toHaveBeenCalledWith('ch1')
    expect(capture).not.toHaveBeenCalled()
  })
})

describe('fix r1', () => {
  it('I1: pedido de tarjeta sin cargo → rechaza con PAYMENT_FAILED, nunca acepta sin cobrar', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ charge: null }) as any)
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'STALE', status: 'REJECTED' })
    expect(rejectOnlineOrder).toHaveBeenCalledWith(expect.objectContaining({ reason: 'PAYMENT_FAILED' }))
    expect(acceptWithoutCapture).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })

  it('I1: pago parcial de otro camino → suelta la tarjeta y rechaza con PAYMENT_FAILED; no captura ni acepta', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(row({ order: { paymentStatus: 'PARTIAL', paidAmount: D('100.00') } }) as any)
    await acceptCardOnlineOrder(base)
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', status: 'AUTHORIZED' },
      data: { status: 'RELEASING' },
    })
    expect(rejectOnlineOrder).toHaveBeenCalledWith(expect.objectContaining({ reason: 'PAYMENT_FAILED' }))
    expect(releaseCharge).toHaveBeenCalledWith('ch1')
    expect(acceptWithoutCapture).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })

  it('I2: el total cambió antes de registrar el cobro → revierte (sin Payment), lastError TOTAL_CHANGED y CONFIRMING_PAYMENT', async () => {
    capture.mockResolvedValue(succeeded())
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({ total: D('300.00'), paidAmount: D('0'), items: [] } as any)
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(casTransitionInTx).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'ch1', status: 'CAPTURING' },
      data: { lastError: 'TOTAL_CHANGED' },
    })
  })

  it('M1: Stripe cobró otro monto → lastError CAPTURED_AMOUNT_MISMATCH y CONFIRMING_PAYMENT, sin Payment', async () => {
    capture.mockResolvedValue({ ...succeeded(), amountReceivedCents: 20_000 })
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'ch1', status: 'CAPTURING' },
      data: { lastError: 'CAPTURED_AMOUNT_MISMATCH' },
    })
  })

  it('M5: un error que no es de Stripe al capturar, con el PI aún requires_capture, deja su mensaje en lastError', async () => {
    capture.mockRejectedValue(new TypeError('fetch failed'))
    getAuthorization.mockResolvedValue({ ...succeeded(), piStatus: 'requires_capture', amountReceivedCents: 0 })
    await expect(acceptCardOnlineOrder(base)).resolves.toEqual({ outcome: 'CONFIRMING_PAYMENT' })
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'ch1', status: 'CAPTURING' },
      data: { lastError: 'fetch failed' },
    })
  })
})

describe('failCapture', () => {
  it('si el cargo ya no está CAPTURING cuando la transición rechazó, se revierte: no se rechaza un pedido cobrado', async () => {
    ;(rejectOnlineOrder as jest.Mock).mockImplementationOnce(async (i: any) => {
      prismaMock.onlineOrderCharge.updateMany.mockResolvedValueOnce({ count: 0 })
      await i.afterCas(prismaMock, OK_CAS) // lanza: la transacción real se revertiría
      return { outcome: 'OK', status: 'REJECTED' }
    })
    prismaMock.onlineOrder.findFirst.mockResolvedValue({ status: 'ACCEPTED' } as any)
    await expect(failCapture('ch1', { staffId: null })).resolves.toEqual({ outcome: 'STALE', status: 'ACCEPTED' })
  })
})
