import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/dashboard/creditPack.public.service', () => ({
  __esModule: true,
  fulfillPurchase: jest.fn(),
}))
jest.mock('@/services/dashboard/paymentLink.service', () => ({
  __esModule: true,
  finalizePaymentLinkCheckout: jest.fn(),
}))
jest.mock('@/services/dashboard/venueCheckout.service', () => ({ __esModule: true, finalizeVenueCheckout: jest.fn() }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: {} }))
jest.mock('@/services/whatsapp.service', () => ({
  __esModule: true,
  sendReservationConfirmationWhatsApp: jest.fn(),
  formatModifiersForWhatsApp: jest.fn(),
}))

import { processStripeConnectWebhookEvent } from '@/services/payments/reservation-deposit-webhook.service'
import { fulfillPurchase } from '@/services/dashboard/creditPack.public.service'
import { finalizePaymentLinkCheckout } from '@/services/dashboard/paymentLink.service'

/**
 * Auditoría 3 (P1): el webhook de Connect reclamaba el evento en ProcessedStripeEvent ANTES
 * del fulfillment. Si el fulfillment tronaba, el reintento de Stripe caía en P2002 y se
 * ignoraba como "duplicado": dinero cobrado, compra jamás otorgada, sin reintento posible.
 *
 * Contrato nuevo: el claim sigue yendo primero (protege de entregas concurrentes), pero si
 * el fulfillment falla, el claim SE LIBERA para que el reintento de Stripe vuelva a
 * ejecutarlo. Y un P2002 que nazca DENTRO del fulfillment no se confunde con "duplicado".
 */
const creditPackEvent = (id = 'evt_1') => ({
  id,
  type: 'checkout.session.completed',
  account: 'acct_123',
  livemode: false,
  data: { id: 'cs_test_1', payment_status: 'paid', metadata: { type: 'credit_pack_purchase' } },
})

const paymentLinkEvent = (id = 'evt_pl') => ({
  id,
  type: 'checkout.session.completed',
  account: 'acct_123',
  livemode: false,
  data: { id: 'cs_test_pl', payment_status: 'paid', amount_total: 1000, metadata: { type: 'payment_link' } },
})

const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

