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

import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { finalizePaymentLinkCheckout } from '@/services/dashboard/paymentLink.service'
import { finalizeVenueCheckout } from '@/services/dashboard/venueCheckout.service'

/**
 * P1 (19-oct, Codex r1 #2 de «OXXO de Stripe»): `payment_intent.succeeded` reclamaba el aviso en ProcessedStripeEvent y LUEGO
 * finalizaba, fuera de transacción. Si el finalizador tronaba (la base se cae un momento), el reclamo se quedaba y el reintento
 * de Stripe chocaba con P2002 → «duplicado, ignorado»: cobrado en Stripe, sin registro local, para siempre. Mismo contrato que
 * la liga por Checkout (`withClaimedEvent`, creditPackRetry.test.ts).
 */
const piEvent = (type: 'venue_checkout' | 'payment_link', id = 'evt_pi') => ({
  id,
  type: 'payment_intent.succeeded',
  account: 'acct_123',
  livemode: false,
  data: { id: 'pi_1', amount_received: 1000, metadata: { type } },
})
const finalizador = { venue_checkout: finalizeVenueCheckout, payment_link: finalizePaymentLinkCheckout } as const
const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

describe.each(['venue_checkout', 'payment_link'] as const)('payment_intent.succeeded (%s) — reintento seguro', tipo => {
  const finalizar = finalizador[tipo] as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.processedStripeEvent.create.mockResolvedValue({ processedAt: new Date() } as any)
    prismaMock.processedStripeEvent.deleteMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.checkoutSession.findUnique.mockResolvedValue({ status: 'COMPLETED' } as any)
    finalizar.mockResolvedValue(undefined)
  })

  it('🔴 el guardado truena → se libera el reclamo y el error se propaga; la 2.ª entrega SÍ guarda', async () => {
    finalizar.mockRejectedValueOnce(new Error('db blip'))

    await expect(processStripeConnectWebhookEvent(piEvent(tipo))).rejects.toThrow('db blip')
    expect(prismaMock.processedStripeEvent.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: 'connect', stripeEventId: 'evt_pi', processedAt: expect.any(Date) },
    })

    await processStripeConnectWebhookEvent(piEvent(tipo))
    expect(finalizar).toHaveBeenCalledTimes(2)
  })

  it('duplicado con la sesión ya COMPLETED → 2xx sin volver a guardar', async () => {
    prismaMock.processedStripeEvent.create.mockRejectedValue(p2002())

    await expect(processStripeConnectWebhookEvent(piEvent(tipo))).resolves.toBeUndefined()
    expect(finalizar).not.toHaveBeenCalled()
  })

  it('duplicado mientras otra entrega sigue guardando → no-2xx para que Stripe reintente', async () => {
    prismaMock.processedStripeEvent.create.mockRejectedValue(p2002())
    prismaMock.checkoutSession.findUnique.mockResolvedValue({ status: 'PENDING' } as any)
    prismaMock.processedStripeEvent.findUnique.mockResolvedValue({ processedAt: new Date(Date.now() - 10_000) } as any)

    await expect(processStripeConnectWebhookEvent(piEvent(tipo))).rejects.toMatchObject({ code: 'STRIPE_EVENT_IN_PROGRESS' })
    expect(finalizar).not.toHaveBeenCalled()
  })

  it('el finalizador vuelve sin guardar (la sesión sigue PENDING) → no-2xx, no se reconoce como hecho', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue({ status: 'PENDING' } as any)

    await expect(processStripeConnectWebhookEvent(piEvent(tipo))).rejects.toMatchObject({ code: 'STRIPE_WORK_NOT_MATERIALIZED' })
    expect(prismaMock.processedStripeEvent.deleteMany).toHaveBeenCalled()
  })

  // Codex r1 del P1: el Checkout alojado guarda su sesión con `cs_…` y copia `type` al PaymentIntent, así que su
  // `payment_intent.succeeded` también llega aquí. Ese pago lo registra `checkout.session.completed`; sin sesión `pi_…` el aviso
  // no es nuestro y se reconoce (2xx), o Stripe lo reintentaría 3 días aunque el pago ya exista.
  it('sin sesión local con ese PaymentIntent (Checkout alojado) → 2xx, sin reclamar ni finalizar', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(null)

    await expect(processStripeConnectWebhookEvent(piEvent(tipo))).resolves.toBeUndefined()
    expect(prismaMock.processedStripeEvent.create).not.toHaveBeenCalled()
    expect(finalizar).not.toHaveBeenCalled()
  })
})

// Codex r2 del P1: el finalizador ahora lanza si no sabe el tipo y Stripe no contesta (cierre de OXXO). El Checkout alojado sólo
// acepta tarjeta, pero su aviso no traía el tipo: con Stripe caído un momento ya no se guardaba. El aviso trae la lista de métodos
// permitidos; si es uno solo, ése es el tipo.
describe('checkout.session.completed de la liga (Checkout alojado) — el tipo sale de los métodos permitidos', () => {
  const hostedEvent = (payment_method_types: string[]) => ({
    id: 'evt_cs',
    type: 'checkout.session.completed',
    account: 'acct_123',
    livemode: false,
    data: { id: 'cs_1', payment_status: 'paid', amount_total: 1000, payment_method_types, metadata: { type: 'payment_link' } },
  })

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.processedStripeEvent.create.mockResolvedValue({ processedAt: new Date() } as any)
    prismaMock.checkoutSession.findUnique.mockResolvedValue({ status: 'COMPLETED' } as any)
  })

  it('sólo tarjeta → el finalizador recibe «card» (no depende de consultar el cargo)', async () => {
    await processStripeConnectWebhookEvent(hostedEvent(['card']))
    expect(finalizePaymentLinkCheckout).toHaveBeenCalledWith(expect.objectContaining({ stripePaymentMethodType: 'card' }))
  })

  it('varios métodos → sin tipo: lo dice el cargo', async () => {
    await processStripeConnectWebhookEvent(hostedEvent(['card', 'oxxo']))
    expect(finalizePaymentLinkCheckout).toHaveBeenCalledWith(expect.objectContaining({ stripePaymentMethodType: null }))
  })
})

describe('payment_intent.payment_failed — reintento seguro', () => {
  const failedEvent = () => ({
    id: 'evt_fail',
    type: 'payment_intent.payment_failed',
    account: 'acct_123',
    livemode: false,
    data: { id: 'pi_1', metadata: { type: 'payment_link' }, last_payment_error: { message: 'declined' } },
  })

  beforeEach(() => jest.clearAllMocks())

  it('🔴 reclamo y marca van en UNA transacción: si la marca truena, el reclamo no queda y la 2.ª entrega marca', async () => {
    prismaMock.processedStripeEvent.create.mockResolvedValue({ processedAt: new Date() } as any)
    prismaMock.checkoutSession.updateMany.mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce({ count: 1 } as any)

    await expect(processStripeConnectWebhookEvent(failedEvent())).rejects.toThrow('db blip')
    expect(prismaMock.$transaction).toHaveBeenCalled()

    await processStripeConnectWebhookEvent(failedEvent())
    expect(prismaMock.checkoutSession.updateMany).toHaveBeenCalledTimes(2)
  })
})
