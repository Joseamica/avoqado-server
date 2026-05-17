/**
 * gcal-outbox-sweeper.job unit tests (Phase 2 — Section C).
 *
 * Verifies pickup criteria + per-row processing + concurrency guard.
 * Heavy use of jest.mock to swap `processOutboxRow` for an inspectable spy.
 */
import { prismaMock } from '@tests/__helpers__/setup'

// Mock the push.service entry point BEFORE importing the job so the job
// resolves the mocked symbol.
const processOutboxRowMock = jest.fn()
jest.mock('@/services/google-calendar/push.service', () => ({
  processOutboxRow: (...args: unknown[]) => processOutboxRowMock(...args),
}))

import { GcalOutboxSweeperJob } from '@/jobs/gcal-outbox-sweeper.job'

describe('GcalOutboxSweeperJob', () => {
  let job: GcalOutboxSweeperJob

  beforeEach(() => {
    job = new GcalOutboxSweeperJob()
    processOutboxRowMock.mockReset()
    ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockReset()
  })

  afterEach(() => {
    job.stop()
  })

  describe('lifecycle', () => {
    it('start/stop do not throw', () => {
      expect(() => job.start()).not.toThrow()
      expect(() => job.stop()).not.toThrow()
    })
  })

  describe('process', () => {
    it('calls processOutboxRow for each picked row', async () => {
      ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValue([
        { id: 'row-1', syncKey: 'reservation:r1:c1' },
        { id: 'row-2', syncKey: 'reservation:r2:c1' },
      ])
      processOutboxRowMock.mockResolvedValue(undefined)

      await job.runNow()

      expect(processOutboxRowMock).toHaveBeenCalledTimes(2)
      expect(processOutboxRowMock).toHaveBeenNthCalledWith(1, 'row-1')
      expect(processOutboxRowMock).toHaveBeenNthCalledWith(2, 'row-2')
    })

    it('uses PENDING+FAILED status filter with scheduledAt<=NOW and debounce gate', async () => {
      ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValue([])

      await job.runNow()

      const call = (prismaMock.calendarSyncOutbox.findMany as jest.Mock).mock.calls[0][0]
      expect(call.where.status).toEqual({ in: ['PENDING', 'FAILED'] })
      expect(call.where.scheduledAt).toHaveProperty('lte')
      expect(call.where.OR).toEqual([{ debounceUntil: null }, { debounceUntil: { lte: expect.any(Date) } }])
      // Does NOT pick up IN_PROGRESS rows
      expect(call.where.status.in).not.toContain('IN_PROGRESS')
    })

    it('returns early when no rows are ready (no processOutboxRow calls)', async () => {
      ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValue([])

      await job.runNow()

      expect(processOutboxRowMock).not.toHaveBeenCalled()
    })

    it('unexpected exception in processOutboxRow does not break the loop', async () => {
      ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValue([
        { id: 'row-1', syncKey: 'k1' },
        { id: 'row-2', syncKey: 'k2' },
        { id: 'row-3', syncKey: 'k3' },
      ])
      processOutboxRowMock
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('db connection lost'))
        .mockResolvedValueOnce(undefined)

      await job.runNow()

      // All three rows are attempted despite the middle one throwing.
      expect(processOutboxRowMock).toHaveBeenCalledTimes(3)
    })

    it('isRunning guard prevents concurrent ticks', async () => {
      // Make findMany hang on the first call so the run never finishes.
      let resolveFirst: () => void = () => {}
      const firstFinished = new Promise<void>(r => (resolveFirst = r))
      ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock)
        .mockImplementationOnce(() => firstFinished.then(() => []))
        .mockResolvedValue([])

      // Kick off the first run but don't await it.
      const first = job.runNow()
      // Second tick should bail out immediately.
      await job.runNow()
      expect(prismaMock.calendarSyncOutbox.findMany).toHaveBeenCalledTimes(1)

      // Let the first one complete + verify a third tick proceeds normally.
      resolveFirst()
      await first
      await job.runNow()
      expect(prismaMock.calendarSyncOutbox.findMany).toHaveBeenCalledTimes(2)
    })

    it('orders by scheduledAt asc with a batch limit', async () => {
      ;(prismaMock.calendarSyncOutbox.findMany as jest.Mock).mockResolvedValue([])

      await job.runNow()

      const call = (prismaMock.calendarSyncOutbox.findMany as jest.Mock).mock.calls[0][0]
      expect(call.orderBy).toEqual({ scheduledAt: 'asc' })
      expect(call.take).toBe(100)
      expect(call.select).toEqual({ id: true, syncKey: true })
    })
  })
})
