import { BadRequestError } from '@/errors/AppError'
import { ProviderCapabilityError } from '@/services/payments/providers/not-implemented.error'
import { BlumonProvider } from '@/services/payments/providers/blumon.provider'
import { MercadoPagoProvider } from '@/services/payments/providers/mercado-pago.provider'
import { getStripeChargeBoundsCents } from '@/services/payments/providers/money'

const mockStripe = {
  checkout: { sessions: { create: jest.fn(), retrieve: jest.fn(), expire: jest.fn() } },
  paymentIntents: { retrieve: jest.fn(), capture: jest.fn(), cancel: jest.fn() },
}

jest.mock('stripe', () => jest.fn().mockImplementation(() => mockStripe))

import { StripeConnectProvider } from '@/services/payments/providers/stripe-connect.provider'

const merchant = {
  id: 'em_1',
  providerCredentials: { connectAccountId: 'acct_x' },
  sandboxMode: true,
  provider: { code: 'STRIPE_CONNECT' },
}
const merchantSinCuenta = { ...merchant, providerCredentials: {} }

const piBase = {
  id: 'pi_1',
  status: 'requires_capture',
  amount_capturable: 30000,
  amount_received: 0,
  latest_charge: {
    payment_method_details: {
      type: 'card',
      card: { brand: 'visa', last4: '4242', funding: 'debit', capture_before: 1730000000 },
    },
  },
}

const stripeError = (code: string) => Object.assign(new Error('boom'), { type: 'StripeInvalidRequestError', code })

