import {
  WebhookAuditUnavailableError,
  WebhookLeaseBusyError,
  createWebhookManualRetryService,
  type ManualRetryIntent,
  type WebhookManualRetryPorts,
} from '@/services/superadmin/webhookManualRetry.service'

const now = new Date('2026-08-24T12:00:00.000Z')

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'webhook-1',
    venueId: 'venue-1',
    status: 'FAILED',
    effectAttempts: 4,
    effectNextAttemptAt: new Date('2026-08-25T12:00:00.000Z'),
    claimPhase: null,
    claimExpiresAt: null,
    ...overrides,
  }
}

function intent(): ManualRetryIntent {
  return {
    intentId: 'intent-1',
    requestActivityLogId: 'activity-request-1',
    resultActivityLogId: 'activity-result-1',
    actorId: 'staff-root',
    venueId: 'venue-1',
    eventId: 'webhook-1',
    reason: 'Validación controlada',
    lease: {
      eventId: 'webhook-1',
      phase: 'EFFECT',
      attempt: 5,
      claimToken: 'effect-claim-5',
      claimedBy: 'manual-worker',
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + 15 * 60_000),
    },
  }
}

function setup() {
  const writeAudit = jest.fn<ReturnType<WebhookManualRetryPorts['writeAudit']>, Parameters<WebhookManualRetryPorts['writeAudit']>>(
    async _input => undefined,
  )
  const inspect = jest.fn<ReturnType<WebhookManualRetryPorts['inspect']>, Parameters<WebhookManualRetryPorts['inspect']>>(
    async _eventId => snapshot() as never,
  )
  const acquireEffectWithIntent = jest.fn<
    ReturnType<WebhookManualRetryPorts['acquireEffectWithIntent']>,
    Parameters<WebhookManualRetryPorts['acquireEffectWithIntent']>
  >(async _input => intent())
  const markDispatchStarted = jest.fn<
    ReturnType<WebhookManualRetryPorts['markDispatchStarted']>,
    Parameters<WebhookManualRetryPorts['markDispatchStarted']>
  >(async (_intentId, _lease) => undefined)
  const processEffect = jest.fn<ReturnType<WebhookManualRetryPorts['processEffect']>, Parameters<WebhookManualRetryPorts['processEffect']>>(
    async (_eventId, _lease) => 'COMPLETED',
  )
  const settleRejected = jest.fn<
    ReturnType<WebhookManualRetryPorts['settleRejected']>,
    Parameters<WebhookManualRetryPorts['settleRejected']>
  >(async (_intentId, _lease) => undefined)
  const deliverResult = jest.fn<ReturnType<WebhookManualRetryPorts['deliverResult']>, Parameters<WebhookManualRetryPorts['deliverResult']>>(
    async _intentId => ({ delivered: true, outcome: 'SUCCEEDED' as const }),
  )
  const ids = ['intent-1', 'activity-request-1', 'activity-result-1']
  const retry = createWebhookManualRetryService({
    inspect,
    writeAudit,
    acquireEffectWithIntent,
    markDispatchStarted,
    processEffect,
    settleRejected,
    deliverResult,
    now: () => now,
    newId: () => ids.shift()!,
  })
  return {
    retry,
    writeAudit,
    inspect,
    acquireEffectWithIntent,
    markDispatchStarted,
    processEffect,
    settleRejected,
    deliverResult,
  }
}

