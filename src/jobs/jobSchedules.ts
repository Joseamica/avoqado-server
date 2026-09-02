/**
 * Database-heavy jobs are deliberately staggered by seconds. Keeping the
 * offsets together makes accidental pool stampedes visible in code review.
 */
export const DATABASE_JOB_SCHEDULES = {
  displayModeRequestExpiry: '4 * * * * *',
  terminalPaymentWatchdog: '8,38 * * * * *',
  blumonWebhookReconciliation: '11,41 * * * * *',
  tpvHealthMonitor: '14 */2 * * * *',
  posConnectionMonitor: '17 1-59/5 * * * *',
  gcalInboxSweeper: '23,53 * * * * *',
  gcalOutboxSweeper: '26,56 * * * * *',
  catalogPublicationOutboxSweeper: '29,59 * * * * *',
  commercialPublicationOutboxSweeper: '5,35 * * * * *',
  catalogPublicationWatchdog: '32 * * * * *',
  shiftCloseWatchdog: '35 * * * * *',
  inventoryPostingSweeper: '44 */2 * * * *',
  // Lealtad post-cobro durable. Cada 5 min en :41, lejos del reconciliador de
  // caja (:02), inventario (:44) y calendarios (:26/:56). Máximo 25 órdenes.
  loyaltyReconciliation: '41 */5 * * * *',
  // Fase 3 de la unificación de caja: repone ventas en efectivo sin evento en el cajón.
  // Segundo :02, cada 5 min — hueco libre antes del watchdog de pagos (:08).
  cashDrawerReconciler: '2 */5 * * * *',
  // Fase 1: avisos de aprobación de clientes. Segundo 20/50, hueco libre entre el monitor
  // de POS (:17) y el sweeper de gcal (:23) — el escalonado es lo que evita la estampida.
  customerApprovalOutbox: '20,50 * * * * *',
  // Anuncios de plataforma programados. Cada 5 min en el segundo 47 — hueco libre entre
  // el sweeper de inventario (:44) y el de gcal (:53).
  publishScheduledAnnouncements: '47 */5 * * * *',
  // Entrega de anuncios encolados. Cada 30 s en los segundos 6 y 36, huecos libres.
  announcementOutbox: '6,36 * * * * *',
} as const
