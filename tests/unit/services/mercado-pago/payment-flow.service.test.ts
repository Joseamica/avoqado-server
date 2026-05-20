import { handleIpn } from '@/services/mercado-pago/payment-flow.service'
import prisma from '@/utils/prismaClient'
import * as paymentService from '@/services/mercado-pago/payment.service'
import * as connectionService from '@/services/mercado-pago/connection.service'
import type { MercadoPagoWebhookPayload } from '@/services/mercado-pago/types'

jest.mock('@/services/mercado-pago/payment.service')
jest.mock('@/services/mercado-pago/connection.service')

const mockPrisma = prisma as unknown as {
  mercadoPagoWebhookEvent: { create: jest.Mock; updateMany: jest.Mock }
  ecommerceMerchant: { findFirst: jest.Mock }
  checkoutSession: { findFirst: jest.Mock; update: jest.Mock }
}

function buildPaymentPayload(overrides: Partial<MercadoPagoWebhookPayload> = {}): MercadoPagoWebhookPayload {
  return {
    id: 1,
    live_mode: false,
    type: 'payment',
    date_created: '2026-05-20T19:00:00Z',
    user_id: 12345678,
    api_version: 'v1',
    action: 'payment.updated',
    data: { id: '9999' },
    ...overrides,
  }
}

describe('handleIpn — happy path (payment approved)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('dedupes, fetches payment, finds CheckoutSession, updates DB', async () => {
    // 1. Dedupe insert succeeds (first time we see this event)
    mockPrisma.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'ev_1' })

    // 2. Merchant lookup by mpUserId
    mockPrisma.ecommerceMerchant.findFirst.mockResolvedValue({
      id: 'em_1',
      providerMerchantId: '12345678',
      venueId: 'v_1',
    })

    // 3. Credentials decryption returns valid creds
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({
      accessToken: 'SELLER-token',
      mpUserId: '12345678',
      publicKey: 'pk',
    })

    // 4. MP API returns the payment details
    ;(paymentService.getPayment as jest.Mock).mockResolvedValue({
      id: 9999,
      status: 'approved',
      status_detail: 'accredited',
      external_reference: 'cs_session_xyz',
      transaction_amount: 100,
      currency_id: 'MXN',
      date_approved: '2026-05-20T19:00:30Z',
      order: { id: 7777 },
      fee_details: [],
      application_fee: 5,
    })

    // 5. CheckoutSession lookup by external_reference
    mockPrisma.checkoutSession.findFirst.mockResolvedValue({
      id: 'cs_internal_1',
      sessionId: 'cs_session_xyz',
      mpPaymentId: null,
      status: 'PENDING',
      completedAt: null,
    })

    mockPrisma.checkoutSession.update.mockResolvedValue({ id: 'cs_internal_1' })
    mockPrisma.mercadoPagoWebhookEvent.updateMany.mockResolvedValue({ count: 1 })

    const result = await handleIpn({
      payload: buildPaymentPayload(),
      requestId: 'req-1',
    })

    expect(result).toEqual({
      status: 'processed',
      checkoutSessionId: 'cs_internal_1',
      paymentId: '9999',
    })

    // Verify dedupe insert was attempted with the right composite key
    const insertArgs = mockPrisma.mercadoPagoWebhookEvent.create.mock.calls[0][0]
    expect(insertArgs.data.mpUserId).toBe('12345678')
    expect(insertArgs.data.dataId).toBe('9999')
    expect(insertArgs.data.requestId).toBe('req-1')
    expect(insertArgs.data.eventType).toBe('payment')
    expect(insertArgs.data.action).toBe('payment.updated')
    expect(insertArgs.data.processingStatus).toBe('pending')

    // Verify MP API call used the seller's access token
    expect(paymentService.getPayment).toHaveBeenCalledWith('SELLER-token', '9999')

    // Verify CheckoutSession update wrote MP fields + status
    const updateArgs = mockPrisma.checkoutSession.update.mock.calls[0][0]
    expect(updateArgs.where).toEqual({ id: 'cs_internal_1' })
    expect(updateArgs.data.mpPaymentId).toBe('9999')
    expect(updateArgs.data.mpMerchantOrderId).toBe('7777')
    expect(updateArgs.data.status).toBe('COMPLETED')
    expect(updateArgs.data.completedAt).toBeInstanceOf(Date)

    // Verify dedupe row was marked processed at the end
    expect(mockPrisma.mercadoPagoWebhookEvent.updateMany).toHaveBeenCalledWith({
      where: { mpUserId: '12345678', dataId: '9999', requestId: 'req-1' },
      data: { processingStatus: 'processed', errorMessage: null },
    })
  })
})

