/**
 * Database-heavy jobs are deliberately staggered by seconds. Keeping the
 * offsets together makes accidental pool stampedes visible in code review.
 */
export const DATABASE_JOB_SCHEDULES = {
  terminalPaymentWatchdog: '8,38 * * * * *',
  blumonWebhookReconciliation: '11,41 * * * * *',
  tpvHealthMonitor: '14 */2 * * * *',
  posConnectionMonitor: '17 1-59/5 * * * *',
  gcalInboxSweeper: '23,53 * * * * *',
  gcalOutboxSweeper: '26,56 * * * * *',
  catalogPublicationOutboxSweeper: '29,59 * * * * *',
  catalogPublicationWatchdog: '32 * * * * *',
  shiftCloseWatchdog: '35 * * * * *',
  inventoryPostingSweeper: '44 */2 * * * *',
} as const