describe('StripeConnectProvider — apartar, cobrar, liberar, leer', () => {
  let provider: StripeConnectProvider

  beforeEach(() => {
    jest.clearAllMocks()
    provider = new StripeConnectProvider('sk_test_x')
  })

  describe('createAuthorizationCheckout', () => {
    const params = {
      amountCents: 30000,
      currency: 'MXN' as const,
      description: 'Pedido 123',
      successUrl: 'https://x/ok',
      cancelUrl: 'https://x/cancel',
      expiresAt: new Date('2026-10-28T12:00:00Z'),
      metadata: { type: 'online_order', chargeId: 'c1', venueId: 'v1' },
      idempotencyKey: 'k',
    }

    it('manda capture_method manual, sin application_fee_amount, con stripeAccount e idempotencyKey', async () => {
      mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_1', url: 'https://stripe/cs_1', expires_at: 1730000000 })

      const res = await provider.createAuthorizationCheckout(merchant as any, params)

      const [body, opts] = mockStripe.checkout.sessions.create.mock.calls[0]
      expect(body.mode).toBe('payment')
      expect(body.payment_method_types).toEqual(['card'])
      expect(body.payment_intent_data.capture_method).toBe('manual')
      expect(body.payment_intent_data.application_fee_amount).toBeUndefined()
      expect(body.payment_intent_data.metadata).toEqual(params.metadata)
      expect(body.line_items[0].price_data).toMatchObject({ currency: 'mxn', unit_amount: 30000 })
      expect(opts).toEqual({ stripeAccount: 'acct_x', idempotencyKey: 'k' })
      expect(res).toEqual({ id: 'cs_1', url: 'https://stripe/cs_1', expiresAt: new Date(1730000000 * 1000) })
    })

    it('rechaza montos fuera de los topes', async () => {
      const { min, max } = getStripeChargeBoundsCents()
      await expect(provider.createAuthorizationCheckout(merchant as any, { ...params, amountCents: min - 1 })).rejects.toBeInstanceOf(
        BadRequestError,
      )
      await expect(provider.createAuthorizationCheckout(merchant as any, { ...params, amountCents: max + 1 })).rejects.toBeInstanceOf(
        BadRequestError,
      )
      expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled()
    })
  })

  describe('getAuthorization', () => {
    it('por sesión expande el PaymentIntent y traduce capture_before', async () => {
      mockStripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_1', status: 'complete', payment_intent: piBase })

      const state = await provider.getAuthorization(merchant as any, { checkoutSessionId: 'cs_1' })

      expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalledWith(
        'cs_1',
        { expand: ['payment_intent.latest_charge'] },
        { stripeAccount: 'acct_x' },
      )
      expect(state).toEqual({
        sessionStatus: 'complete',
        paymentIntentId: 'pi_1',
        piStatus: 'requires_capture',
        amountCapturableCents: 30000,
        amountReceivedCents: 0,
        captureBefore: new Date(1730000000 * 1000),
        card: { brand: 'visa', last4: '4242', funding: 'debit' },
        paymentMethodType: 'card',
        applicationFeeCents: 0,
      })
    })

    it('sesión abierta sin PaymentIntent regresa estado vacío', async () => {
      mockStripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_1', status: 'open', payment_intent: null })

      const state = await provider.getAuthorization(merchant as any, { checkoutSessionId: 'cs_1' })

      expect(state).toMatchObject({
        sessionStatus: 'open',
        paymentIntentId: null,
        piStatus: null,
        amountCapturableCents: 0,
        amountReceivedCents: 0,
        captureBefore: null,
        card: null,
        paymentMethodType: null,
      })
    })

    it('por paymentIntentId lee el PI con latest_charge expandido', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue(piBase)

      const state = await provider.getAuthorization(merchant as any, { paymentIntentId: 'pi_1' })

      expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_1', { expand: ['latest_charge'] }, { stripeAccount: 'acct_x' })
      expect(state.sessionStatus).toBeNull()
      expect(state.piStatus).toBe('requires_capture')
    })

    it('Codex r3 #3: lee la comisión que Stripe SÍ cobró (application_fee_amount); un cobro a mano sin comisión da 0', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({ ...piBase, status: 'succeeded', application_fee_amount: 290 })
      expect((await provider.getAuthorization(merchant as any, { paymentIntentId: 'pi_1' })).applicationFeeCents).toBe(290)
      mockStripe.paymentIntents.retrieve.mockResolvedValueOnce({ ...piBase, status: 'succeeded', application_fee_amount: null })
      expect((await provider.getAuthorization(merchant as any, { paymentIntentId: 'pi_1' })).applicationFeeCents).toBe(0)
    })
  })

  describe('capture', () => {
    const params = { paymentIntentId: 'pi_1', amountCents: 25000, applicationFeeCents: 290, idempotencyKey: 'online-order:o1:capture' }

    it('manda amount_to_capture y application_fee_amount en centavos', async () => {
      mockStripe.paymentIntents.capture.mockResolvedValue({ ...piBase, status: 'succeeded', amount_received: 25000, amount_capturable: 0 })

      const state = await provider.capture(merchant as any, params)

      expect(mockStripe.paymentIntents.capture).toHaveBeenCalledWith(
        'pi_1',
        { amount_to_capture: 25000, application_fee_amount: 290, expand: ['latest_charge'] },
        { stripeAccount: 'acct_x', idempotencyKey: 'online-order:o1:capture' },
      )
      expect(state.piStatus).toBe('succeeded')
      expect(state.amountReceivedCents).toBe(25000)
      expect(state.card).toEqual({ brand: 'visa', last4: '4242', funding: 'debit' })
      expect(state.captureBefore).toEqual(new Date(1730000000 * 1000))
    })

    it('NO lanza si Stripe responde error pero el PI ya está succeeded', async () => {
      mockStripe.paymentIntents.capture.mockRejectedValue(stripeError('payment_intent_unexpected_state'))
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        ...piBase,
        status: 'succeeded',
        amount_received: 25000,
        application_fee_amount: 290,
      })

      const state = await provider.capture(merchant as any, params)

      expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_1', { expand: ['latest_charge'] }, { stripeAccount: 'acct_x' })
      expect(state.piStatus).toBe('succeeded')
    })

    it('lanza el error original si el PI quedó succeeded pero con otro monto cobrado', async () => {
      const original = stripeError('payment_intent_unexpected_state')
      mockStripe.paymentIntents.capture.mockRejectedValue(original)
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        ...piBase,
        status: 'succeeded',
        amount_received: 10000,
        application_fee_amount: 290,
      })

      await expect(provider.capture(merchant as any, params)).rejects.toBe(original)
    })

    it('lanza el error original si el PI quedó succeeded pero con otra comisión (o sin ella)', async () => {
      const original = stripeError('payment_intent_unexpected_state')
      mockStripe.paymentIntents.capture.mockRejectedValue(original)
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        ...piBase,
        status: 'succeeded',
        amount_received: 25000,
        application_fee_amount: null,
      })

      await expect(provider.capture(merchant as any, params)).rejects.toBe(original)
    })

    it('un error que no es de Stripe se relanza sin leer el PI', async () => {
      const original = new Error('boom')
      mockStripe.paymentIntents.capture.mockRejectedValue(original)

      await expect(provider.capture(merchant as any, params)).rejects.toBe(original)
      expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled()
    })

    it('lanza el error original si tras fallar el PI sigue requires_capture', async () => {
      const original = stripeError('card_declined')
      mockStripe.paymentIntents.capture.mockRejectedValue(original)
      mockStripe.paymentIntents.retrieve.mockResolvedValue(piBase)

      await expect(provider.capture(merchant as any, params)).rejects.toBe(original)
    })

    it('lanza el error original si el retrieve de recuperación también falla', async () => {
      const original = stripeError('api_connection_error')
      mockStripe.paymentIntents.capture.mockRejectedValue(original)
      mockStripe.paymentIntents.retrieve.mockRejectedValue(new Error('network'))

      await expect(provider.capture(merchant as any, params)).rejects.toBe(original)
    })

    it('rechaza comisión mayor al monto', async () => {
      await expect(provider.capture(merchant as any, { ...params, applicationFeeCents: 25001 })).rejects.toBeInstanceOf(BadRequestError)
      expect(mockStripe.paymentIntents.capture).not.toHaveBeenCalled()
    })
  })

  describe('voidAuthorization', () => {
    const params = { paymentIntentId: 'pi_1', idempotencyKey: 'online-order:o1:void' }

    it('usa paymentIntents.cancel', async () => {
      mockStripe.paymentIntents.cancel.mockResolvedValue({ ...piBase, status: 'canceled', amount_capturable: 0 })

      const state = await provider.voidAuthorization(merchant as any, params)

      expect(mockStripe.paymentIntents.cancel).toHaveBeenCalledWith(
        'pi_1',
        { expand: ['latest_charge'] },
        { stripeAccount: 'acct_x', idempotencyKey: 'online-order:o1:void' },
      )
      expect(state.piStatus).toBe('canceled')
      expect(state.card?.funding).toBe('debit')
    })

    it('tolera ya cancelado', async () => {
      mockStripe.paymentIntents.cancel.mockRejectedValue(stripeError('payment_intent_unexpected_state'))
      mockStripe.paymentIntents.retrieve.mockResolvedValue({ ...piBase, status: 'canceled', amount_capturable: 0 })

      const state = await provider.voidAuthorization(merchant as any, params)

      expect(state.piStatus).toBe('canceled')
    })

    it('lanza el error original si el PI sigue vivo', async () => {
      const original = stripeError('rate_limit')
      mockStripe.paymentIntents.cancel.mockRejectedValue(original)
      mockStripe.paymentIntents.retrieve.mockResolvedValue(piBase)

      await expect(provider.voidAuthorization(merchant as any, params)).rejects.toBe(original)
    })
  })

  describe('expireAuthorizationCheckout (S5: el comensal abandona el pago)', () => {
    it('vence la sesión en la cuenta conectada', async () => {
      mockStripe.checkout.sessions.expire.mockResolvedValue({ id: 'cs_1', status: 'expired' })

      await expect(provider.expireAuthorizationCheckout(merchant as any, 'cs_1')).resolves.toBeUndefined()

      expect(mockStripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_1', {}, { stripeAccount: 'acct_x' })
    })

    it('el error de Stripe sale tal cual (quien llama distingue «ya no se puede» de «sin respuesta»)', async () => {
      const original = stripeError('checkout_session_not_expirable')
      mockStripe.checkout.sessions.expire.mockRejectedValue(original)

      await expect(provider.expireAuthorizationCheckout(merchant as any, 'cs_1')).rejects.toBe(original)
    })
  })

  describe('sin connectAccountId lanza BadRequestError', () => {
    it.each([
      [
        'createAuthorizationCheckout',
        (p: StripeConnectProvider) =>
          p.createAuthorizationCheckout(merchantSinCuenta as any, {
            amountCents: 30000,
            currency: 'MXN',
            description: 'd',
            successUrl: 's',
            cancelUrl: 'c',
            expiresAt: new Date(),
            metadata: {},
            idempotencyKey: 'k',
          }),
      ],
      ['getAuthorization', (p: StripeConnectProvider) => p.getAuthorization(merchantSinCuenta as any, { paymentIntentId: 'pi_1' })],
      ['expireAuthorizationCheckout', (p: StripeConnectProvider) => p.expireAuthorizationCheckout(merchantSinCuenta as any, 'cs_1')],
      [
        'capture',
        (p: StripeConnectProvider) =>
          p.capture(merchantSinCuenta as any, { paymentIntentId: 'pi_1', amountCents: 100, applicationFeeCents: 1, idempotencyKey: 'k' }),
      ],
      [
        'voidAuthorization',
        (p: StripeConnectProvider) => p.voidAuthorization(merchantSinCuenta as any, { paymentIntentId: 'pi_1', idempotencyKey: 'k' }),
      ],
    ])('%s', async (_name, call) => {
      await expect(call(provider)).rejects.toBeInstanceOf(BadRequestError)
    })
  })

  describe('otros proveedores', () => {
    it.each([
      ['BlumonProvider', new BlumonProvider()],
      ['MercadoPagoProvider', new MercadoPagoProvider()],
    ])('%s lanza ProviderCapabilityError en los métodos de apartar y cobrar', async (_n, other) => {
      await expect(other.createAuthorizationCheckout({} as any, {} as any)).rejects.toBeInstanceOf(ProviderCapabilityError)
      await expect(other.getAuthorization({} as any, { paymentIntentId: 'x' })).rejects.toBeInstanceOf(ProviderCapabilityError)
      await expect(other.capture({} as any, {} as any)).rejects.toBeInstanceOf(ProviderCapabilityError)
      await expect(other.voidAuthorization({} as any, {} as any)).rejects.toBeInstanceOf(ProviderCapabilityError)
      await expect(other.expireAuthorizationCheckout({} as any, 'cs_1')).rejects.toBeInstanceOf(ProviderCapabilityError)
    })
  })

  describe('getStripeChargeBoundsCents', () => {
    const OLD = { ...process.env }
    afterEach(() => {
      process.env = { ...OLD }
    })

    it('usa los defaults', () => {
      delete process.env.STRIPE_MIN_CHARGE_MXN_CENTS
      delete process.env.STRIPE_MAX_CHARGE_MXN_CENTS
      expect(getStripeChargeBoundsCents()).toEqual({ min: 1000, max: 5000000 })
    })

    it('respeta las variables de entorno', () => {
      process.env.STRIPE_MIN_CHARGE_MXN_CENTS = '500'
      process.env.STRIPE_MAX_CHARGE_MXN_CENTS = '900000'
      expect(getStripeChargeBoundsCents()).toEqual({ min: 500, max: 900000 })
    })
  })
})
