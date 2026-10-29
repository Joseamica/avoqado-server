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

import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'

/**
 * Fase 2 (tarea 5): los avisos de un pedido en línea con tarjeta tienen su propia rama, ANTES del corte `payment_status !== 'paid'`
 * (con captura manual la sesión llega `unpaid`) y antes de la rama de depósitos de reserva (donde caía un tipo desconocido).
 */
const event = (type: string, data: Record<string, unknown>) => ({ id: 'evt_oo', type, account: 'acct_123', livemode: false, data })
const META = { type: 'online_order', chargeId: 'ch1', venueId: 'v1' }

beforeEach(() => {
  jest.clearAllMocks()
  ;(confirmCardAuthorization as jest.Mock).mockResolvedValue('CREATED')
  prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 } as any)
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

  it('payment_intent.canceled marca RELEASED (apartado) o ABANDONED (sin autorizar), sólo por CAS', async () => {
    await processStripeConnectWebhookEvent(event('payment_intent.canceled', { id: 'pi_1', metadata: META }))

    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', status: { in: ['AUTHORIZED', 'RELEASING'] } },
      data: { status: 'RELEASED', releasedAt: expect.any(Date) },
    })
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', status: 'PENDING_AUTH' },
      data: { status: 'ABANDONED' },
    })
    expect(confirmCardAuthorization).not.toHaveBeenCalled()
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
