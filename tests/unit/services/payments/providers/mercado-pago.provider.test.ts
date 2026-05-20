import { MercadoPagoProvider } from '@/services/payments/providers/mercado-pago.provider'
import { getProvider } from '@/services/payments/provider-registry'
import { ProviderCapabilityError } from '@/services/payments/providers/not-implemented.error'
import * as connectionService from '@/services/mercado-pago/connection.service'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import * as paymentService from '@/services/mercado-pago/payment.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/mercado-pago/connection.service')
jest.mock('@/services/mercado-pago/oauth.service')
jest.mock('@/services/mercado-pago/payment.service')

const mockPrisma = prisma as unknown as {
  checkoutSession: { findUnique: jest.Mock }
}

const baseMerchant = {
  id: 'em_1',
  providerCredentials: {},
  sandboxMode: true,
  venueId: 'v_1',
  provider: { code: 'MERCADO_PAGO' },
}

describe('provider registry', () => {
  it('returns MercadoPagoProvider for code MERCADO_PAGO', () => {
    expect(getProvider(baseMerchant as any)).toBeInstanceOf(MercadoPagoProvider)
  })
})

describe('MercadoPagoProvider.createOnboardingLink', () => {
  beforeEach(() => jest.clearAllMocks())

  it('signs OAuth state with venue+merchant+staffId and returns the authorize URL', async () => {
    ;(oauthService.signState as jest.Mock).mockReturnValue('signed-state-jwt')
    ;(oauthService.buildAuthUrl as jest.Mock).mockReturnValue(
      'https://auth.mercadopago.com.mx/authorization?client_id=x&state=signed-state-jwt',
    )

    const provider = new MercadoPagoProvider()
    const result = await provider.createOnboardingLink(baseMerchant as any)

    expect(oauthService.signState).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'connect_merchant',
        ecommerceMerchantId: 'em_1',
        venueId: 'v_1',
        // staffId is "" at the provider layer — the controller will replace it
        // with the actual authContext.userId before calling buildAuthUrl directly.
      }),
    )
    expect(result.url).toBe('https://auth.mercadopago.com.mx/authorization?client_id=x&state=signed-state-jwt')
    expect(result.expiresAt).toBeInstanceOf(Date)
  })

  it('throws when merchant.venueId is missing', async () => {
    const provider = new MercadoPagoProvider()
    await expect(provider.createOnboardingLink({ ...baseMerchant, venueId: undefined } as any)).rejects.toThrow(/venueId/i)
  })
})

describe('MercadoPagoProvider.getOnboardingStatus', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns NOT_STARTED when no credentials exist', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue(null)

    const status = await new MercadoPagoProvider().getOnboardingStatus(baseMerchant as any)
    expect(status).toEqual({
      status: 'NOT_STARTED',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: [],
      disabledReason: null,
    })
  })

  it('returns COMPLETED when credentials exist and not expired', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({
      mpUserId: '12345678',
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 30 * 86400_000),
      scope: 'offline_access',
      liveMode: false,
      publicKey: 'pk',
    })

    const status = await new MercadoPagoProvider().getOnboardingStatus(baseMerchant as any)
    expect(status.status).toBe('COMPLETED')
    expect(status.chargesEnabled).toBe(true)
    expect(status.payoutsEnabled).toBe(true)
  })

  it('returns RESTRICTED when token has expired', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({
      mpUserId: '12345678',
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() - 86400_000), // expired
      scope: 'offline_access',
      liveMode: false,
      publicKey: 'pk',
    })

    const status = await new MercadoPagoProvider().getOnboardingStatus(baseMerchant as any)
    expect(status.status).toBe('RESTRICTED')
    expect(status.chargesEnabled).toBe(false)
    expect(status.requirementsDue).toContain('token_expired')
  })
})