describe('P3-1A1c-c durable manual retry result outbox', () => {
  it('correlates request and result with stable IDs before atomically claiming EFFECT plus intent', async () => {
    const { retry, writeAudit, acquireEffectWithIntent } = setup()

    await retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' })

    expect(writeAudit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        activityLogId: 'activity-request-1',
        intentId: 'intent-1',
        requestActivityLogId: 'activity-request-1',
        resultActivityLogId: 'activity-result-1',
        action: 'SUPERADMIN_WEBHOOK_EFFECT_RETRY_REQUESTED',
      }),
    )
    expect(acquireEffectWithIntent).toHaveBeenCalledWith({
      intentId: 'intent-1',
      requestActivityLogId: 'activity-request-1',
      resultActivityLogId: 'activity-result-1',
      actorId: 'staff-root',
      venueId: 'venue-1',
      eventId: 'webhook-1',
      reason: 'Validación controlada',
    })
  })

  it('marks dispatch-start durably before invoking the shared processor', async () => {
    const { retry, markDispatchStarted, processEffect } = setup()
    let startConfirmed = false
    markDispatchStarted.mockImplementation(async () => {
      startConfirmed = true
    })
    processEffect.mockImplementation(async () => {
      expect(startConfirmed).toBe(true)
      return 'COMPLETED'
    })

    await retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' })

    expect(markDispatchStarted).toHaveBeenCalledWith('intent-1', intent().lease)
    expect(processEffect).toHaveBeenCalledWith('webhook-1', intent().lease)
  })

  it('never executes EFFECT when durable dispatch-start confirmation fails', async () => {
    const { retry, markDispatchStarted, processEffect } = setup()
    markDispatchStarted.mockRejectedValue(new Error('database unavailable'))

    await expect(retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' })).rejects.toMatchObject({
      name: 'WebhookAuditUnavailableError',
      intentId: 'intent-1',
      auditState: 'PENDING',
      auditRecorded: false,
      auditPending: true,
    })
    expect(processEffect).not.toHaveBeenCalled()
  })

  it('returns the real success with auditPending while the durable outbox remains deliverable', async () => {
    const { retry, deliverResult, processEffect } = setup()
    deliverResult.mockResolvedValue({ delivered: false })

    await expect(retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' })).resolves.toMatchObject({
      success: true,
      attempt: 5,
      auditState: 'PENDING',
      auditRecorded: false,
      auditPending: true,
      intentId: 'intent-1',
    })
    expect(processEffect).toHaveBeenCalledTimes(1)
  })

  it('does not turn a completed EFFECT into a retryable failure when immediate audit delivery is unavailable', async () => {
    const { retry, deliverResult, processEffect } = setup()
    deliverResult.mockRejectedValue(new Error('database unavailable after completed effect'))

    await expect(retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' })).resolves.toMatchObject({
      success: true,
      attempt: 5,
      auditState: 'PENDING',
      auditRecorded: false,
      auditPending: true,
      intentId: 'intent-1',
    })
    expect(processEffect).toHaveBeenCalledTimes(1)
    expect(deliverResult).toHaveBeenCalledTimes(1)
  })

  it('settles SKIPPED as REJECTED, delivers its result, and returns typed 409 instead of success', async () => {
    const { retry, processEffect, settleRejected, deliverResult } = setup()
    processEffect.mockResolvedValue('SKIPPED')
    deliverResult.mockResolvedValue({ delivered: true, outcome: 'REJECTED' })

    await expect(retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' })).rejects.toBeInstanceOf(
      WebhookLeaseBusyError,
    )
    expect(settleRejected).toHaveBeenCalledWith('intent-1', intent().lease)
    expect(deliverResult).toHaveBeenCalledWith('intent-1')
  })

  it('keeps SKIPPED typed as 409 with a pending durable audit when immediate delivery is unavailable', async () => {
    const { retry, processEffect, settleRejected, deliverResult } = setup()
    processEffect.mockResolvedValue('SKIPPED')
    deliverResult.mockRejectedValue(new Error('database unavailable after rejected effect'))

    await expect(retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' })).rejects.toMatchObject({
      name: 'WebhookLeaseBusyError',
      code: 'WEBHOOK_LEASE_BUSY',
      statusCode: 409,
      auditState: 'PENDING',
      auditRecorded: false,
      auditPending: true,
      intentId: 'intent-1',
    })
    expect(settleRejected).toHaveBeenCalledTimes(1)
    expect(deliverResult).toHaveBeenCalledTimes(1)
  })

  it('recovers a lost SKIPPED settlement acknowledgement from the delivered REJECTED outbox', async () => {
    const { retry, processEffect, settleRejected, deliverResult } = setup()
    processEffect.mockResolvedValue('SKIPPED')
    settleRejected.mockRejectedValue(new Error('unknown settlement acknowledgement'))
    deliverResult.mockResolvedValue({ delivered: true, outcome: 'REJECTED' })

    await expect(retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' })).rejects.toMatchObject({
      name: 'WebhookLeaseBusyError',
      code: 'WEBHOOK_LEASE_BUSY',
      auditState: 'RECORDED',
      auditRecorded: true,
      auditPending: false,
    })
  })

  it('fails SKIPPED closed when neither settlement nor its durable result can be confirmed', async () => {
    const { retry, processEffect, settleRejected, deliverResult } = setup()
    processEffect.mockResolvedValue('SKIPPED')
    settleRejected.mockRejectedValue(new Error('settlement unavailable'))
    deliverResult.mockResolvedValue({ delivered: false })

    await expect(retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' })).rejects.toMatchObject({
      name: 'WebhookAuditUnavailableError',
      code: 'WEBHOOK_AUDIT_UNAVAILABLE',
      statusCode: 503,
      auditState: 'PENDING',
      auditRecorded: false,
      auditPending: true,
      intentId: 'intent-1',
    })
  })

  it('fails closed before claim when the correlated request ActivityLog is unavailable', async () => {
    const { retry, writeAudit, acquireEffectWithIntent } = setup()
    writeAudit.mockRejectedValue(new Error('database unavailable'))

    const error = await retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' }).catch(value => value)

    expect(error).toBeInstanceOf(WebhookAuditUnavailableError)
    expect(error).toMatchObject({ code: 'WEBHOOK_AUDIT_UNAVAILABLE' })
    expect(error.intentId).toBeUndefined()
    expect(error.auditState).toBeUndefined()
    expect(error.auditRecorded).toBeUndefined()
    expect(error.auditPending).toBeUndefined()
    expect(acquireEffectWithIntent).not.toHaveBeenCalled()
  })

  it('reports UNKNOWN instead of pending when claim plus intent acknowledgement cannot be confirmed', async () => {
    const { retry, acquireEffectWithIntent, markDispatchStarted, processEffect } = setup()
    acquireEffectWithIntent.mockRejectedValue(new Error('unknown transaction acknowledgement'))

    await expect(retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' })).rejects.toMatchObject({
      name: 'WebhookAuditUnavailableError',
      intentId: 'intent-1',
      auditState: 'UNKNOWN',
      auditRecorded: false,
      auditPending: false,
    })
    expect(markDispatchStarted).not.toHaveBeenCalled()
    expect(processEffect).not.toHaveBeenCalled()
  })

  it('does not advertise a durable intent when a rejected claim result ActivityLog fails', async () => {
    const { retry, writeAudit, acquireEffectWithIntent } = setup()
    acquireEffectWithIntent.mockResolvedValue(null)
    writeAudit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('result audit unavailable'))

    const error = await retry('webhook-1', { actorId: 'staff-root', reason: 'Validación controlada' }).catch(value => value)

    expect(error).toBeInstanceOf(WebhookAuditUnavailableError)
    expect(error.intentId).toBeUndefined()
    expect(error.auditState).toBeUndefined()
    expect(error.auditPending).toBeUndefined()
  })
})
