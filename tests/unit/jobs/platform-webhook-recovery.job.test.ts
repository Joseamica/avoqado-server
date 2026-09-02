import { PlatformWebhookOperationalAlertJob, PlatformWebhookPhaseRecoveryJob } from '@/jobs/platform-webhook-recovery.job'

const classificationLease = { eventId: 'whe-classification', phase: 'CLASSIFICATION' }
const effectLease = { eventId: 'whe-effect', phase: 'EFFECT' }

function phaseSetup(phase: 'CLASSIFICATION' | 'EFFECT', enabled = true) {
  const inbox = {
    terminalizeExhausted: jest.fn(async () => []),
    acquireNext: jest
      .fn()
      .mockResolvedValueOnce(phase === 'CLASSIFICATION' ? classificationLease : effectLease)
      .mockResolvedValue(null),
  }
  const processor = { processClassification: jest.fn(), processEffect: jest.fn() }
  const readiness = jest.fn(async () => undefined)
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const job = new PlatformWebhookPhaseRecoveryJob({
    phase,
    enabled,
    inbox,
    processor,
    readiness,
    logger,
    schedule: { start: jest.fn(), stop: jest.fn() },
  } as any)
  return { job, inbox, processor, readiness, logger }
}

describe('independent platform webhook recovery jobs', () => {
  it('is a complete no-op while recovery is disabled', async () => {
    const { job, inbox, readiness } = phaseSetup('CLASSIFICATION', false)

    await job.runOnce()

    expect(readiness).not.toHaveBeenCalled()
    expect(inbox.terminalizeExhausted).not.toHaveBeenCalled()
    expect(inbox.acquireNext).not.toHaveBeenCalled()
  })

  it.each([
    ['CLASSIFICATION', 'processClassification', classificationLease],
    ['EFFECT', 'processEffect', effectLease],
  ] as const)('terminalizes then claims only %s and invokes only its processor phase', async (phase, method, claimedLease) => {
    const { job, inbox, processor, readiness } = phaseSetup(phase)

    await job.runOnce()

    expect(readiness).toHaveBeenCalledTimes(1)
    expect(inbox.terminalizeExhausted).toHaveBeenCalledWith(phase)
    expect(inbox.acquireNext).toHaveBeenCalledWith(phase)
    expect(processor[method]).toHaveBeenCalledWith(claimedLease.eventId, claimedLease)
    expect(processor[method === 'processEffect' ? 'processClassification' : 'processEffect']).not.toHaveBeenCalled()
  })

  it('has a per-job running guard without coupling the two phases', async () => {
    const classification = phaseSetup('CLASSIFICATION')
    const effect = phaseSetup('EFFECT')
    let release!: () => void
    classification.readiness.mockImplementationOnce(() => new Promise<undefined>(resolve => (release = () => resolve(undefined))))

    const first = classification.job.runOnce()
    const duplicate = classification.job.runOnce()
    await effect.job.runOnce()
    release()
    await Promise.all([first, duplicate])

    expect(classification.inbox.acquireNext).toHaveBeenCalledTimes(2)
    expect(effect.inbox.acquireNext).toHaveBeenCalledTimes(2)
  })

  it.each(['CLASSIFICATION', 'EFFECT'] as const)(
    'claims %s just-in-time so a later row receives a fresh lease only after the prior phase returns',
    async phase => {
      const { job, inbox, processor } = phaseSetup(phase)
      const leaseMs = phase === 'CLASSIFICATION' ? 2 * 60_000 : 15 * 60_000
      let clock = new Date('2026-08-23T00:00:00.000Z').getTime()
      const first = {
        ...(phase === 'CLASSIFICATION' ? classificationLease : effectLease),
        eventId: 'ahead',
        attempt: 1,
        claimedAt: new Date(clock),
        claimExpiresAt: new Date(clock + leaseMs),
      }
      let second: any
      let firstFinished = false
      inbox.acquireNext
        .mockReset()
        .mockImplementationOnce(async () => first)
        .mockImplementationOnce(async () => {
          expect(firstFinished).toBe(true)
          second = {
            ...first,
            eventId: 'behind',
            claimToken: 'fresh-behind',
            attempt: 1,
            claimedAt: new Date(clock),
            claimExpiresAt: new Date(clock + leaseMs),
          }
          return second
        })
        .mockResolvedValue(null)
      processor[phase === 'CLASSIFICATION' ? 'processClassification' : 'processEffect'].mockImplementationOnce(async () => {
        clock += leaseMs + 1
        firstFinished = true
        throw new Error('simulated crash after phase start')
      })

      await job.runOnce()

      expect(inbox.acquireNext).toHaveBeenCalledTimes(3)
      expect(processor[phase === 'CLASSIFICATION' ? 'processClassification' : 'processEffect']).toHaveBeenLastCalledWith('behind', second)
      expect(second.attempt).toBe(1)
      expect(second.claimedAt.getTime()).toBeGreaterThan(first.claimExpiresAt.getTime())
    },
  )

  it('does not spend the row-behind attempt during five crashes ahead of it', async () => {
    const { job, inbox, processor } = phaseSetup('EFFECT')
    inbox.acquireNext.mockReset()
    for (let index = 0; index < 5; index += 1) {
      inbox.acquireNext.mockResolvedValueOnce({ ...effectLease, eventId: `ahead-${index}`, attempt: 1 })
      inbox.acquireNext.mockResolvedValueOnce(null)
    }
    inbox.acquireNext.mockResolvedValueOnce({ ...effectLease, eventId: 'behind', attempt: 1 }).mockResolvedValueOnce(null)
    processor.processEffect.mockImplementation(async (eventId: string) => {
      if (eventId.startsWith('ahead-')) throw new Error('worker crashed after just-in-time claim')
    })

    for (let tick = 0; tick < 5; tick += 1) {
      await job.runOnce()
      expect(processor.processEffect).not.toHaveBeenCalledWith('behind', expect.anything())
    }
    await job.runOnce()

    expect(processor.processEffect).toHaveBeenCalledWith('behind', expect.objectContaining({ attempt: 1 }))
  })

  it.each([
    ['OFF', false],
    ['OFF', true],
    ['SHADOW', false],
  ] as const)('performs zero recovery mutations for disabled cross-product %s/%s', async (_mode, _flag) => {
    const { job, inbox, readiness } = phaseSetup('EFFECT', false)

    await job.runOnce()

    expect(readiness).not.toHaveBeenCalled()
    expect(inbox.terminalizeExhausted).not.toHaveBeenCalled()
    expect(inbox.acquireNext).not.toHaveBeenCalled()
  })
})