describe('handleIpn — dedupe', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns {status:"duplicate"} when MercadoPagoWebhookEvent insert hits P2002', async () => {
    const dupError: any = new Error('Unique constraint failed')
    dupError.code = 'P2002'
    mockPrisma.mercadoPagoWebhookEvent.create.mockRejectedValue(dupError)

    const result = await handleIpn({
      payload: buildPaymentPayload(),
      requestId: 'req-1',
    })

    expect(result).toEqual({ status: 'duplicate' })

    // Downstream lookups MUST NOT happen on duplicate
    expect(mockPrisma.ecommerceMerchant.findFirst).not.toHaveBeenCalled()
    expect(paymentService.getPayment).not.toHaveBeenCalled()
  })

  it('re-throws non-P2002 prisma errors so caller logs them', async () => {
    const dbError: any = new Error('Connection lost')
    dbError.code = 'P1001'
    mockPrisma.mercadoPagoWebhookEvent.create.mockRejectedValue(dbError)

    await expect(handleIpn({ payload: buildPaymentPayload(), requestId: 'req-1' })).rejects.toThrow(/Connection lost/)
  })
})

describe('handleIpn — unsupported event types', () => {
  beforeEach(() => jest.clearAllMocks())

  it('ignores non-payment events (e.g. merchant_order)', async () => {
    mockPrisma.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'ev_1' })
    mockPrisma.mercadoPagoWebhookEvent.updateMany.mockResolvedValue({ count: 1 })

    const result = await handleIpn({
      payload: buildPaymentPayload({ type: 'merchant_order', action: 'merchant_order.created' }),
      requestId: 'req-1',
    })

    expect(result.status).toBe('ignored')
    if (result.status === 'ignored') {
      expect(result.reason).toMatch(/unsupported event type merchant_order/i)
    }
    expect(paymentService.getPayment).not.toHaveBeenCalled()
  })
})

describe('handleIpn — error paths', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns error when no merchant matches the mpUserId', async () => {
    mockPrisma.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'ev_1' })
    mockPrisma.ecommerceMerchant.findFirst.mockResolvedValue(null)
    mockPrisma.mercadoPagoWebhookEvent.updateMany.mockResolvedValue({ count: 1 })

    const result = await handleIpn({
      payload: buildPaymentPayload(),
      requestId: 'req-1',
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.reason).toBe('merchant_not_found')
    }
  })

  it('returns error when merchant credentials are missing', async () => {
    mockPrisma.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'ev_1' })
    mockPrisma.ecommerceMerchant.findFirst.mockResolvedValue({ id: 'em_1', providerMerchantId: '12345678' })
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue(null)
    mockPrisma.mercadoPagoWebhookEvent.updateMany.mockResolvedValue({ count: 1 })

    const result = await handleIpn({
      payload: buildPaymentPayload(),
      requestId: 'req-1',
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.reason).toBe('credentials_missing')
    }
  })

  it('returns error when MP getPayment throws', async () => {
    mockPrisma.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'ev_1' })
    mockPrisma.ecommerceMerchant.findFirst.mockResolvedValue({ id: 'em_1', providerMerchantId: '12345678' })
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({ accessToken: 'tok' })
    ;(paymentService.getPayment as jest.Mock).mockRejectedValue(new Error('MP getPayment failed: 503'))
    mockPrisma.mercadoPagoWebhookEvent.updateMany.mockResolvedValue({ count: 1 })

    const result = await handleIpn({
      payload: buildPaymentPayload(),
      requestId: 'req-1',
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.reason).toBe('fetch_failed')
    }
  })

  it('ignores when MP payment has no external_reference (orphan payment)', async () => {
    mockPrisma.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'ev_1' })
    mockPrisma.ecommerceMerchant.findFirst.mockResolvedValue({ id: 'em_1', providerMerchantId: '12345678' })
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({ accessToken: 'tok' })
    ;(paymentService.getPayment as jest.Mock).mockResolvedValue({
      id: 9999,
      status: 'approved',
      external_reference: null, // orphan
      transaction_amount: 100,
      currency_id: 'MXN',
      date_approved: null,
      date_created: '2026-05-20T19:00:00Z',
      fee_details: [],
    })
    mockPrisma.mercadoPagoWebhookEvent.updateMany.mockResolvedValue({ count: 1 })

    const result = await handleIpn({
      payload: buildPaymentPayload(),
      requestId: 'req-1',
    })

    expect(result.status).toBe('ignored')
    if (result.status === 'ignored') {
      expect(result.reason).toMatch(/external_reference/i)
    }
  })

  it('ignores when CheckoutSession is not found for external_reference', async () => {
    mockPrisma.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'ev_1' })
    mockPrisma.ecommerceMerchant.findFirst.mockResolvedValue({ id: 'em_1', providerMerchantId: '12345678' })
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({ accessToken: 'tok' })
    ;(paymentService.getPayment as jest.Mock).mockResolvedValue({
      id: 9999,
      status: 'approved',
      external_reference: 'cs_missing',
      transaction_amount: 100,
      currency_id: 'MXN',
      date_approved: null,
      date_created: '2026-05-20T19:00:00Z',
      fee_details: [],
    })
    mockPrisma.checkoutSession.findFirst.mockResolvedValue(null)
    mockPrisma.mercadoPagoWebhookEvent.updateMany.mockResolvedValue({ count: 1 })

    const result = await handleIpn({
      payload: buildPaymentPayload(),
      requestId: 'req-1',
    })

    expect(result.status).toBe('ignored')
    if (result.status === 'ignored') {
      expect(result.reason).toMatch(/session_not_found/i)
    }
  })
})

