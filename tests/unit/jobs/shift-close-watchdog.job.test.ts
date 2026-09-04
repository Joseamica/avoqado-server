import { ShiftCloseWatchdogJob } from '@/jobs/shift-close-watchdog.job'
import { shouldRetryDbConnectionError } from '@/utils/retry'

const NOW = new Date('2026-08-10T12:00:00.000Z')
const STALE_CUTOFF = new Date('2026-08-10T11:55:00.000Z')
const STALE_AT = new Date('2026-08-10T11:54:59.999Z')
const candidate = { id: 'shift-1', venueId: 'venue-1', updatedAt: STALE_AT }

async function retryConnectionFailureOnce<T>(
  operation: () => Promise<T>,
  options: { shouldRetry?: (error: unknown) => boolean },
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!options.shouldRetry?.(error)) throw error
    return operation()
  }
}

function harness(counts: number[] = [1]) {
  const updateMany = jest.fn().mockImplementation(async () => ({ count: counts.shift() ?? 0 }))
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    shift: { updateMany },
  }
  const prisma = {
    shift: {
      findMany: jest.fn().mockResolvedValue([candidate]),
      updateMany,
    },
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  }
  const job = new ShiftCloseWatchdogJob({
    prisma: prisma as never,
    cron: { start: jest.fn(), stop: jest.fn() } as never,
    now: () => NOW,
  })
  return { job, prisma, tx }
}

describe('shift-close-watchdog.job', () => {
  it('toma el lock DB del venue antes del recovery CLOSING→OPEN', async () => {
    const h = harness()

    await h.job.runNow()

    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(h.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(h.prisma.shift.updateMany.mock.invocationCallOrder[0])
  })

  it('CAS-reopens only the exact stale CLOSING tuple', async () => {
    const h = harness()

    await expect(h.job.runNow()).resolves.toEqual({ scanned: 1, reopened: 1, skipped: 0, errors: 0 })

    expect(h.prisma.shift.findMany).toHaveBeenCalledWith({
      where: { status: 'CLOSING', endTime: null, updatedAt: { lte: STALE_CUTOFF } },
      select: { id: true, venueId: true, updatedAt: true },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 100,
    })
    expect(h.prisma.shift.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'shift-1',
        venueId: 'venue-1',
        status: 'CLOSING',
        endTime: null,
        updatedAt: STALE_AT,
      },
      data: { status: 'OPEN', updatedAt: NOW },
    })
  })

  it('skips a claim that changed after the bounded scan', async () => {
    const h = harness([0])

    await expect(h.job.runNow()).resolves.toEqual({ scanned: 1, reopened: 0, skipped: 1, errors: 0 })
  })

  it('continues after one candidate fails', async () => {
    const second = { id: 'shift-2', venueId: 'venue-1', updatedAt: STALE_AT }
    const h = harness([1])
    h.prisma.shift.findMany.mockResolvedValueOnce([candidate, second])
    h.prisma.shift.updateMany.mockRejectedValueOnce(new Error('db write failed'))

    await expect(h.job.runNow()).resolves.toEqual({ scanned: 2, reopened: 1, skipped: 0, errors: 1 })
    expect(h.prisma.shift.updateMany).toHaveBeenCalledTimes(2)
  })

  it('retries only the entry scan after a transient connection failure', async () => {
    const findMany = jest.fn().mockRejectedValueOnce({ code: 'P1001' }).mockResolvedValueOnce([])
    const updateMany = jest.fn()
    const job = new ShiftCloseWatchdogJob({
      prisma: { shift: { findMany, updateMany } } as never,
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      now: () => NOW,
      retryEntry: retryConnectionFailureOnce as never,
    })

    await expect(job.runNow()).resolves.toEqual({ scanned: 0, reopened: 0, skipped: 0, errors: 0 })
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(updateMany).not.toHaveBeenCalled()
    expect(shouldRetryDbConnectionError({ code: 'P1001' })).toBe(true)
  })

  it('does not overlap cron and manual passes', async () => {
    let release!: () => void
    const findMany = jest.fn(
      () =>
        new Promise(resolve => {
          release = () => resolve([])
        }),
    )
    const job = new ShiftCloseWatchdogJob({
      prisma: { shift: { findMany, updateMany: jest.fn() } } as never,
      cron: { start: jest.fn(), stop: jest.fn() } as never,
      now: () => NOW,
    })

    const first = job.runNow()
    await expect(job.runNow()).resolves.toEqual({ scanned: 0, reopened: 0, skipped: 1, errors: 0 })
    release()
    await first
    expect(findMany).toHaveBeenCalledTimes(1)
  })
})