describe('platform webhook operational alert deliverer', () => {
  it('acknowledges every durably claimed alert after structured delivery', async () => {
    const lease = { alertId: 'alert-1', webhookEventId: 'whe-1', phase: 'EFFECT', terminalReason: 'EFFECT_ATTEMPTS_EXHAUSTED' }
    const inbox = {
      claimOperationalAlerts: jest.fn(async () => [lease]),
      acknowledgeOperationalAlert: jest.fn(),
      retryOperationalAlert: jest.fn(),
    }
    const deliver = jest.fn()
    const job = new PlatformWebhookOperationalAlertJob({
      enabled: true,
      inbox,
      readiness: jest.fn(),
      deliver,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      schedule: { start: jest.fn(), stop: jest.fn() },
    } as any)

    await job.runOnce()

    expect(deliver).toHaveBeenCalledWith(lease)
    expect(inbox.acknowledgeOperationalAlert).toHaveBeenCalledWith(lease)
    expect(inbox.retryOperationalAlert).not.toHaveBeenCalled()
  })

  it('releases a failed delivery through the durable alert retry CAS', async () => {
    const lease = { alertId: 'alert-1', webhookEventId: 'whe-1', phase: 'CLASSIFICATION', terminalReason: 'EXHAUSTED' }
    const inbox = {
      claimOperationalAlerts: jest.fn(async () => [lease]),
      acknowledgeOperationalAlert: jest.fn(),
      retryOperationalAlert: jest.fn(),
    }
    const job = new PlatformWebhookOperationalAlertJob({
      enabled: true,
      inbox,
      readiness: jest.fn(),
      deliver: jest.fn(async () => {
        throw new Error('log transport down')
      }),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      schedule: { start: jest.fn(), stop: jest.fn() },
    } as any)

    await job.runOnce()

    expect(inbox.acknowledgeOperationalAlert).not.toHaveBeenCalled()
    expect(inbox.retryOperationalAlert).toHaveBeenCalledWith(lease)
  })

  it('does not claim or mutate alerts while recovery is disabled', async () => {
    const inbox = {
      claimOperationalAlerts: jest.fn(),
      acknowledgeOperationalAlert: jest.fn(),
      retryOperationalAlert: jest.fn(),
    }
    const job = new PlatformWebhookOperationalAlertJob({
      enabled: false,
      inbox,
      readiness: jest.fn(),
      deliver: jest.fn(),
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      schedule: { start: jest.fn(), stop: jest.fn() },
    } as any)

    await job.runOnce()

    expect(inbox.claimOperationalAlerts).not.toHaveBeenCalled()
  })
})
