/**
 * Compatibility exports must delegate to the first-party durable inbox. They
 * intentionally keep the public function names until A1c-c can migrate its
 * Superadmin consumer, but they must not restore the retired direct writers.
 */

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
jest.mock('@/services/stripe-webhooks/platformWebhookRuntime.service', () => ({
  platformWebhookRuntime: {
    mode: 'OFF',
    inbox: {
      observe: jest.fn(),
      load: jest.fn(),
      acquire: jest.fn(),
    },
    processor: {
      processIngress: jest.fn(),
      processEffect: jest.fn(),
    },
  },
}))

import type Stripe from 'stripe'
import { platformWebhookRuntime } from '@/services/stripe-webhooks/platformWebhookRuntime.service'
import { handleStripeWebhookEvent, replayStripeWebhookEvent } from '@/services/stripe.webhook.service'
import type { WebhookLease } from '@/services/stripe-webhooks/platformWebhookInbox.service'

const runtime = platformWebhookRuntime as unknown as {
  mode: 'OFF' | 'SHADOW'
  inbox: { observe: jest.Mock; load: jest.Mock; acquire: jest.Mock }
  processor: { processIngress: jest.Mock; processEffect: jest.Mock }
}

const event = {
  id: 'evt_test_1',
  type: 'invoice.upcoming',
  data: { object: {} },
} as Stripe.Event

const effectLease: WebhookLease = {
  eventId: 'whe_1',
  phase: 'EFFECT',
  attempt: 2,
  claimToken: 'effect-token',
  claimedBy: 'manual-worker',
  claimedAt: new Date('2026-08-23T00:00:00.000Z'),
  claimExpiresAt: new Date('2026-08-23T00:15:00.000Z'),
}

beforeEach(() => {
  jest.clearAllMocks()
  runtime.mode = 'OFF'
  runtime.inbox.observe.mockResolvedValue({ event: { id: 'whe_1' }, created: true })
  runtime.inbox.load.mockResolvedValue({ id: 'whe_1', payload: event })
  runtime.inbox.acquire.mockResolvedValue(effectLease)
  runtime.processor.processIngress.mockResolvedValue({ classification: 'SKIPPED', effect: 'COMPLETED' })
  runtime.processor.processEffect.mockResolvedValue('COMPLETED')
})

describe('replayStripeWebhookEvent compatibility adapter', () => {
  it('loads the durable event, acquires a manual EFFECT lease, and delegates the exact lease', async () => {
    await expect(replayStripeWebhookEvent('whe_1')).resolves.toEqual({ replayed: true })

    expect(runtime.inbox.load).toHaveBeenCalledWith('whe_1')
    expect(runtime.inbox.acquire).toHaveBeenCalledWith('whe_1', 'EFFECT', { manual: true })
    expect(runtime.processor.processEffect).toHaveBeenCalledWith('whe_1', effectLease)
  })

  it('returns NOT_ELIGIBLE without dispatch when no manual lease can be acquired', async () => {
    runtime.inbox.acquire.mockResolvedValueOnce(null)

    await expect(replayStripeWebhookEvent('whe_1')).resolves.toEqual({ replayed: false, reason: 'NOT_ELIGIBLE' })

    expect(runtime.processor.processEffect).not.toHaveBeenCalled()
  })

  it('propagates durable lookup and processor failures unchanged', async () => {
    const loadFailure = new Error('durable row missing')
    runtime.inbox.load.mockRejectedValueOnce(loadFailure)
    await expect(replayStripeWebhookEvent('whe_missing')).rejects.toBe(loadFailure)
    expect(runtime.inbox.acquire).not.toHaveBeenCalled()

    const effectFailure = new Error('effect failed')
    runtime.processor.processEffect.mockRejectedValueOnce(effectFailure)
    await expect(replayStripeWebhookEvent('whe_1')).rejects.toBe(effectFailure)
  })
})

describe('handleStripeWebhookEvent compatibility adapter', () => {
  it('persists the full signed event before delegating OFF ingress for a newly-created row', async () => {
    await handleStripeWebhookEvent(event)

    expect(runtime.inbox.observe).toHaveBeenCalledWith({
      stripeEventId: 'evt_test_1',
      eventType: 'invoice.upcoming',
      payload: event,
    })
    expect(runtime.processor.processIngress).toHaveBeenCalledWith('whe_1', { mode: 'OFF', created: true })
    expect(runtime.inbox.observe.mock.invocationCallOrder[0]).toBeLessThan(runtime.processor.processIngress.mock.invocationCallOrder[0])
  })

  it('passes duplicate identity and SHADOW mode to the single processor authority', async () => {
    runtime.mode = 'SHADOW'
    runtime.inbox.observe.mockResolvedValueOnce({ event: { id: 'whe_existing' }, created: false })

    await handleStripeWebhookEvent(event)

    expect(runtime.processor.processIngress).toHaveBeenCalledWith('whe_existing', { mode: 'SHADOW', created: false })
  })

  it('does not invoke processing when durable observation fails', async () => {
    const durableFailure = new Error('inbox unavailable')
    runtime.inbox.observe.mockRejectedValueOnce(durableFailure)

    await expect(handleStripeWebhookEvent(event)).rejects.toBe(durableFailure)

    expect(runtime.processor.processIngress).not.toHaveBeenCalled()
  })

  it('propagates the processor failure after durability', async () => {
    const phaseFailure = new Error('phase failed')
    runtime.processor.processIngress.mockRejectedValueOnce(phaseFailure)

    await expect(handleStripeWebhookEvent(event)).rejects.toBe(phaseFailure)
  })
})
