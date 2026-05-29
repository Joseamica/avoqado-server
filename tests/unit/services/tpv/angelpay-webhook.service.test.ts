import {
  validateAngelPayWebhookPayload,
  persistErrorEvent,
  attemptPaymentMatch,
  processAngelPayWebhook,
} from '@/services/tpv/angelpay-webhook.service'
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    providerEventLog: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    merchantAccount: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  },
}))

const mockedProviderEventLogCreate = prisma.providerEventLog.create as jest.Mock
const mockedProviderEventLogFindFirst = prisma.providerEventLog.findFirst as jest.Mock
const mockedProviderEventLogUpdate = prisma.providerEventLog.update as jest.Mock
const mockedPaymentFindFirst = prisma.payment.findFirst as jest.Mock
const mockedPaymentUpdate = prisma.payment.update as jest.Mock
const mockedMerchantAccountUpdate = prisma.merchantAccount.update as jest.Mock

// Shared test merchantAccount arg
const TEST_MERCHANT = { id: 'ma_1', externalMerchantId: '351' }

describe('validateAngelPayWebhookPayload', () => {
  const valid = {
    event_type: 'send_transaction',
    id_merchant: 351,
    payload: { amount: 100 },
  }

  it('accepts a minimal valid payload', () => {
    expect(validateAngelPayWebhookPayload(valid)).toBe(true)
  })

  it('rejects when event_type is missing', () => {
    expect(validateAngelPayWebhookPayload({ ...valid, event_type: undefined })).toBe(false)
  })

  it('rejects when id_merchant is missing (not a number)', () => {
    expect(validateAngelPayWebhookPayload({ ...valid, id_merchant: undefined })).toBe(false)
  })

  it('rejects when payload.amount is missing', () => {
    expect(validateAngelPayWebhookPayload({ ...valid, payload: {} })).toBe(false)
  })

  it('rejects null/non-object inputs', () => {
    expect(validateAngelPayWebhookPayload(null)).toBe(false)
    expect(validateAngelPayWebhookPayload(undefined)).toBe(false)
    expect(validateAngelPayWebhookPayload('string')).toBe(false)
  })
})

describe('persistErrorEvent', () => {
  beforeEach(() => {
    mockedProviderEventLogCreate.mockReset()
  })

  it('creates a ProviderEventLog row with status=ERROR and the given errorReason', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_123' })
    const result = await persistErrorEvent({
      eventId: 'angelpay-msg_1',
      type: 'send_transaction',
      payload: { id_merchant: 351, event_type: 'send_transaction', payload: { amount: 10 } } as any,
      venueId: null,
      errorReason: 'UNKNOWN_MERCHANT',
    })
    expect(result.id).toBe('evt_123')
    expect(mockedProviderEventLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'PAYMENT_PROCESSOR',
        eventId: 'angelpay-msg_1',
        status: 'ERROR',
        errorReason: 'UNKNOWN_MERCHANT',
        type: 'send_transaction',
        venueId: null,
      }),
      select: { id: true },
    })
  })
})

describe('attemptPaymentMatch', () => {
  beforeEach(() => {
    mockedPaymentFindFirst.mockReset()
  })

  const baseArgs = {
    payload: {
      event_type: 'send_transaction',
      id_merchant: 351,
      payload: {
        integratorReference: 'ref-123',
        transactionId: 'tx_abc',
        amount: 100,
      },
    } as any,
    merchantAccountId: 'ma_xyz',
    retryDelaysMs: [0, 0, 0],
  }

  it('returns the payment on first attempt when found', async () => {
    const payment = { id: 'pay_1', amount: 100, venueId: 'venue_1' }
    mockedPaymentFindFirst.mockResolvedValueOnce(payment)
    const result = await attemptPaymentMatch(baseArgs)
    expect(result).toBe(payment)
    expect(mockedPaymentFindFirst).toHaveBeenCalledTimes(1)
  })

  it('retries up to 3 times and returns the payment when later attempts succeed', async () => {
    mockedPaymentFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'pay_2', amount: 100, venueId: 'venue_1' })
    const result = await attemptPaymentMatch(baseArgs)
    expect(result).toEqual({ id: 'pay_2', amount: 100, venueId: 'venue_1' })
    expect(mockedPaymentFindFirst).toHaveBeenCalledTimes(3)
  })

  it('returns null after 3 attempts with no match', async () => {
    mockedPaymentFindFirst.mockResolvedValue(null)
    const result = await attemptPaymentMatch(baseArgs)
    expect(result).toBeNull()
    expect(mockedPaymentFindFirst).toHaveBeenCalledTimes(3)
  })

  it('builds OR conditions from integratorReference, transactionId and scopes by merchantAccountId', async () => {
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_3', venueId: 'venue_1' })
    await attemptPaymentMatch(baseArgs)
    expect(mockedPaymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ referenceNumber: 'ref-123' }, { processorId: 'tx_abc' }],
          status: { in: ['COMPLETED', 'PENDING'] },
          merchantAccountId: 'ma_xyz',
        }),
      }),
    )
  })

  it('omits a condition when its corresponding field is missing', async () => {
    mockedPaymentFindFirst.mockResolvedValueOnce(null)
    await attemptPaymentMatch({
      ...baseArgs,
      payload: { ...baseArgs.payload, payload: { ...baseArgs.payload.payload, transactionId: undefined } } as any,
    })
    const callArgs = mockedPaymentFindFirst.mock.calls[0][0]
    expect(callArgs.where.OR).toEqual([{ referenceNumber: 'ref-123' }])
  })
})

