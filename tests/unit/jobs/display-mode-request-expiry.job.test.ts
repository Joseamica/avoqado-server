import logger from '@/config/logger'
import { DisplayModeRequestExpiryJob } from '@/jobs/display-mode-request-expiry.job'
import { shouldRetryDbConnectionError } from '@/utils/retry'

const NOW = new Date('2026-08-30T18:00:04.000Z')
const CANDIDATES = [
  { id: 'terminal-1', venueId: 'venue-1' },
  { id: 'terminal-2', venueId: 'venue-2' },
]

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

function harness(
  options: {
    candidates?: typeof CANDIDATES
    expireRequest?: jest.Mock
    findMany?: jest.Mock
    now?: jest.Mock
  } = {},
) {
  const cron = { start: jest.fn(), stop: jest.fn() }
  const findMany = options.findMany ?? jest.fn().mockResolvedValue(options.candidates ?? CANDIDATES)
  const expireRequest = options.expireRequest ?? jest.fn().mockResolvedValue({ mutated: true })
  const now = options.now ?? jest.fn(() => NOW)
  const job = new DisplayModeRequestExpiryJob({
    prisma: { terminal: { findMany } } as never,
    cron: cron as never,
    expireRequest,
    retryEntry: retryConnectionFailureOnce as never,
    now,
  })

  return { job, cron, findMany, expireRequest, now }
}

describe('display-mode-request-expiry.job', () => {
  it('reads only the bounded, deterministically ordered rows due through the indexed expiry field', async () => {
    const h = harness({ candidates: [] })

    await h.job.checkNow()

    expect(h.findMany).toHaveBeenCalledWith({
      where: { customerDisplayRequestExpiresAt: { lte: NOW } },
      select: { id: true, venueId: true },
      orderBy: [{ customerDisplayRequestExpiresAt: 'asc' }, { id: 'asc' }],
      take: 100,
    })
  })

  it('uses one fixed tick time for the scan and every tenant-scoped expiry transition', async () => {
    const h = harness()

    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 2, noop: 0, errors: 0 })

    expect(h.now).toHaveBeenCalledTimes(1)
    expect(h.expireRequest).toHaveBeenNthCalledWith(1, {
      venueId: 'venue-1',
      terminalId: 'terminal-1',
      now: NOW,
    })
    expect(h.expireRequest).toHaveBeenNthCalledWith(2, {
      venueId: 'venue-2',
      terminalId: 'terminal-2',
      now: NOW,
    })
  })

  it('treats a stale candidate as an idempotent NOOP on a second pass', async () => {
    const expireRequest = jest.fn().mockResolvedValueOnce({ mutated: true }).mockResolvedValueOnce({ mutated: false })
    const h = harness({ candidates: [CANDIDATES[0]], expireRequest })

    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 1, expired: 1, noop: 0, errors: 0 })
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 1, expired: 0, noop: 1, errors: 0 })

    expect(expireRequest).toHaveBeenCalledTimes(2)
  })

  it('skips an overlapping tick and releases the guard after the first pass', async () => {
    let release!: (rows: typeof CANDIDATES) => void
    const findMany = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof CANDIDATES>(resolve => {
            release = resolve
          }),
      )
      .mockResolvedValue([])
    const h = harness({ findMany })

    const first = h.job.checkNow()
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 0, expired: 0, noop: 0, errors: 0, skipped: true })
    release([])
    await expect(first).resolves.toEqual({ scanned: 0, expired: 0, noop: 0, errors: 0 })
    await h.job.checkNow()

    expect(findMany).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Display-mode request expiry'))
  })

  it('retries the pure entry read after a transient connection failure', async () => {
    const findMany = jest.fn().mockRejectedValueOnce({ code: 'P1001' }).mockResolvedValueOnce([])
    const h = harness({ findMany })

    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 0, expired: 0, noop: 0, errors: 0 })

    expect(findMany).toHaveBeenCalledTimes(2)
    expect(shouldRetryDbConnectionError({ code: 'P1001' })).toBe(true)
  })

  it('does not retry or crash the process for a non-connection entry error', async () => {
    const findMany = jest.fn().mockRejectedValue({ code: 'P2002' })
    const h = harness({ findMany })

    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 0, expired: 0, noop: 0, errors: 1 })

    expect(findMany).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Display-mode request expiry'), expect.anything())
  })

  it('logs one candidate error, continues the bounded pass, and clears the overlap guard', async () => {
    const expireRequest = jest.fn().mockRejectedValueOnce(new Error('candidate failed')).mockResolvedValue({ mutated: true })
    const h = harness({ expireRequest })

    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 1, noop: 0, errors: 1 })
    await expect(h.job.checkNow()).resolves.toEqual({ scanned: 2, expired: 2, noop: 0, errors: 0 })

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('candidate failed'),
      expect.objectContaining({ terminalId: 'terminal-1', venueId: 'venue-1' }),
    )
  })

  it('starts, stops, and exposes a manual check surface', async () => {
    const h = harness({ candidates: [] })

    h.job.start()
    await h.job.checkNow()
    h.job.stop()

    expect(h.cron.start).toHaveBeenCalledTimes(1)
    expect(h.findMany).toHaveBeenCalledTimes(1)
    expect(h.cron.stop).toHaveBeenCalledTimes(1)
  })
})
