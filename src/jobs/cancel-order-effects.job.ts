import { scheduleJob } from '../observability/jobContext'
import { drainPendingCancellationEffects } from '../services/mobile/cancelOrderEffects.service'
import logger from '../config/logger'
import { DATABASE_JOB_SCHEDULES } from './jobSchedules'

let running = false
async function runNow(): Promise<void> {
  if (running) return
  running = true
  try {
    await drainPendingCancellationEffects()
  } catch (error) {
    logger.warn('[CancelOrderEffects] Falló el barrido; se reintenta', { error: error instanceof Error ? error.message : String(error) })
  } finally {
    running = false
  }
}
const cron = scheduleJob(
  'cancel-order-effects',
  DATABASE_JOB_SCHEDULES.cancelOrderEffects,
  () => void runNow(),
  null,
  false,
  'America/Mexico_City',
)
export const cancelOrderEffectsJob = { start: () => cron.start(), stop: () => cron.stop(), runNow }