describe('processAngelPayWebhook — MATCHED happy path', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
  })

  it('stamps processorData.angelpayWebhook, marks event PROCESSED, touches lastReceivedAt', async () => {
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_1' })
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_1', amount: 100, processorData: null, venueId: 'venue_1' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        id_merchant: 351,
        payload: {
          integratorReference: 'ref-1',
          amount: 100,
          status: 'approved',
          transactionId: 'tx_1',
          terminalSerial: '12345678',
          timestamp: '2026-03-20T12:34:56Z',
        },
      } as any,
      svixId: 'msg_a',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('MATCHED')
    expect(result.paymentId).toBe('pay_1')
    expect(result.eventLogId).toBe('evt_1')

    expect(mockedPaymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay_1' },
        data: expect.objectContaining({
          processorData: expect.objectContaining({
            angelpayWebhook: expect.objectContaining({
              svixId: 'msg_a',
              transactionId: 'tx_1',
              integratorReference: 'ref-1',
              terminalSerial: '12345678',
              timestamp: '2026-03-20T12:34:56Z',
              status: 'approved',
            }),
          }),
        }),
      }),
    )

    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_1' },
      data: expect.objectContaining({ status: 'PROCESSED', paymentId: 'pay_1', venueId: 'venue_1' }),
    })

    expect(mockedMerchantAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'ma_1' },
      data: { angelpayWebhookLastReceivedAt: expect.any(Date) },
    })
  })
})

describe('processAngelPayWebhook — DISCREPANCY', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
  })

  it('stamps angelpayDiscrepancy, marks event ERROR/AMOUNT_MISMATCH, does NOT mutate payment.status', async () => {
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_2' })
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_2', amount: 100, processorData: { existing: true }, venueId: 'venue_1' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        id_merchant: 351,
        payload: { integratorReference: 'ref-2', amount: 105.5, status: 'approved', transactionId: 'tx_2' },
      } as any,
      svixId: 'msg_b',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('DISCREPANCY')
    expect(result.errorReason).toBe('AMOUNT_MISMATCH')

    const updateCall = mockedPaymentUpdate.mock.calls[0][0]
    expect(updateCall.data.processorData).toEqual(
      expect.objectContaining({
        existing: true,
        angelpayDiscrepancy: expect.objectContaining({
          webhookAmount: 105.5,
          recordedAmount: 100,
          difference: 5.5,
          transactionId: 'tx_2',
        }),
      }),
    )
    expect(updateCall.data).not.toHaveProperty('status')

    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_2' },
      data: expect.objectContaining({ status: 'ERROR', errorReason: 'AMOUNT_MISMATCH', paymentId: 'pay_2' }),
    })
  })
})

describe('processAngelPayWebhook — early-return paths', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
  })

  it('returns NOT_APPROVED when payload.status is not approved', async () => {
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_3' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        id_merchant: 351,
        payload: { integratorReference: 'ref-3', amount: 50, status: 'declined' },
      } as any,
      svixId: 'msg_c',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('NOT_APPROVED')
    expect(mockedPaymentFindFirst).not.toHaveBeenCalled()
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_3' },
      data: expect.objectContaining({ status: 'ERROR', errorReason: 'NOT_APPROVED' }),
    })
  })

  it('returns UNSUPPORTED_EVENT_TYPE for event_type != send_transaction', async () => {
    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'canceled_transaction',
        id_merchant: 351,
        payload: { amount: 10 },
      } as any,
      svixId: 'msg_d',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('UNSUPPORTED_EVENT_TYPE')
    expect(mockedPaymentFindFirst).not.toHaveBeenCalled()
  })
})

describe('processAngelPayWebhook — error paths', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
  })

  it("returns UNKNOWN_MERCHANT with MERCHANT_MISMATCH when body id_merchant doesn't match URL merchantAccount", async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_mismatch' })

    const result = await processAngelPayWebhook({
      payload: { event_type: 'send_transaction', id_merchant: 999, payload: { amount: 10 } } as any,
      svixId: 'msg_mismatch',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('UNKNOWN_MERCHANT')
    expect(result.errorReason).toBe('MERCHANT_MISMATCH')
    expect(mockedPaymentFindFirst).not.toHaveBeenCalled()
  })

  it('returns DUPLICATE when ProviderEventLog already has this svix-id (P2002 race)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique violation', { code: 'P2002', clientVersion: 'x' })
    mockedProviderEventLogCreate.mockRejectedValueOnce(p2002)
    mockedProviderEventLogFindFirst.mockResolvedValue({ id: 'evt_existing', paymentId: 'pay_existing' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        id_merchant: 351,
        payload: { integratorReference: 'ref-dup', amount: 10, status: 'approved' },
      } as any,
      svixId: 'msg_f',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('DUPLICATE')
    expect(result.eventLogId).toBe('evt_existing')
    expect(result.paymentId).toBe('pay_existing')
  })

  it('returns ORPHANED when no Payment matches after retries', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_5' })
    mockedPaymentFindFirst.mockResolvedValue(null)

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        id_merchant: 351,
        payload: { integratorReference: 'ref-miss', amount: 10, status: 'approved' },
      } as any,
      svixId: 'msg_g',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('ORPHANED')
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_5' },
      data: expect.objectContaining({ status: 'ERROR', errorReason: 'ORPHANED' }),
    })
  })

  it('returns ORPHANED/NO_MATCH_FIELDS when payload has none of integratorReference/transactionId', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_6' })
    mockedPaymentFindFirst.mockResolvedValue(null)

    const result = await processAngelPayWebhook({
      payload: { event_type: 'send_transaction', id_merchant: 351, payload: { amount: 10, status: 'approved' } } as any,
      svixId: 'msg_h',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('ORPHANED')
    expect(result.errorReason).toBe('NO_MATCH_FIELDS')
  })
})
