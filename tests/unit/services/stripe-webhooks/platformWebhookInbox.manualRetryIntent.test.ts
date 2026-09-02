import { createPlatformWebhookInboxService, type PlatformWebhookRepository } from '@/services/stripe-webhooks/platformWebhookInbox.service'

const NOW = new Date('2026-08-24T12:00:00.000Z')

const input = {
  intentId: 'intent-1',
  requestActivityLogId: 'activity-request-1',
  resultActivityLogId: 'activity-result-1',
  actorId: 'staff-root',
  venueId: 'venue-1',
  eventId: 'webhook-1',
  reason: 'Validación controlada',
}

function claimedIntent() {
  return {
    ...input,
    lease: {
      eventId: 'webhook-1',
      phase: 'EFFECT' as const,
      attempt: 5,
      claimToken: 'manual-effect-token',
      claimedBy: 'manual-worker',
      claimedAt: NOW,
      claimExpiresAt: new Date(NOW.getTime() + 15 * 60_000),
    },
  }
}

describe('P3-1A1c-c atomic manual EFFECT claim plus audit intent', () => {
  it('retries an unknown commit with the exact same intent and claim identities', async () => {
    const acquireManualEffectWithAuditIntent = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection lost after possible commit'))
      .mockResolvedValueOnce(claimedIntent())
    const inbox = createPlatformWebhookInboxService({
      repository: { acquireManualEffectWithAuditIntent } as unknown as PlatformWebhookRepository,
      workerId: 'manual-worker',
      now: () => NOW,
      newClaimToken: () => 'manual-effect-token',
    }) as any

    await expect(inbox.acquireManualEffectWithAuditIntent(input)).resolves.toEqual(claimedIntent())
    expect(acquireManualEffectWithAuditIntent).toHaveBeenCalledTimes(2)
    expect(acquireManualEffectWithAuditIntent.mock.calls[0][0]).toEqual(acquireManualEffectWithAuditIntent.mock.calls[1][0])
    expect(acquireManualEffectWithAuditIntent.mock.calls[0][0]).toMatchObject({
      intentId: 'intent-1',
      claimToken: 'manual-effect-token',
      claimedBy: 'manual-worker',
      manual: true,
    })
  })

  it('does not manufacture an intent when the atomic repository claim is ineligible', async () => {
    const acquireManualEffectWithAuditIntent = jest.fn().mockResolvedValue(null)
    const inbox = createPlatformWebhookInboxService({
      repository: { acquireManualEffectWithAuditIntent } as unknown as PlatformWebhookRepository,
      workerId: 'manual-worker',
      now: () => NOW,
      newClaimToken: () => 'manual-effect-token',
    }) as any

    await expect(inbox.acquireManualEffectWithAuditIntent(input)).resolves.toBeNull()
    expect(acquireManualEffectWithAuditIntent).toHaveBeenCalledTimes(1)
  })
})