describe('handleIpn — status mapping', () => {
  beforeEach(() => jest.clearAllMocks())

  const baseSetup = () => {
    mockPrisma.mercadoPagoWebhookEvent.create.mockResolvedValue({ id: 'ev_1' })
    mockPrisma.ecommerceMerchant.findFirst.mockResolvedValue({ id: 'em_1', providerMerchantId: '12345678' })
    ;(connectionService.loadCredentials as jest.Mock).mockResolvedValue({ accessToken: 'tok' })
    mockPrisma.checkoutSession.findFirst.mockResolvedValue({
      id: 'cs_internal_1',
      sessionId: 'cs_session_xyz',
      mpPaymentId: null,
      status: 'PENDING',
      completedAt: null,
    })
    mockPrisma.checkoutSession.update.mockResolvedValue({ id: 'cs_internal_1' })
    mockPrisma.mercadoPagoWebhookEvent.updateMany.mockResolvedValue({ count: 1 })
  }

  it('maps MP "approved" → CheckoutStatus "COMPLETED" + completedAt set', async () => {
    baseSetup()
    ;(paymentService.getPayment as jest.Mock).mockResolvedValue({
      id: 1,
      status: 'approved',
      external_reference: 'cs_session_xyz',
      transaction_amount: 100,
      currency_id: 'MXN',
      date_approved: '2026-05-20T19:00:30Z',
      date_created: '2026-05-20T19:00:00Z',
      fee_details: [],
    })

    await handleIpn({ payload: buildPaymentPayload(), requestId: 'req-1' })

    const updateArgs = mockPrisma.checkoutSession.update.mock.calls[0][0]
    expect(updateArgs.data.status).toBe('COMPLETED')
    expect(updateArgs.data.completedAt).toBeInstanceOf(Date)
  })

  it('maps MP "rejected" → CheckoutStatus "CANCELLED"', async () => {
    baseSetup()
    ;(paymentService.getPayment as jest.Mock).mockResolvedValue({
      id: 1,
      status: 'rejected',
      external_reference: 'cs_session_xyz',
      transaction_amount: 100,
      currency_id: 'MXN',
      date_approved: null,
      date_created: '2026-05-20T19:00:00Z',
      fee_details: [],
    })

    await handleIpn({ payload: buildPaymentPayload(), requestId: 'req-1' })

    const updateArgs = mockPrisma.checkoutSession.update.mock.calls[0][0]
    expect(updateArgs.data.status).toBe('CANCELLED')
  })

  it('maps MP "in_process" → CheckoutStatus "PENDING"', async () => {
    baseSetup()
    ;(paymentService.getPayment as jest.Mock).mockResolvedValue({
      id: 1,
      status: 'in_process',
      external_reference: 'cs_session_xyz',
      transaction_amount: 100,
      currency_id: 'MXN',
      date_approved: null,
      date_created: '2026-05-20T19:00:00Z',
      fee_details: [],
    })

    await handleIpn({ payload: buildPaymentPayload(), requestId: 'req-1' })

    const updateArgs = mockPrisma.checkoutSession.update.mock.calls[0][0]
    expect(updateArgs.data.status).toBe('PENDING')
  })

  it('maps MP "refunded" → CheckoutStatus "FAILED" (was completed, now reversed)', async () => {
    baseSetup()
    ;(paymentService.getPayment as jest.Mock).mockResolvedValue({
      id: 1,
      status: 'refunded',
      external_reference: 'cs_session_xyz',
      transaction_amount: 100,
      currency_id: 'MXN',
      date_approved: null,
      date_created: '2026-05-20T19:00:00Z',
      fee_details: [],
    })

    await handleIpn({ payload: buildPaymentPayload(), requestId: 'req-1' })

    const updateArgs = mockPrisma.checkoutSession.update.mock.calls[0][0]
    expect(updateArgs.data.status).toBe('FAILED')
  })
})
