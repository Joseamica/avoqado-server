/**
 * 19-oct (relevo Mesas40): un cobro de Stripe pagado en OXXO se guardaba como CASH. `fundsFlow` lo salvaba del arqueo, pero
 * la conciliación, el saldo, la póliza y el corte deciden por `method === 'CASH'` (Codex r2 de Mercado Pago, 16-oct): lo
 * trataban como efectivo del cajón. Y el checkout del negocio (`automatic_payment_methods`, puede ofrecer OXXO) ni siquiera
 * sellaba `fundsFlow`. Mismo arreglo que OXXO de Mercado Pago (`metodoDeMercadoPago`): OTHER con forma SAT 01.
 */
jest.mock('@/services/venueSalesGuard', () => ({ assertVenueSalesEnabled: jest.fn() }))
// El finalizador hace `new Stripe(...)` para leer el cargo (marca, últimos 4, recibo y el TIPO real del cobro).
const retrievePi = jest.fn()
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ paymentIntents: { retrieve: retrievePi } })),
}))

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { finalizeVenueCheckout } from '../../../../src/services/dashboard/venueCheckout.service'
import { fundsFlowForStripePayment, metodoDeStripe } from '../../../../src/services/dashboard/paymentLink.service'
import { mapFormaPago } from '../../../../src/services/fiscal/satCatalog'
import { paymentCountsAsDrawerCash } from '../../../../src/services/shared/tenderSemantics'

describe('método de un cobro de Stripe', () => {
  it.each([
    ['oxxo', 'OTHER', '01'],
    ['customer_balance', 'BANK_TRANSFER', '03'],
    ['card', 'CREDIT_CARD', '04'],
    ['card_present', 'CREDIT_CARD', '04'],
    [null, 'CREDIT_CARD', '04'],
    ['algo_nuevo_de_stripe', 'OTHER', '99'],
  ])('%s → %s (SAT %s), y nunca cuenta como efectivo del cajón', (tipo, method, formaSat) => {
    const m = metodoDeStripe(tipo)
    expect(m.method).toBe(method)
    expect(mapFormaPago(m.method, m.tenderSatFormaPago)).toBe(formaSat)
    expect(paymentCountsAsDrawerCash({ method: m.method, fundsFlow: fundsFlowForStripePayment(tipo) })).toBe(false)
  })
})

describe('checkout del negocio (finalizeVenueCheckout)', () => {
  const sesion = () => ({
    id: 'cs-1',
    sessionId: 'pi_stripe_1',
    status: 'PENDING',
    amount: new Decimal(100),
    applicationFeeCents: 0,
    metadata: {},
    customerEmail: null,
    ecommerceMerchant: { id: 'em-1', venueId: 'FULLTEST-A', providerCredentials: null, provider: { code: 'STRIPE_CONNECT' } },
  })

  beforeEach(() => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue(sesion())
    prismaMock.order.create.mockResolvedValue({ id: 'o-1' })
  })

  it('OXXO se guarda como OTHER con SAT 01 y sellado como dinero que liquida Stripe', async () => {
    await finalizeVenueCheckout({ stripeSessionId: 'pi_stripe_1', paymentIntentId: 'pi_1', stripePaymentMethodType: 'oxxo' })

    const data = prismaMock.payment.create.mock.calls[0][0].data
    expect(data.method).toBe('OTHER')
    expect(mapFormaPago(data.method, data.tenderSatFormaPago)).toBe('01')
    expect(data.fundsFlow).toBe('AVOQADO_PROCESSED')
    expect(paymentCountsAsDrawerCash(data)).toBe(false)
  })

  // Codex r1: el webhook casi nunca trae el tipo (no expande `latest_charge`) → un OXXO caía a CREDIT_CARD / SAT 04.
  it('sin tipo en el webhook, el tipo sale del cargo que se consulta a Stripe: OXXO → OTHER + SAT 01', async () => {
    prismaMock.checkoutSession.findUnique.mockResolvedValue({
      ...sesion(),
      ecommerceMerchant: { id: 'em-1', venueId: 'FULLTEST-A', providerCredentials: { connectAccountId: 'acct_1' }, provider: { code: 'STRIPE_CONNECT' } },
    })
    retrievePi.mockResolvedValue({ latest_charge: { receipt_url: null, payment_method_details: { type: 'oxxo' } } })

    await finalizeVenueCheckout({ stripeSessionId: 'pi_stripe_1', paymentIntentId: 'pi_1', stripePaymentMethodType: null })

    const data = prismaMock.payment.create.mock.calls[0][0].data
    expect(data.method).toBe('OTHER')
    expect(mapFormaPago(data.method, data.tenderSatFormaPago)).toBe('01')
    expect(paymentCountsAsDrawerCash(data)).toBe(false)
  })

  it('una tarjeta también queda sellada (antes este camino no sellaba nada)', async () => {
    await finalizeVenueCheckout({ stripeSessionId: 'pi_stripe_1', paymentIntentId: 'pi_1', stripePaymentMethodType: 'card' })

    const data = prismaMock.payment.create.mock.calls[0][0].data
    expect(data.method).toBe('CREDIT_CARD')
    expect(data.fundsFlow).toBe('AVOQADO_PROCESSED')
  })
})
