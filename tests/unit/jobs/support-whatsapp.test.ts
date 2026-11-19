jest.mock('@/observability/jobContext', () => ({
  scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
  runInJobContext: jest.fn((_name, fn) => fn()),
}))
jest.mock('@/services/support/worker.service', () => ({
  runSupportBatch: jest.fn().mockResolvedValue({ claimed: 1, completed: 1, unknown: 0 }),
}))
jest.mock('@/utils/retry', () => ({ retry: jest.fn(fn => fn()), shouldRetryDbConnectionError: jest.fn() }))
jest.mock('@/services/support/retention.service', () => ({ purgeSupportBatch: jest.fn().mockResolvedValue({ redacted: 0, deleted: 0 }) }))
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { scheduleJob } from '@/observability/jobContext'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { runSupportBatch } from '@/services/support/worker.service'
import { purgeSupportBatch } from '@/services/support/retention.service'
import { SupportWhatsappJob } from '@/jobs/support-whatsapp.job'
beforeEach(() => {
  ;(prisma.supportMessage.count as jest.Mock).mockResolvedValue(1)
})
it('registers staggered seconds, starts an initial sweep and stops its own scheduler', async () => {
  const job = new SupportWhatsappJob()
  expect(scheduleJob).toHaveBeenCalledWith(
    'support-whatsapp',
    '5,15,25,35,45,55 * * * * *',
    expect.any(Function),
    null,
    false,
    'America/Mexico_City',
  )
  job.start()
  await new Promise(resolve => setImmediate(resolve))
  expect(runSupportBatch).toHaveBeenCalledTimes(1)
  const scheduled = (scheduleJob as jest.Mock).mock.results[0].value
  expect(scheduled.start).toHaveBeenCalledTimes(1)
  job.stop()
  expect(scheduled.stop).toHaveBeenCalledTimes(1)
})
it('retries only the entry read, never the batch or any external request', async () => {
  await new SupportWhatsappJob().runNow()
  expect(retry).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ shouldRetry: shouldRetryDbConnectionError, retries: 2 }),
  )
  expect(prisma.supportMessage.count).toHaveBeenCalledTimes(1)
  expect(runSupportBatch).toHaveBeenCalledTimes(1)
})
it('does not overlap ticks while one batch is still in flight', async () => {
  let release!: () => void
  ;(runSupportBatch as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = () => resolve({ claimed: 1, completed: 1, unknown: 0 })
      }),
  )
  const job = new SupportWhatsappJob(),
    first = job.runNow()
  await new Promise(resolve => setImmediate(resolve))
  await job.runNow()
  expect(runSupportBatch).toHaveBeenCalledTimes(1)
  release()
  await first
})
it('logs a safe code on a failed tick and permits the next tick, without leaking error text', async () => {
  ;(runSupportBatch as jest.Mock).mockRejectedValueOnce(new Error('PREGUNTA_SECRETA 123456'))
  const job = new SupportWhatsappJob()
  await job.runNow()
  await job.runNow()
  expect(runSupportBatch).toHaveBeenCalledTimes(2)
  expect(logger.error).toHaveBeenCalled()
  expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('PREGUNTA_SECRETA')
})
it('runs retention even with no pending messages and observes failures without claiming success', async () => {
  ;(prisma.supportMessage.count as jest.Mock).mockResolvedValue(0)
  const job = new SupportWhatsappJob()
  await job.runNow()
  expect(purgeSupportBatch).toHaveBeenCalledTimes(1)
  expect(runSupportBatch).not.toHaveBeenCalled()
  ;(purgeSupportBatch as jest.Mock).mockRejectedValueOnce(new Error('OTP SECRETO'))
  await job.runNow()
  expect(logger.error).toHaveBeenCalledWith('Support WhatsApp tick failed', { code: 'SUPPORT_TICK_FAILED' })
  expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('SECRETO')
})
