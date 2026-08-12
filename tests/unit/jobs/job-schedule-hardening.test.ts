import { CronTime } from 'cron'
import logger from '@/config/logger'

const mockNodeCronTaskOn = jest.fn()
const mockNodeCronSchedule = jest.fn((_pattern: string, _callback: () => Promise<void>, _options?: Record<string, unknown>) => ({
  on: mockNodeCronTaskOn,
}))
const mockReconcileStaleRequests = jest.fn()
const mockCheckOfflineTerminals = jest.fn()

jest.mock('node-cron', () => ({
  __esModule: true,
  default: {
    schedule: (pattern: string, callback: () => Promise<void>, options?: Record<string, unknown>) =>
      mockNodeCronSchedule(pattern, callback, options),
  },
}))

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: {
    reconcileStaleRequests: (...args: unknown[]) => mockReconcileStaleRequests(...args),
  },
}))

jest.mock('@/services/tpv/tpv-health.service', () => ({
  tpvHealthService: {
    checkOfflineTerminals: (...args: unknown[]) => mockCheckOfflineTerminals(...args),
  },
}))

import { TerminalPaymentWatchdogJob } from '@/jobs/terminal-payment-watchdog.job'
import { BlumonWebhookReconciliationJob } from '@/jobs/blumon-webhook-reconciliation.job'
import { GcalInboxSweeperJob } from '@/jobs/gcal-inbox-sweeper.job'
import { GcalOutboxSweeperJob } from '@/jobs/gcal-outbox-sweeper.job'
import { TpvHealthMonitorJob } from '@/jobs/tpv-health-monitor.job'
import { startPosConnectionMonitor } from '@/jobs/monitorPosConnections'

const EXPECTED_SCHEDULES = {
  terminalPaymentWatchdog: '8,38 * * * * *',
  blumonWebhookReconciliation: '11,41 * * * * *',
  tpvHealthMonitor: '14 */2 * * * *',
  posConnectionMonitor: '17 1-59/5 * * * *',
  gcalInboxSweeper: '23,53 * * * * *',
  gcalOutboxSweeper: '26,56 * * * * *',
} as const

type JobName = keyof typeof EXPECTED_SCHEDULES

function cronSource(job: object): string {
  const scheduledJob = Reflect.get(job, 'job') as { cronTime: { source: string } } | null
  if (!scheduledJob) throw new Error('Expected the job to register a CronJob')
  return scheduledJob.cronTime.source
}

function registeredPosSchedule(): { pattern: string; callback: () => Promise<void>; options?: Record<string, unknown> } {
  mockNodeCronSchedule.mockClear()
  startPosConnectionMonitor()

  const [pattern, callback, options] = mockNodeCronSchedule.mock.calls[0] ?? []
  if (typeof pattern !== 'string' || typeof callback !== 'function') {
    throw new Error('Expected POS connection monitor to register with node-cron')
  }
  return { pattern, callback, options }
}

function readRegisteredSchedules(): Record<JobName, string> {
  return {
    terminalPaymentWatchdog: cronSource(new TerminalPaymentWatchdogJob()),
    blumonWebhookReconciliation: cronSource(new BlumonWebhookReconciliationJob()),
    tpvHealthMonitor: cronSource(new TpvHealthMonitorJob()),
    posConnectionMonitor: registeredPosSchedule().pattern,
    gcalInboxSweeper: cronSource(new GcalInboxSweeperJob()),
    gcalOutboxSweeper: cronSource(new GcalOutboxSweeperJob()),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function yieldMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

function expandSchedule(pattern: string, startInclusive: Date, endExclusive: Date): Date[] {
  const cron = new CronTime(pattern, 'America/Mexico_City')
  const occurrences: Date[] = []
  let cursor = new Date(startInclusive.getTime() - 1)

  while (true) {
    const next = cron.getNextDateFrom(cursor, 'America/Mexico_City').toJSDate()
    if (next >= endExclusive) return occurrences
    occurrences.push(next)
    cursor = next
  }
}

describe('database cron schedule hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each([
    ['terminalPaymentWatchdog', () => cronSource(new TerminalPaymentWatchdogJob())],
    ['blumonWebhookReconciliation', () => cronSource(new BlumonWebhookReconciliationJob())],
    ['tpvHealthMonitor', () => cronSource(new TpvHealthMonitorJob())],
    ['gcalInboxSweeper', () => cronSource(new GcalInboxSweeperJob())],
    ['gcalOutboxSweeper', () => cronSource(new GcalOutboxSweeperJob())],
  ] as const)('%s registers its agreed second offset', (name, getPattern) => {
    expect(getPattern()).toBe(EXPECTED_SCHEDULES[name])
  })

  it('POS connection monitor registers its agreed second offset with scheduler overlap prevention', () => {
    const registration = registeredPosSchedule()

    expect(registration.pattern).toBe(EXPECTED_SCHEDULES.posConnectionMonitor)
  })

  it('POS connection monitor asks node-cron to skip overlapping executions', () => {
    const registration = registeredPosSchedule()

    expect(registration.options).toEqual(expect.objectContaining({ noOverlap: true }))
  })

  it('POS connection monitor logs native node-cron overlap events', () => {
    registeredPosSchedule()

    expect(mockNodeCronTaskOn).toHaveBeenCalledWith('execution:overlap', expect.any(Function))
    const overlapHandler = mockNodeCronTaskOn.mock.calls.find(([event]) => event === 'execution:overlap')?.[1]
    expect(typeof overlapHandler).toBe('function')
    ;(overlapHandler as () => void)()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('POS connection monitor'))
  })

  it('keeps each cadence and gives the six database jobs unique start instants over ten minutes', () => {
    const schedules = readRegisteredSchedules()
    const start = new Date('2026-08-07T12:00:00.000Z')
    const end = new Date('2026-08-07T12:10:00.000Z')
    const expectedCounts: Record<JobName, number> = {
      terminalPaymentWatchdog: 20,
      blumonWebhookReconciliation: 20,
      tpvHealthMonitor: 5,
      posConnectionMonitor: 2,
      gcalInboxSweeper: 20,
      gcalOutboxSweeper: 20,
    }

    const startsByInstant = new Map<number, JobName[]>()
    for (const [name, pattern] of Object.entries(schedules) as [JobName, string][]) {
      const occurrences = expandSchedule(pattern, start, end)
      expect(occurrences).toHaveLength(expectedCounts[name])
      for (const occurrence of occurrences) {
        const names = startsByInstant.get(occurrence.getTime()) ?? []
        names.push(name)
        startsByInstant.set(occurrence.getTime(), names)
      }
    }

    const collisions = [...startsByInstant.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([at, names]) => ({ at: new Date(at).toISOString(), names }))

    expect(collisions).toEqual([])
  })
})

