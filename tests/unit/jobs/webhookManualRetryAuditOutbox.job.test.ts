const schedule = { start: jest.fn(), stop: jest.fn() }
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => schedule) }))

const deliverDueResults = jest.fn(async () => ({ claimed: 0, delivered: 0, waiting: 0, failed: 0 }))
jest.mock('@/services/superadmin/webhookManualRetryOutbox.service', () => ({
  webhookManualRetryOutbox: { deliverDueResults },
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $queryRaw: jest.fn(async () => [{ '?column?': 1 }]) },
}))

import { WebhookManualRetryAuditOutboxJob, webhookManualRetryAuditOutboxJob } from '@/jobs/webhook-manual-retry-audit-outbox.job'

describe('P3-1A1c-c manual retry audit outbox job', () => {
  beforeEach(() => jest.clearAllMocks())

  it('does not start or deliver merely because the singleton module was imported', () => {
    expect(webhookManualRetryAuditOutboxJob).toBeDefined()
    expect(schedule.start).not.toHaveBeenCalled()
    expect(deliverDueResults).not.toHaveBeenCalled()
  })

  it('starts and stops its schedule at most once per lifecycle', () => {
    const localSchedule = { start: jest.fn(), stop: jest.fn() }
    const job = new WebhookManualRetryAuditOutboxJob({
      enabled: true,
      readiness: jest.fn(),
      deliverDueResults,
      logger: { info: jest.fn(), error: jest.fn() },
      schedule: localSchedule,
    })

    job.start()
    job.start()
    job.stop()
    job.stop()

    expect(localSchedule.start).toHaveBeenCalledTimes(1)
    expect(localSchedule.stop).toHaveBeenCalledTimes(1)
  })

  it('prevents overlapping ticks and resumes on the next tick', async () => {
    let release!: () => void
    const readiness = jest
      .fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => (release = resolve)))
      .mockResolvedValue(undefined)
    const job = new WebhookManualRetryAuditOutboxJob({
      enabled: true,
      readiness,
      deliverDueResults,
      logger: { info: jest.fn(), error: jest.fn() },
      schedule: { start: jest.fn(), stop: jest.fn() },
    })

    const first = job.runOnce()
    const overlapping = job.runOnce()
    release()
    await Promise.all([first, overlapping])
    await job.runOnce()

    expect(readiness).toHaveBeenCalledTimes(2)
    expect(deliverDueResults).toHaveBeenCalledTimes(2)
  })
})
