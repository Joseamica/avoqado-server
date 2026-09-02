jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    activityLog: {
      upsert: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/services/stripe.webhook.service', () => ({
  replayStripeWebhookEvent: jest.fn(),
}))

const acquireManualEffectWithAuditIntent = jest.fn()
const processEffect = jest.fn()
jest.mock('@/services/stripe-webhooks/platformWebhookRuntime.service', () => ({
  platformWebhookRuntime: {
    inbox: { acquireManualEffectWithAuditIntent },
    processor: { processEffect },
  },
}))

const markDispatchStarted = jest.fn()
const settleRejected = jest.fn()
const deliverResult = jest.fn()
jest.mock('@/services/superadmin/webhookManualRetryOutbox.service', () => ({
  webhookManualRetryOutbox: { markDispatchStarted, settleRejected, deliverResult },
}))

import prisma from '@/utils/prismaClient'
import { replayStripeWebhookEvent } from '@/services/stripe.webhook.service'
import { retryWebhookEvent } from '@/services/superadmin/webhook.superadmin.service'

const webhookEvent = prisma.webhookEvent as unknown as {
  findUnique: jest.Mock
  update: jest.Mock
}
const replay = replayStripeWebhookEvent as jest.Mock

describe('Superadmin webhook retry ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    webhookEvent.findUnique.mockResolvedValue({
      id: 'webhook-1',
      venueId: 'venue-1',
      status: 'FAILED',
      effectAttempts: 4,
      retryCount: 4,
      effectNextAttemptAt: new Date('2026-08-23T20:00:00.000Z'),
      claimPhase: null,
      claimExpiresAt: null,
    })
    acquireManualEffectWithAuditIntent.mockImplementation(async (input: Record<string, unknown>) => ({
      ...input,
      lease: {
        eventId: 'webhook-1',
        phase: 'EFFECT',
        attempt: 5,
        claimToken: 'claim-5',
        claimedBy: 'manual-worker',
        claimedAt: new Date('2026-08-23T20:00:00.000Z'),
        claimExpiresAt: new Date('2026-08-23T20:15:00.000Z'),
      },
    }))
    processEffect.mockResolvedValue('COMPLETED')
    markDispatchStarted.mockResolvedValue(undefined)
    deliverResult.mockResolvedValue({ delivered: true, outcome: 'SUCCEEDED' })
  })

  it('retires the legacy replay adapter and never performs a second WebhookEvent state write', async () => {
    await expect(retryWebhookEvent('webhook-1', { actorId: 'staff-root', reason: 'Validación operativa' })).resolves.toMatchObject({
      success: true,
      phase: 'EFFECT',
      attempt: 5,
    })

    expect(acquireManualEffectWithAuditIntent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'webhook-1', actorId: 'staff-root' }),
    )
    expect(processEffect).toHaveBeenCalledTimes(1)
    expect(replay).not.toHaveBeenCalled()
    expect(webhookEvent.update).not.toHaveBeenCalled()
  })
})