describe('webhook Connect — credit pack fulfillment retry-safe', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.processedStripeEvent.create.mockResolvedValue({} as any)
    prismaMock.processedStripeEvent.deleteMany.mockResolvedValue({ count: 1 } as any)
  })

  it('happy path: reclama, cumple, NO libera el claim', async () => {
    ;(fulfillPurchase as jest.Mock).mockResolvedValue({ id: 'purchase-1' })

    await processStripeConnectWebhookEvent(creditPackEvent())

    expect(prismaMock.processedStripeEvent.create).toHaveBeenCalledTimes(1)
    expect(fulfillPurchase).toHaveBeenCalledWith('cs_test_1', 'acct_123')
    expect(prismaMock.processedStripeEvent.deleteMany).not.toHaveBeenCalled()
  })

  it('🔴 el fulfillment falla → se libera el claim y el error se propaga (Stripe reintenta)', async () => {
    ;(fulfillPurchase as jest.Mock).mockRejectedValue(
      Object.assign(new Error('owner unresolved'), { code: 'CREDIT_PACK_OWNER_UNRESOLVED' }),
    )

    await expect(processStripeConnectWebhookEvent(creditPackEvent())).rejects.toMatchObject({ code: 'CREDIT_PACK_OWNER_UNRESOLVED' })

    expect(prismaMock.processedStripeEvent.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: 'connect', stripeEventId: 'evt_1' },
    })
  })

  it('🔴 reintento tras un fallo liberado → el fulfillment vuelve a correr (no se ignora como duplicado)', async () => {
    ;(fulfillPurchase as jest.Mock).mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce({ id: 'purchase-1' })

    await expect(processStripeConnectWebhookEvent(creditPackEvent())).rejects.toThrow('db blip')
    // El claim quedó liberado ⇒ la segunda entrega vuelve a reclamar sin P2002.
    await processStripeConnectWebhookEvent(creditPackEvent())

    expect(fulfillPurchase).toHaveBeenCalledTimes(2)
    expect(prismaMock.processedStripeEvent.create).toHaveBeenCalledTimes(2)
  })

  it('entrega duplicada (P2002 en el CLAIM) con el resultado YA materializado (la compra existe) → 200, sin correr el fulfillment ni liberar', async () => {
    prismaMock.processedStripeEvent.create.mockRejectedValue(p2002())
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue({ id: 'purchase-1' } as any)

    await expect(processStripeConnectWebhookEvent(creditPackEvent())).resolves.toBeUndefined()

    expect(fulfillPurchase).not.toHaveBeenCalled()
    expect(prismaMock.processedStripeEvent.deleteMany).not.toHaveBeenCalled()
  })

  // Auditoría 4: "B recibe P2002 y contesta 200 antes de saber si A terminará bien; si A falla
  // después, ya hubo una entrega reconocida sin fulfillment". Un duplicado sólo se reconoce
  // cuando el resultado está materializado; si no, Stripe debe seguir reintentando.
  it('🔴 duplicado (P2002) con claim RECIENTE y resultado NO materializado (A sigue trabajando) → no-2xx para que Stripe reintente; no se toca el claim', async () => {
    prismaMock.processedStripeEvent.create.mockRejectedValue(p2002())
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null)
    prismaMock.processedStripeEvent.findUnique.mockResolvedValue({ processedAt: new Date(Date.now() - 10_000) } as any)

    await expect(processStripeConnectWebhookEvent(creditPackEvent())).rejects.toMatchObject({ code: 'STRIPE_EVENT_IN_PROGRESS' })

    expect(fulfillPurchase).not.toHaveBeenCalled()
    expect(prismaMock.processedStripeEvent.deleteMany).not.toHaveBeenCalled()
  })

  // Auditoría 4: "si el proceso muere entre crear el claim y terminar el trabajo, el catch nunca
  // corre" / "si falla deleteMany el claim queda atascado". Lease: un claim viejo sin resultado
  // es un muerto → se libera y el reintento vuelve a correr el trabajo.
  it('🔴 duplicado (P2002) con claim VIEJO (>2 min) y resultado NO materializado (proceso murió) → libera el claim muerto y corre el fulfillment', async () => {
    prismaMock.processedStripeEvent.create.mockRejectedValueOnce(p2002()).mockResolvedValueOnce({} as any)
    prismaMock.creditPackPurchase.findUnique.mockResolvedValue(null)
    prismaMock.processedStripeEvent.findUnique.mockResolvedValue({ processedAt: new Date(Date.now() - 10 * 60_000) } as any)
    ;(fulfillPurchase as jest.Mock).mockResolvedValue({ id: 'purchase-1' })

    await expect(processStripeConnectWebhookEvent(creditPackEvent())).resolves.toBeUndefined()

    expect(prismaMock.processedStripeEvent.deleteMany).toHaveBeenCalledWith({ where: { endpoint: 'connect', stripeEventId: 'evt_1' } })
    expect(prismaMock.processedStripeEvent.create).toHaveBeenCalledTimes(2)
    expect(fulfillPurchase).toHaveBeenCalledTimes(1)
  })

  it('🔴 P2002 nacido DENTRO del fulfillment NO se confunde con "webhook duplicado": libera el claim y propaga', async () => {
    ;(fulfillPurchase as jest.Mock).mockRejectedValue(p2002())

    await expect(processStripeConnectWebhookEvent(creditPackEvent())).rejects.toMatchObject({ code: 'P2002' })

    expect(prismaMock.processedStripeEvent.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: 'connect', stripeEventId: 'evt_1' },
    })
  })

  it('si liberar el claim también falla, el error ORIGINAL del fulfillment es el que se propaga', async () => {
    ;(fulfillPurchase as jest.Mock).mockRejectedValue(new Error('fulfillment boom'))
    prismaMock.processedStripeEvent.deleteMany.mockRejectedValue(new Error('release boom'))

    await expect(processStripeConnectWebhookEvent(creditPackEvent())).rejects.toThrow('fulfillment boom')
  })

  it('misma regla para payment_link: fallo → libera el claim y propaga', async () => {
    ;(finalizePaymentLinkCheckout as jest.Mock).mockRejectedValue(new Error('pl boom'))

    await expect(processStripeConnectWebhookEvent(paymentLinkEvent())).rejects.toThrow('pl boom')

    expect(prismaMock.processedStripeEvent.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: 'connect', stripeEventId: 'evt_pl' },
    })
  })
})