describe('database cron overlap protection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('terminal-payment watchdog skips a concurrent pass and releases the guard after failure', async () => {
    const firstGate = deferred<{ completed: number; unknown: number; cancelled: number }>()
    const emptyResult = { completed: 0, unknown: 0, cancelled: 0 }
    mockReconcileStaleRequests.mockResolvedValue(emptyResult).mockImplementationOnce(() => firstGate.promise)
    const job = new TerminalPaymentWatchdogJob()

    const first = job.run()
    await yieldMicrotasks()
    const overlapping = job.run()
    await yieldMicrotasks()
    const callsWhileFirstPending = mockReconcileStaleRequests.mock.calls.length

    firstGate.reject(new Error('first pass failed'))
    await Promise.all([first, overlapping])
    await job.run()

    expect(callsWhileFirstPending).toBe(1)
    expect(mockReconcileStaleRequests).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Terminal-payment watchdog'))
  })

  it('Blumon reconciliation skips a concurrent pass and releases the guard after failure', async () => {
    const firstGate = deferred<number>()
    const job = new BlumonWebhookReconciliationJob()
    const reconcilePending = jest
      .spyOn(job as unknown as { reconcilePending: () => Promise<number> }, 'reconcilePending')
      .mockResolvedValue(0)
      .mockImplementationOnce(() => firstGate.promise)
    jest.spyOn(job as unknown as { markOrphaned: () => Promise<number> }, 'markOrphaned').mockResolvedValue(0)
    const run = Reflect.get(job, 'run').bind(job) as () => Promise<void>

    const first = run()
    await yieldMicrotasks()
    const overlapping = run()
    await yieldMicrotasks()
    const callsWhileFirstPending = reconcilePending.mock.calls.length

    firstGate.reject(new Error('first pass failed'))
    await Promise.all([first, overlapping])
    await run()

    expect(callsWhileFirstPending).toBe(1)
    expect(reconcilePending).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Blumon recon'))
  })

  it('TPV health monitor skips a concurrent pass and releases the guard after failure', async () => {
    const firstGate = deferred<void>()
    mockCheckOfflineTerminals.mockResolvedValue(undefined).mockImplementationOnce(() => firstGate.promise)
    const job = new TpvHealthMonitorJob()

    const first = job.checkNow()
    await yieldMicrotasks()
    const overlapping = job.checkNow()
    await yieldMicrotasks()
    const callsWhileFirstPending = mockCheckOfflineTerminals.mock.calls.length

    firstGate.reject(new Error('first pass failed'))
    await Promise.all([first, overlapping])
    await job.checkNow()

    expect(callsWhileFirstPending).toBe(1)
    expect(mockCheckOfflineTerminals).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('TPV health'))
  })

  it.each([
    ['Gcal inbox', () => new GcalInboxSweeperJob()],
    ['Gcal outbox', () => new GcalOutboxSweeperJob()],
  ])('%s logs when an overlapping tick is skipped', async (name, createJob) => {
    const job = createJob()
    Reflect.set(job, 'isRunning', true)

    await job.runNow()

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(name), expect.anything())
  })
})