describe('MercadoPagoProvider.createCheckoutSession', () => {
  beforeEach(() => jest.clearAllMocks())

  it('throws when merchant has no MP credentials', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue(null)

    await expect(
      new MercadoPagoProvider().createCheckoutSession(baseMerchant as any, {
        amount: 10000,
        currency: 'MXN',
        applicationFeeAmount: 500,
        successUrl: 'https://a',
        cancelUrl: 'https://b',
        expiresAt: new Date(Date.now() + 86400_000),
        metadata: { orderId: 'order_xyz' },
        description: 'Test',
        idempotencyKey: 'idem-1',
        paymentMethodTypes: ['card'],
      }),
    ).rejects.toThrow(/no ha conectado/i)
  })

  it('throws when amount is zero or negative', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({
      accessToken: 'token',
      publicKey: 'pk',
    })

    await expect(
      new MercadoPagoProvider().createCheckoutSession(baseMerchant as any, {
        amount: 0,
        currency: 'MXN',
        applicationFeeAmount: 0,
        successUrl: 'https://a',
        cancelUrl: 'https://b',
        expiresAt: new Date(Date.now() + 86400_000),
        metadata: {},
        description: 'Test',
        idempotencyKey: 'idem-1',
        paymentMethodTypes: ['card'],
      }),
    ).rejects.toThrow(/mayor a cero/i)
  })

  it('throws when applicationFeeAmount exceeds amount', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({
      accessToken: 'token',
      publicKey: 'pk',
    })

    await expect(
      new MercadoPagoProvider().createCheckoutSession(baseMerchant as any, {
        amount: 5000,
        currency: 'MXN',
        applicationFeeAmount: 6000, // > amount
        successUrl: 'https://a',
        cancelUrl: 'https://b',
        expiresAt: new Date(Date.now() + 86400_000),
        metadata: {},
        description: 'Test',
        idempotencyKey: 'idem-1',
        paymentMethodTypes: ['card'],
      }),
    ).rejects.toThrow(/no puede exceder/i)
  })

  it('returns a stable sessionId (= idempotencyKey) for the Brick flow', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({
      accessToken: 'token',
      publicKey: 'pk',
    })

    const expiresAt = new Date(Date.now() + 86400_000)
    const result = await new MercadoPagoProvider().createCheckoutSession(baseMerchant as any, {
      amount: 10000,
      currency: 'MXN',
      applicationFeeAmount: 500,
      successUrl: 'https://avoqado.io/success',
      cancelUrl: 'https://avoqado.io/cancel',
      expiresAt,
      metadata: { orderId: 'order_xyz' },
      description: 'Sesión yoga',
      idempotencyKey: 'cs_mp_idem_xyz',
      paymentMethodTypes: ['card'],
    })

    expect(result.id).toBe('cs_mp_idem_xyz')
    expect(result.expiresAt).toBe(expiresAt)
    expect(typeof result.url).toBe('string')
  })
})

describe('MercadoPagoProvider.getPaymentStatus', () => {
  beforeEach(() => jest.clearAllMocks())

  it('throws when CheckoutSession is not found', async () => {
    mockPrisma.checkoutSession.findUnique.mockResolvedValue(null)
    await expect(new MercadoPagoProvider().getPaymentStatus(baseMerchant as any, 'cs_missing')).rejects.toThrow(/no encontrada/i)
  })

  it('returns PENDING from DB when mpPaymentId is null (payment not initiated yet)', async () => {
    mockPrisma.checkoutSession.findUnique.mockResolvedValue({
      mpPaymentId: null,
      status: 'PENDING',
      completedAt: null,
    })

    const result = await new MercadoPagoProvider().getPaymentStatus(baseMerchant as any, 'cs_1')
    expect(result.status).toBe('PENDING')
    expect(result.paidAt).toBeUndefined()
  })

  it('returns PAID from DB when mpPaymentId is null but session.status is COMPLETED', async () => {
    const completedAt = new Date('2026-05-20T19:00:00Z')
    mockPrisma.checkoutSession.findUnique.mockResolvedValue({
      mpPaymentId: null,
      status: 'COMPLETED',
      completedAt,
    })

    const result = await new MercadoPagoProvider().getPaymentStatus(baseMerchant as any, 'cs_1')
    expect(result.status).toBe('PAID')
    expect(result.paidAt).toBe(completedAt)
  })

  it('hits MP API and maps approved → PAID when mpPaymentId is set', async () => {
    mockPrisma.checkoutSession.findUnique.mockResolvedValue({
      mpPaymentId: '9999',
      status: 'COMPLETED',
      completedAt: new Date('2026-05-20T19:00:00Z'),
    })
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({ accessToken: 'tok' })
    ;(paymentService.getPayment as jest.Mock).mockResolvedValue({
      id: 9999,
      status: 'approved',
      transaction_amount: 100,
      currency_id: 'MXN',
      date_approved: '2026-05-20T19:00:30Z',
      application_fee: 5,
    })

    const result = await new MercadoPagoProvider().getPaymentStatus(baseMerchant as any, 'cs_1')
    expect(result.status).toBe('PAID')
    expect(result.paymentIntentId).toBe('9999')
    expect(result.amountPaid).toBe(100)
    expect(result.applicationFeeAmount).toBe(5)
    expect(result.paidAt).toBeInstanceOf(Date)
  })

  it('maps MP status to PaymentStatus enum correctly', async () => {
    const mappings = [
      ['approved', 'PAID'],
      ['authorized', 'PAID'],
      ['pending', 'PENDING'],
      ['in_process', 'PENDING'],
      ['in_mediation', 'PENDING'],
      ['rejected', 'FAILED'],
      ['cancelled', 'FAILED'],
      ['refunded', 'REFUNDED'],
      ['charged_back', 'DISPUTED'],
    ] as const

    for (const [mpStatus, expectedStatus] of mappings) {
      mockPrisma.checkoutSession.findUnique.mockResolvedValue({
        mpPaymentId: '9999',
        status: 'PENDING',
        completedAt: null,
      })
      ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({ accessToken: 'tok' })
      ;(paymentService.getPayment as jest.Mock).mockResolvedValue({
        id: 9999,
        status: mpStatus,
        transaction_amount: 100,
        currency_id: 'MXN',
        date_approved: null,
      })

      const result = await new MercadoPagoProvider().getPaymentStatus(baseMerchant as any, 'cs_1')
      expect(result.status).toBe(expectedStatus)
    }
  })
})

