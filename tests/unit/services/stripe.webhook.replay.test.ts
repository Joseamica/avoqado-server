/**
 * Stripe PLATFORM webhook replay — idempotency + retry accounting
 *
 * Context (real gap found 2026-07-29): the platform webhook claims each event
 * with a `create` on a UNIQUE column, so ANY second call for the same event id
 * hit P2002 and returned early. That is correct for a duplicate delivery from
 * Stripe, but it also meant:
 *
 *   • the superadmin "retry" button did NOTHING while logging success, and
 *   • a FAILED row could never be reprocessed — and since the controller answers
 *     200 to Stripe even on failure, Stripe never redelivered either.
 *
 * These tests pin BOTH halves: the replay path must bypass the claim, and the
 * original delivery path must still reject duplicates.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────
// Follows tests/unit/controllers/delivery-channels/deliverect.webhook.ack.test.ts:
// assert against mocked collaborators, not real Prisma.

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn() },
  },
}))

// The service pulls in the whole notification/email/socket stack at import time.
// None of it is exercised by an UNHANDLED event type (the `default:` branch),
// which is what these tests use as an inert vehicle.
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: {} }))
jest.mock('@/services/access/planNotification.service', () => ({ resolvePlanNotificationTarget: jest.fn() }))
jest.mock('@/services/dashboard/notification.dashboard.service', () => ({ createNotification: jest.fn() }))
jest.mock('@/services/stripe.service', () => ({
  handlePaymentFailure: jest.fn(),
  generateBillingPortalUrl: jest.fn(),
  fulfillPlanCheckout: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { emitToVenue: jest.fn() } }))
jest.mock('@/services/dashboard/token-budget.service', () => ({ tokenBudgetService: {} }))
jest.mock('@/services/dashboard/creditPack.public.service', () => ({ fulfillPurchase: jest.fn() }))
jest.mock('@/services/dashboard/seatReconciliation.service', () => ({
  executeSeatReconciliation: jest.fn(),
  reactivateSeatCapDeactivated: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { handleStripeWebhookEvent, replayStripeWebhookEvent, STRIPE_WEBHOOK_MAX_RETRIES } from '@/services/stripe.webhook.service'

const mockPrisma = prisma as unknown as {
  webhookEvent: { create: jest.Mock; update: jest.Mock; findUnique: jest.Mock }
}

/**
 * An event type NOT in the dispatcher's switch → hits `default:`, logs, and
 * proceeds straight to the SUCCESS bookkeeping. No business side effects, so it
 * isolates the claim/retry mechanics under test.
 */
const INERT_EVENT_TYPE = 'invoice.upcoming'

const storedEvent = (id = 'evt_test_1') => ({
  id,
  type: INERT_EVENT_TYPE,
  // No metadata.venueId and no `subscription` → the venue-enrichment block is
  // skipped, so `webhookEvent.update` is only called by the bookkeeping paths.
  data: { object: {} },
})

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'whe_1',
  stripeEventId: 'evt_test_1',
  eventType: INERT_EVENT_TYPE,
  status: 'FAILED',
  retryCount: 0,
  payload: storedEvent(),
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockPrisma.webhookEvent.update.mockResolvedValue({})
  mockPrisma.webhookEvent.create.mockResolvedValue({ id: 'whe_new' })
})

