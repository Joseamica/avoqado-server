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
  // Fase 1: avisos de aprobación de clientes. Segundo 20/50, hueco libre entre el monitor
  // de POS (:17) y el sweeper de gcal (:23) — el escalonado es lo que evita la estampida.
  customerApprovalOutbox: '20,50 * * * * *',
  // Anuncios de plataforma programados. Cada 5 min en el segundo 47 — hueco libre entre
  // el sweeper de inventario (:44) y el de gcal (:53).
  publishScheduledAnnouncements: '47 */5 * * * *',
} as const
