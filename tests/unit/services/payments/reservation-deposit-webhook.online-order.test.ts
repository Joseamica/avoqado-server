import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/dashboard/creditPack.public.service', () => ({ __esModule: true, fulfillPurchase: jest.fn() }))
jest.mock('@/services/dashboard/paymentLink.service', () => ({ __esModule: true, finalizePaymentLinkCheckout: jest.fn() }))
jest.mock('@/services/dashboard/venueCheckout.service', () => ({ __esModule: true, finalizeVenueCheckout: jest.fn() }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: {} }))
jest.mock('@/services/whatsapp.service', () => ({
  __esModule: true,
  sendReservationConfirmationWhatsApp: jest.fn(),
  formatModifiersForWhatsApp: jest.fn(),
}))
jest.mock('@/services/online-ordering/card/confirm.service', () => ({ __esModule: true, confirmCardAuthorization: jest.fn() }))

const mockRejectOnlineOrder = jest.fn()
jest.mock('@/services/online-ordering/transitions.service', () => ({
  __esModule: true,
  rejectOnlineOrder: (...a: unknown[]) => mockRejectOnlineOrder(...a),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))

const mockGetAuthorization = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: () => ({ getAuthorization: (...a: unknown[]) => mockGetAuthorization(...a) }),
}))

import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * Fase 2 (tarea 5): los avisos de un pedido en línea con tarjeta tienen su propia rama, ANTES del corte `payment_status !== 'paid'`
 * (con captura manual la sesión llega `unpaid`) y antes de la rama de depósitos de reserva (donde caía un tipo desconocido).
 */
const event = (type: string, data: Record<string, unknown>) => ({ id: 'evt_oo', type, account: 'acct_123', livemode: false, data })
const META = { type: 'online_order', chargeId: 'ch1', venueId: 'v1' }
/** El cargo `ch1` de la cuenta `acct_123` en modo prueba (la foto que manda sobre el aviso, Codex r1 C2). */
const cargo = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 'ch1',
  venueId: 'v1',
  status,
  paymentIntentId: 'pi_1',
  ecommerceMerchantId: 'm1',
  merchantSnapshot: { connectAccountId: 'acct_123', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
  amount: '250.00',
  onlineOrderId: null,
  onlineOrder: null,
  ...extra,
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(confirmCardAuthorization as jest.Mock).mockResolvedValue('CREATED')
  prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 } as any)
  prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(cargo('PENDING_AUTH') as any)
  mockGetAuthorization.mockResolvedValue({ piStatus: 'canceled' })
})

describe('avisos de Stripe de un pedido en línea con tarjeta', () => {
  it('checkout.session.completed con metadata online_order y payment_status unpaid llama confirmCardAuthorization y NO toca reservas', async () => {
    await processStripeConnectWebhookEvent(event('checkout.session.completed', { id: 'cs_1', payment_status: 'unpaid', metadata: META }))

    expect(confirmCardAuthorization).toHaveBeenCalledWith('ch1')
    expect(prismaMock.processedStripeEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.reservation.updateMany).not.toHaveBeenCalled()
  })

  it.each(['checkout.session.expired', 'payment_intent.amount_capturable_updated'])('%s también confirma', async type => {
    await processStripeConnectWebhookEvent(event(type, { id: 'x_1', metadata: META }))
    expect(confirmCardAuthorization).toHaveBeenCalledWith('ch1')
    expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
  })

  it('payment_intent.canceled sobre un cargo liberándose: relee su PaymentIntent y, cancelado, marca RELEASED sólo por CAS', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(cargo('RELEASING') as any)
    await processStripeConnectWebhookEvent(event('payment_intent.canceled', { id: 'pi_1', metadata: META }))

    expect(mockGetAuthorization).toHaveBeenCalledWith(expect.anything(), { paymentIntentId: 'pi_1' })
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', status: { in: ['AUTHORIZED', 'RELEASING'] } },
      data: { status: 'RELEASED', releasedAt: expect.any(Date) },
    })
    expect(confirmCardAuthorization).not.toHaveBeenCalled()
  })

  it('[repetirNoDuplica:reservation-deposit-webhook] un CAS que ganó en un intento ABORTADO (40P01) no deja `released`: si el ganador perdió el CAS, no hay bitácora', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(cargo('AUTHORIZED', { onlineOrder: { orderId: 'o1' } }) as any)
    // intento 1: el CAS gana (count 1) y la transacción se aborta; intento 2 (el que hace commit): otro ya lo liberó (count 0); y el CAS de afuera también pierde.
    prismaMock.onlineOrderCharge.updateMany
      .mockResolvedValueOnce({ count: 1 } as any)
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValue({ count: 0 } as any)
    mockRejectOnlineOrder.mockImplementationOnce(async (a: any) => {
      await a.afterCas(prismaMock, {}) // intento abortado: su valor se descarta
      const ganador = await a.afterCas(prismaMock, {})
      a.alConfirmar(ganador)
    })

    await processStripeConnectWebhookEvent(event('payment_intent.canceled', { id: 'pi_1', metadata: META }))

    expect(logAction).not.toHaveBeenCalled()
  })

  it('payment_intent.canceled sobre un borrador no lo abandona a ciegas: relee la sesión propia (confirmar)', async () => {
    await processStripeConnectWebhookEvent(event('payment_intent.canceled', { id: 'pi_x', metadata: META }))
    expect(confirmCardAuthorization).toHaveBeenCalledWith('ch1')
    expect(prismaMock.onlineOrderCharge.updateMany).not.toHaveBeenCalled()
  })

  it('Codex r1 C2: aviso de otra cuenta → MoneyAnomaly y nada más', async () => {
    await processStripeConnectWebhookEvent({ ...event('checkout.session.completed', { id: 'cs_1', metadata: META }), account: 'acct_otro' })
    expect(confirmCardAuthorization).not.toHaveBeenCalled()
    expect(prismaMock.moneyAnomaly.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ category: 'ONLINE_ORDER_STRIPE_EVENT_FOREIGN', stripeEventId: 'evt_oo' })],
      }),
    )
  })

  it('si confirmar lanza, el aviso responde error (Stripe reintenta)', async () => {
    ;(confirmCardAuthorization as jest.Mock).mockRejectedValueOnce(new Error('stripe caído'))
    await expect(
      processStripeConnectWebhookEvent(event('checkout.session.completed', { id: 'cs_1', payment_status: 'unpaid', metadata: META })),
    ).rejects.toThrow('stripe caído')
  })

  it('un aviso de depósito de reserva sigue igual (regresión)', async () => {
    prismaMock.processedStripeEvent.create.mockResolvedValue({ processedAt: new Date() } as any)
    prismaMock.reservation.findFirst.mockResolvedValue(null)

    await processStripeConnectWebhookEvent(event('checkout.session.completed', { id: 'cs_res', payment_status: 'paid', metadata: {} }))

    expect(confirmCardAuthorization).not.toHaveBeenCalled()
    expect(prismaMock.processedStripeEvent.create).toHaveBeenCalled()
    expect(prismaMock.reservation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ checkoutSessionId: 'cs_res' }) }),
    )
    expect(prismaMock.onlineOrderCharge.updateMany).not.toHaveBeenCalled()
  })
})