describe('replayStripeWebhookEvent', () => {
  // ── 1. NEW FEATURE TESTS ───────────────────────────────────────────────────

  it('bypasses the idempotency claim — this is the whole bug: it must NOT call create()', async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue(row())

    const result = await replayStripeWebhookEvent('whe_1')

    expect(result).toEqual({ replayed: true })
    // Before the fix, the replay reached `create`, got P2002, and returned
    // early while the caller reported success.
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled()
  })

  it('counts the attempt BEFORE processing so a hard crash cannot crash-loop', async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue(row({ retryCount: 2 }))

    await replayStripeWebhookEvent('whe_1')

    // First update must be the RETRYING + increment claim-of-attempt.
    expect(mockPrisma.webhookEvent.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'whe_1' },
      data: { status: 'RETRYING', retryCount: { increment: 1 } },
    })
  })

  it('marks the row SUCCESS when the replay processes cleanly', async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue(row())

    await replayStripeWebhookEvent('whe_1')

    const successCall = mockPrisma.webhookEvent.update.mock.calls.find(([arg]) => arg?.data?.status === 'SUCCESS')
    expect(successCall).toBeDefined()
    expect(successCall![0].where).toEqual({ id: 'whe_1' })
  })

  it('refuses a row that already succeeded, without touching it', async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue(row({ status: 'SUCCESS' }))

    const result = await replayStripeWebhookEvent('whe_1')

    expect(result).toEqual({ replayed: false, reason: 'ALREADY_SUCCEEDED' })
    expect(mockPrisma.webhookEvent.update).not.toHaveBeenCalled()
  })

  it('refuses a row that exhausted its attempts, without touching it', async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue(row({ retryCount: STRIPE_WEBHOOK_MAX_RETRIES }))

    const result = await replayStripeWebhookEvent('whe_1')

    expect(result).toEqual({ replayed: false, reason: 'MAX_RETRIES_EXHAUSTED' })
    expect(mockPrisma.webhookEvent.update).not.toHaveBeenCalled()
  })

  it('throws when the row does not exist', async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue(null)

    await expect(replayStripeWebhookEvent('nope')).rejects.toThrow('Webhook event not found')
  })

  it('does NOT double-count the attempt when the replay fails', async () => {
    mockPrisma.webhookEvent.findUnique.mockResolvedValue(row())
    // Force the dispatcher into its catch by failing the SUCCESS bookkeeping
    // write (call #2 — call #1 is the RETRYING claim-of-attempt).
    mockPrisma.webhookEvent.update
      .mockResolvedValueOnce({}) // 1: RETRYING + increment
      .mockRejectedValueOnce(new Error('db blip')) // 2: SUCCESS write fails
      .mockResolvedValue({}) // 3: FAILED write
    mockPrisma.webhookEvent.findUnique.mockResolvedValue(row())

    await expect(replayStripeWebhookEvent('whe_1')).rejects.toThrow('db blip')

    const failedCall = mockPrisma.webhookEvent.update.mock.calls.find(([arg]) => arg?.data?.status === 'FAILED')
    expect(failedCall).toBeDefined()
    // `undefined` = leave the column alone. The attempt was already counted
    // up-front; incrementing again would burn two attempts per replay.
    expect(failedCall![0].data.retryCount).toBeUndefined()
  })
})

describe('handleStripeWebhookEvent — regression: duplicate protection stays intact', () => {
  // ── 2. REGRESSION TESTS ────────────────────────────────────────────────────

  it('still claims the event with create() on a normal delivery', async () => {
    await handleStripeWebhookEvent(storedEvent() as any)

    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledTimes(1)
    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripeEventId: 'evt_test_1', status: 'PENDING' }) }),
    )
  })

  it('still short-circuits a duplicate delivery on P2002 and does no work', async () => {
    mockPrisma.webhookEvent.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))

    await expect(handleStripeWebhookEvent(storedEvent() as any)).resolves.toBeUndefined()

    // No bookkeeping at all — the other instance owns this event.
    expect(mockPrisma.webhookEvent.update).not.toHaveBeenCalled()
  })

  it('rethrows a non-P2002 claim error instead of swallowing it', async () => {
    mockPrisma.webhookEvent.create.mockRejectedValue(Object.assign(new Error('boom'), { code: 'P1001' }))

    await expect(handleStripeWebhookEvent(storedEvent() as any)).rejects.toThrow('boom')
  })

  it('DOES count the attempt on a normal delivery failure (unchanged behaviour)', async () => {
    mockPrisma.webhookEvent.update
      .mockRejectedValueOnce(new Error('db blip')) // SUCCESS write fails
      .mockResolvedValue({}) // FAILED write
    mockPrisma.webhookEvent.findUnique.mockResolvedValue({ retryCount: 1 })

    await expect(handleStripeWebhookEvent(storedEvent() as any)).rejects.toThrow('db blip')

    const failedCall = mockPrisma.webhookEvent.update.mock.calls.find(([arg]) => arg?.data?.status === 'FAILED')
    expect(failedCall).toBeDefined()
    expect(failedCall![0].data.retryCount).toEqual({ increment: 1 })
  })
})
