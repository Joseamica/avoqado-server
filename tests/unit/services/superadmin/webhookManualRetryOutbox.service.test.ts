import {
  createWebhookManualRetryOutboxService,
  type WebhookManualRetryOutboxRepository,
} from '@/services/superadmin/webhookManualRetryOutbox.service'

const NOW = new Date('2026-08-24T12:00:00.000Z')
const effectLease = {
  eventId: 'webhook-1',
  phase: 'EFFECT' as const,
  attempt: 5,
  claimToken: 'effect-claim-5',
  claimedBy: 'manual-worker',
  claimedAt: NOW,
  claimExpiresAt: new Date(NOW.getTime() + 15 * 60_000),
}
const deliveryLease = {
  intentId: 'intent-1',
  deliveryAttempt: 1,
  deliveryClaimToken: 'delivery-token:intent-1',
  deliveryClaimedBy: 'audit-worker',
  deliveryClaimedAt: NOW,
  deliveryClaimExpiresAt: new Date(NOW.getTime() + 2 * 60_000),
}

function setup(overrides: Partial<WebhookManualRetryOutboxRepository> = {}) {
  const repository = {
    markDispatchStarted: jest.fn(async () => true),
    settleRejected: jest.fn(async () => true),
    claimDue: jest.fn(async () => [deliveryLease]),
    deliver: jest.fn(async () => ({ status: 'DELIVERED' as const, outcome: 'SUCCEEDED' as const })),
    retryDelivery: jest.fn(async () => true),
    ...overrides,
  } as WebhookManualRetryOutboxRepository
  const service = createWebhookManualRetryOutboxService({
    repository,
    workerId: 'audit-worker',
    now: () => NOW,
    newClaimToken: () => 'delivery-token',
  })
  return { service, repository }
}

describe('P3-1A1c-c manual retry result outbox service', () => {
  it('retries unknown dispatch-start acknowledgement with the same timestamp and EFFECT identity', async () => {
    const { service, repository } = setup({
      markDispatchStarted: jest.fn().mockRejectedValueOnce(new Error('unknown commit')).mockResolvedValueOnce(true),
    })

    await service.markDispatchStarted('intent-1', effectLease)

    expect(repository.markDispatchStarted).toHaveBeenCalledTimes(2)
    expect((repository.markDispatchStarted as jest.Mock).mock.calls[0][0]).toEqual(
      (repository.markDispatchStarted as jest.Mock).mock.calls[1][0],
    )
  })

  it('claims one specific result for immediate local delivery without network access', async () => {
    const { service, repository } = setup()

    await expect(service.deliverResult('intent-1')).resolves.toEqual({ delivered: true, outcome: 'SUCCEEDED' })
    expect(repository.claimDue).toHaveBeenCalledWith(expect.objectContaining({ intentId: 'intent-1', limit: 1 }))
    expect(repository.deliver).toHaveBeenCalledWith(deliveryLease, NOW)
  })

  it('leaves a waiting live lease due for restart-safe reconciliation', async () => {
    const { service, repository } = setup({ deliver: jest.fn(async () => ({ status: 'WAITING' as const })) })

    await expect(service.deliverResult('intent-1')).resolves.toEqual({ delivered: false })
    expect(repository.retryDelivery).not.toHaveBeenCalled()
  })

  it('releases a failed delivery claim with durable backoff so the job can retry it', async () => {
    const { service, repository } = setup({ deliver: jest.fn(async () => Promise.reject(new Error('transaction unavailable'))) })

    await expect(service.deliverDueResults()).resolves.toEqual({ claimed: 1, delivered: 0, waiting: 0, failed: 1 })
    expect(repository.retryDelivery).toHaveBeenCalledWith(
      deliveryLease,
      expect.objectContaining({ now: NOW, nextAttemptAt: new Date(NOW.getTime() + 2_000) }),
    )
  })
})
