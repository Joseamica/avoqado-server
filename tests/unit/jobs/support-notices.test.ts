jest.mock('@/observability/jobContext', () => ({
  scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })),
  runInJobContext: jest.fn((_name, fn) => fn()),
}))
jest.mock('@/services/support/notices.service', () => ({
  runSupportNotices: jest.fn().mockResolvedValue({ sent: 1, failed: 0, skipped: 0, uncertain: 0 }),
}))
jest.mock('@/config/supportWhatsapp', () => ({ getSupportHandoffConfig: jest.fn() }))
import logger from '@/config/logger'
import { scheduleJob } from '@/observability/jobContext'
import { getSupportHandoffConfig } from '@/config/supportWhatsapp'
import { runSupportNotices } from '@/services/support/notices.service'
import { SupportNoticesJob } from '@/jobs/support-notices.job'

const config = { to: 'soporte@test.local', whatsappDisplay: '+52 56 4007 0001', phoneDailyCap: 3, dailyCap: 20, weeklyHour: 9 }
beforeEach(() => {
  ;(getSupportHandoffConfig as jest.Mock).mockReturnValue(config)
})

it('registers its free seconds :01/:31 in Mexico City, starts an initial pass and stops its own scheduler', async () => {
  const job = new SupportNoticesJob()
  expect(scheduleJob).toHaveBeenCalledWith('support-notices', '1,31 * * * * *', expect.any(Function), null, false, 'America/Mexico_City')
  job.start()
  await new Promise(resolve => setImmediate(resolve))
  expect(runSupportNotices).toHaveBeenCalledTimes(1)
  const scheduled = (scheduleJob as jest.Mock).mock.results.at(-1)!.value
  expect(scheduled.start).toHaveBeenCalledTimes(1)
  job.stop()
  expect(scheduled.stop).toHaveBeenCalledTimes(1)
})

it('SupportNoticesJob runs runSupportNotices only with handoff config and never overlaps itself', async () => {
  ;(getSupportHandoffConfig as jest.Mock).mockReturnValue(null)
  const job = new SupportNoticesJob()
  await job.runNow()
  expect(runSupportNotices).not.toHaveBeenCalled()
  ;(getSupportHandoffConfig as jest.Mock).mockReturnValue(config)
  let release!: () => void
  ;(runSupportNotices as jest.Mock).mockImplementationOnce(
    () => new Promise(resolve => (release = () => resolve({ sent: 0, failed: 0, skipped: 0, uncertain: 0 }))),
  )
  const first = job.runNow()
  await new Promise(resolve => setImmediate(resolve))
  await job.runNow()
  expect(runSupportNotices).toHaveBeenCalledTimes(1)
  release()
  await first
  // The guard is released after the pass: the next tick runs.
  await job.runNow()
  expect(runSupportNotices).toHaveBeenCalledTimes(2)
})

it('logs a safe code on a failed tick and permits the next one, without leaking error text', async () => {
  ;(runSupportNotices as jest.Mock).mockRejectedValueOnce(new Error('verano123 ana@cliente.mx'))
  const job = new SupportNoticesJob()
  await job.runNow()
  await job.runNow()
  expect(runSupportNotices).toHaveBeenCalledTimes(2)
  expect(logger.error).toHaveBeenCalledWith('Support notices tick failed', { code: 'SUPPORT_NOTICES_TICK_FAILED' })
  expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('verano123')
})
