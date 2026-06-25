import {
  validateAngelPayWebhookPayload,
  persistErrorEvent,
  attemptPaymentMatch,
  processAngelPayWebhook,
  reconcileAngelPayWebhookForPayment,
} from '@/services/tpv/angelpay-webhook.service'
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    providerEventLog: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
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
const mockedProviderEventLogFindMany = prisma.providerEventLog.findMany as jest.Mock
const mockedProviderEventLogUpdate = prisma.providerEventLog.update as jest.Mock
const mockedPaymentFindFirst = prisma.payment.findFirst as jest.Mock
const mockedPaymentFindUnique = prisma.payment.findUnique as jest.Mock
const mockedPaymentUpdate = prisma.payment.update as jest.Mock
const mockedMerchantAccountUpdate = prisma.merchantAccount.update as jest.Mock

// Shared test merchantAccount arg
const TEST_MERCHANT = { id: 'ma_1', externalMerchantId: '351' }

describe('validateAngelPayWebhookPayload', () => {
  // Real production body shape — no id_merchant at top level
  const valid = {
    event_type: 'send_transaction',
    payload: { amount: '000000000100' },
  }

  it('accepts a minimal valid payload', () => {
    expect(validateAngelPayWebhookPayload(valid)).toBe(true)
  })

  it('rejects when event_type is missing', () => {
    expect(validateAngelPayWebhookPayload({ ...valid, event_type: undefined })).toBe(false)
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
      payload: { event_type: 'send_transaction', payload: { amount: '100' } } as any,
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
      payload: {
        integratorReference: 'ref-123',
        transactionId: 'tx_abc',
        amount: '000000010000', // 10000 cents = $100.00
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
          OR: [{ idempotencyKey: 'ref-123' }, { referenceNumber: 'ref-123' }, { processorId: 'tx_abc' }],
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
    expect(callArgs.where.OR).toEqual([{ idempotencyKey: 'ref-123' }, { referenceNumber: 'ref-123' }])
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
    // Payment amount: $100.00 pesos. Webhook amount: 10000 cents = $100.00 pesos → diff < 0.01 → MATCHED
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_1', amount: 100, processorData: null, venueId: 'venue_1' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: {
          integratorReference: 'ref-1',
          amount: '000000010000', // 10000 cents = $100.00 MXN
          status: 'approved',
          transactionId: 'tx_1',
          terminalSerial: '12345678',
          timestamp: '2026-03-20T12:34:56Z',
        },
      } as any,
      eventId: 'msg_a',
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
              eventId: 'msg_a',
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

  it('treats tip as part of the charged amount: base + tip == webhook → MATCHED (regression)', async () => {
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_tip' })
    // Card charged base($100) + tip($10) = $110. Webhook = 11000 cents = $110.00.
    // Comparing against base alone ($100) would WRONGLY flag a $10 discrepancy.
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_tip', amount: 100, tipAmount: 10, processorData: null, venueId: 'venue_1' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: {
          integratorReference: 'ref-tip',
          amount: '000000011000', // 11000 cents = $110.00 = base + tip
          status: 'approved',
          transactionId: 'tx_tip',
        },
      } as any,
      eventId: 'msg_tip',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('MATCHED')
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_tip' },
      data: expect.objectContaining({ status: 'PROCESSED', paymentId: 'pay_tip' }),
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
    // Payment amount: $100.00. Webhook: "000001055000" = 1055000 cents? No — use "000000010550" = 10550 cents = $105.50 → diff = 5.50 → DISCREPANCY
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_2', amount: 100, processorData: { existing: true }, venueId: 'venue_1' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: {
          integratorReference: 'ref-2',
          amount: '000000010550', // 10550 cents = $105.50 MXN → diff vs $100.00 = 5.50
          status: 'approved',
          transactionId: 'tx_2',
        },
      } as any,
      eventId: 'msg_b',
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
        payload: { integratorReference: 'ref-3', amount: '000000005000', status: 'declined' },
      } as any,
      eventId: 'msg_c',
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
        payload: { amount: '000000001000' },
      } as any,
      eventId: 'msg_d',
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

  it('returns DUPLICATE when ProviderEventLog already has this event-id (P2002 race)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique violation', { code: 'P2002', clientVersion: 'x' })
    mockedProviderEventLogCreate.mockRejectedValueOnce(p2002)
    mockedProviderEventLogFindFirst.mockResolvedValue({ id: 'evt_existing', paymentId: 'pay_existing' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { integratorReference: 'ref-dup', amount: '000000001000', status: 'approved' },
      } as any,
      eventId: 'msg_f',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('DUPLICATE')
    expect(result.eventLogId).toBe('evt_existing')
    expect(result.paymentId).toBe('pay_existing')
  })

  it('returns ORPHANED/AWAITING_PAYMENT and leaves event PENDING when no Payment matches after retries', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_5' })
    mockedPaymentFindFirst.mockResolvedValue(null)

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { integratorReference: 'ref-miss', amount: '000000001000', status: 'approved' },
      } as any,
      eventId: 'msg_g',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    // action stays ORPHANED (HTTP cosmetic); status row is PENDING so backfill can reconcile
    expect(result.action).toBe('ORPHANED')
    expect(result.errorReason).toBe('AWAITING_PAYMENT')
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_5' },
      data: expect.objectContaining({ status: 'PENDING', errorReason: 'AWAITING_PAYMENT' }),
    })
    // Must NOT set processedAt (event is not yet terminal)
    const updateArgs = mockedProviderEventLogUpdate.mock.calls[0][0]
    expect(updateArgs.data).not.toHaveProperty('processedAt')
  })

  it('returns ORPHANED/NO_MATCH_FIELDS when payload has none of integratorReference/transactionId', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_6' })
    mockedPaymentFindFirst.mockResolvedValue(null)

    const result = await processAngelPayWebhook({
      payload: { event_type: 'send_transaction', payload: { amount: '000000001000', status: 'approved' } } as any,
      eventId: 'msg_h',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('ORPHANED')
    expect(result.errorReason).toBe('NO_MATCH_FIELDS')
    // NO_MATCH_FIELDS is genuinely unprocessable — must stay terminal ERROR (not PENDING)
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_6' },
      data: expect.objectContaining({ status: 'ERROR', errorReason: 'NO_MATCH_FIELDS' }),
    })
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// reconcileAngelPayWebhookForPayment — backfill tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('reconcileAngelPayWebhookForPayment', () => {
  const basePayment = {
    id: 'pay_backfill_1',
    idempotencyKey: 'idem-abc',
    referenceNumber: null,
    venueId: 'venue_x',
    amount: 100,
    tipAmount: 0,
  }

  const pendingEvent = {
    id: 'evt_pending_1',
    payload: {
      event_type: 'send_transaction',
      payload: {
        amount: '000000010000', // 10000 cents = $100.00 MXN — exact match
        integratorReference: 'idem-abc',
        transactionId: 'tx_ap_1',
        terminalSerial: 'N860W175781',
        timestamp: '2026-05-28T01:00:00Z',
        status: 'approved',
      },
    },
  }

  beforeEach(() => {
    ;[mockedProviderEventLogFindMany, mockedProviderEventLogUpdate, mockedPaymentFindUnique, mockedPaymentUpdate].forEach(m =>
      m.mockReset(),
    )
    // Default: payment has no existing processorData
    mockedPaymentFindUnique.mockResolvedValue({ processorData: null })
    mockedProviderEventLogUpdate.mockResolvedValue({})
    mockedPaymentUpdate.mockResolvedValue({})
  })

  it('stamps processorData.angelpayWebhook and marks event PROCESSED on amount match', async () => {
    mockedProviderEventLogFindMany.mockResolvedValue([pendingEvent])

    await reconcileAngelPayWebhookForPayment(basePayment)

    expect(mockedPaymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay_backfill_1' },
        data: expect.objectContaining({
          processorData: expect.objectContaining({
            angelpayWebhook: expect.objectContaining({
              reconciledVia: 'payment-create-backfill',
              transactionId: 'tx_ap_1',
              integratorReference: 'idem-abc',
              terminalSerial: 'N860W175781',
              status: 'approved',
            }),
          }),
        }),
      }),
    )

    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt_pending_1' },
        data: expect.objectContaining({
          status: 'PROCESSED',
          paymentId: 'pay_backfill_1',
          venueId: 'venue_x',
          errorReason: null,
        }),
      }),
    )
  })

  it('treats tip as part of the charged amount on backfill: base + tip == webhook → MATCHED (regression)', async () => {
    // Card charged base($100) + tip($10) = $110. Pending webhook = 11000 cents = $110.00.
    const tippedEvent = {
      id: 'evt_pending_tip',
      payload: {
        event_type: 'send_transaction',
        payload: {
          amount: '000000011000', // 11000 cents = $110.00 = base + tip
          integratorReference: 'idem-abc',
          transactionId: 'tx_ap_tip',
          status: 'approved',
        },
      },
    }
    mockedProviderEventLogFindMany.mockResolvedValue([tippedEvent])

    await reconcileAngelPayWebhookForPayment({ ...basePayment, amount: 100, tipAmount: 10 })

    // MATCHED → stamps angelpayWebhook (not angelpayDiscrepancy), event PROCESSED.
    const updateCall = mockedPaymentUpdate.mock.calls[0][0]
    expect(updateCall.data.processorData).toHaveProperty('angelpayWebhook')
    expect(updateCall.data.processorData).not.toHaveProperty('angelpayDiscrepancy')
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt_pending_tip' },
        data: expect.objectContaining({ status: 'PROCESSED', errorReason: null }),
      }),
    )
  })

  it('preserves existing processorData keys when stamping angelpayWebhook', async () => {
    mockedProviderEventLogFindMany.mockResolvedValue([pendingEvent])
    mockedPaymentFindUnique.mockResolvedValue({ processorData: { existingKey: 'keepMe' } })

    await reconcileAngelPayWebhookForPayment(basePayment)

    const updateCall = mockedPaymentUpdate.mock.calls[0][0]
    expect(updateCall.data.processorData).toMatchObject({
      existingKey: 'keepMe',
      angelpayWebhook: expect.objectContaining({ reconciledVia: 'payment-create-backfill' }),
    })
  })

  it('stamps angelpayDiscrepancy and marks ERROR/AMOUNT_MISMATCH on amount mismatch', async () => {
    const mismatchEvent = {
      id: 'evt_pending_mismatch',
      payload: {
        event_type: 'send_transaction',
        payload: {
          amount: '000000010550', // 10550 cents = $105.50 — diff $5.50 vs $100.00
          integratorReference: 'idem-abc',
          transactionId: 'tx_ap_mismatch',
          status: 'approved',
        },
      },
    }
    mockedProviderEventLogFindMany.mockResolvedValue([mismatchEvent])

    await reconcileAngelPayWebhookForPayment(basePayment)

    expect(mockedPaymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processorData: expect.objectContaining({
            angelpayDiscrepancy: expect.objectContaining({
              webhookAmount: 105.5,
              recordedAmount: 100,
              transactionId: 'tx_ap_mismatch',
            }),
          }),
        }),
      }),
    )

    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ERROR',
          errorReason: 'AMOUNT_MISMATCH',
          paymentId: 'pay_backfill_1',
        }),
      }),
    )
  })

  it('is a no-op when no pending event is found', async () => {
    mockedProviderEventLogFindMany.mockResolvedValue([])

    await reconcileAngelPayWebhookForPayment(basePayment)

    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
    expect(mockedProviderEventLogUpdate).not.toHaveBeenCalled()
  })

  it('is a no-op and returns without querying when both idempotencyKey and referenceNumber are null', async () => {
    await reconcileAngelPayWebhookForPayment({
      ...basePayment,
      idempotencyKey: null,
      referenceNumber: null,
    })

    expect(mockedProviderEventLogFindMany).not.toHaveBeenCalled()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
  })

  it('never throws when findMany rejects — swallows error gracefully', async () => {
    mockedProviderEventLogFindMany.mockRejectedValue(new Error('DB connection lost'))

    // Must resolve without throwing
    await expect(reconcileAngelPayWebhookForPayment(basePayment)).resolves.toBeUndefined()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
  })
})