describe('MercadoPagoProvider.refund', () => {
  beforeEach(() => jest.clearAllMocks())

  it('throws when credentials are missing', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue(null)

    await expect(
      new MercadoPagoProvider().refund(baseMerchant as any, {
        paymentIntentId: '9999',
        amount: 1000,
        refundApplicationFee: true,
        idempotencyKey: 'idem-refund-1',
        metadata: {},
      }),
    ).rejects.toThrow(/no disponibles/i)
  })

  it('converts centavos → MXN before calling MP refund', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({ accessToken: 'tok' })
    ;(paymentService.refundPayment as jest.Mock).mockResolvedValue({
      id: 11111,
      payment_id: 9999,
      amount: 25, // MXN
      status: 'approved',
    })

    const result = await new MercadoPagoProvider().refund(baseMerchant as any, {
      paymentIntentId: '9999',
      amount: 2500, // centavos
      refundApplicationFee: true,
      idempotencyKey: 'idem-refund-1',
      metadata: {},
    })

    // Caller passed 2500 cents → service should call MP with 25 MXN
    expect(paymentService.refundPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 25, accessToken: 'tok', paymentId: '9999' }),
    )
    // Result.amount is returned as cents back to the interface contract
    expect(result.amount).toBe(2500)
    expect(result.refundId).toBe('11111')
    expect(result.status).toBe('SUCCEEDED')
  })

  it('full refund (no amount) does not divide undefined by 100', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({ accessToken: 'tok' })
    ;(paymentService.refundPayment as jest.Mock).mockResolvedValue({
      id: 22222,
      payment_id: 9999,
      amount: 100,
      status: 'approved',
    })

    const result = await new MercadoPagoProvider().refund(baseMerchant as any, {
      paymentIntentId: '9999',
      // amount undefined → full refund
      refundApplicationFee: true,
      idempotencyKey: 'idem-refund-2',
      metadata: {},
    })

    const refundCall = (paymentService.refundPayment as jest.Mock).mock.calls[0][0]
    expect(refundCall.amount).toBeUndefined()
    expect(result.amount).toBe(10000) // 100 MXN → 10000 cents back to contract
  })

  it('maps MP "in_process" → PENDING', async () => {
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({ accessToken: 'tok' })
    ;(paymentService.refundPayment as jest.Mock).mockResolvedValue({
      id: 11,
      payment_id: 9999,
      amount: 100,
      status: 'in_process',
    })

    const result = await new MercadoPagoProvider().refund(baseMerchant as any, {
      paymentIntentId: '9999',
      refundApplicationFee: true,
      idempotencyKey: 'idem-pending',
      metadata: {},
    })

    expect(result.status).toBe('PENDING')
  })
})

describe('MercadoPagoProvider capability errors', () => {
  it('throws ProviderCapabilityError on tokenizeCard (MP Bricks tokenizes in iframe)', async () => {
    await expect(new MercadoPagoProvider().tokenizeCard(baseMerchant as any, {} as any)).rejects.toThrow(ProviderCapabilityError)
  })

  it('throws ProviderCapabilityError on authorizeCardPayment', async () => {
    await expect(new MercadoPagoProvider().authorizeCardPayment(baseMerchant as any, {} as any)).rejects.toThrow(ProviderCapabilityError)
  })

  it('throws ProviderCapabilityError on verifyWebhookSignature (use webhook controller directly)', async () => {
    await expect(new MercadoPagoProvider().verifyWebhookSignature('', '', 'platform')).rejects.toThrow(ProviderCapabilityError)
  })
})
