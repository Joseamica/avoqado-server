import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { updateTerminal, type TerminalActor } from '@/services/dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
import { logAction } from '@/services/dashboard/activity-log.service'

export interface MigrationBlocker {
  code: 'TERMINAL_RETIRED' | 'SAME_VENUE' | 'NO_PAYMENT_CONFIG' | 'NO_STAFF_PIN' | 'MIGRATION_IN_PROGRESS'
  message: string
}

export interface MigrationWarning {
  // 'OPEN_SHIFT' reserved for Phase 2 (open-shift soft check) — not emitted yet.
  code: 'UNSYNCED_DATA' | 'OPEN_SHIFT'
  message: string
}

export interface PreflightResult {
  canProceed: boolean
  fromVenueId: string
  toVenueId: string
  blockers: MigrationBlocker[]
  warnings: MigrationWarning[]
}

export async function migratePreflight(terminalId: string, toVenueId: string): Promise<PreflightResult> {
  const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } })
  if (!terminal) throw new NotFoundError('Terminal not found')

  const blockers: MigrationBlocker[] = []
  const warnings: MigrationWarning[] = []

  if (terminal.status === 'RETIRED') {
    blockers.push({ code: 'TERMINAL_RETIRED', message: 'La terminal está retirada y no puede migrarse.' })
  }
  if (terminal.venueId === toVenueId) {
    blockers.push({ code: 'SAME_VENUE', message: 'La terminal ya pertenece a ese venue.' })
  }

  const targetVenue = await prisma.venue.findUnique({ where: { id: toVenueId } })
  if (!targetVenue) throw new NotFoundError('Target venue not found')

  // Hard blocker: destination must be able to take card payments.
  // VenuePaymentConfig has no active/enabled flag (it always implies a configured
  // merchant via the required primaryAccountId), so existence by venueId is the check.
  const paymentConfig = await prisma.venuePaymentConfig.findFirst({
    where: { venueId: toVenueId },
  })
  if (!paymentConfig) {
    blockers.push({
      code: 'NO_PAYMENT_CONFIG',
      message: 'El venue destino no tiene configuración de pagos (merchant). La TPV no podría cobrar.',
    })
  }

  // Hard blocker: destination must have at least one active staff PIN, or nobody can log in.
  // This MUST mirror the real TPV login predicate in auth.tpv.service.ts (staffSignIn):
  // StaffVenue.active + non-null pin AND the related Staff must be active too. A StaffVenue
  // row whose Staff was deactivated cannot log in, so it must NOT satisfy this check.
  const staffPin = await prisma.staffVenue.findFirst({
    where: { venueId: toVenueId, pin: { not: null }, active: true, staff: { active: true } },
  })
  if (!staffPin) {
    blockers.push({
      code: 'NO_STAFF_PIN',
      message: 'El venue destino no tiene staff con PIN. Nadie podría iniciar sesión en la TPV.',
    })
  }

  // Idempotency: refuse if a FACTORY_RESET is already queued/pending for this terminal.
  // Must be expiry-aware: a FACTORY_RESET never ACKs (the device wipes + kills its process
  // before it can), so it lingers in a non-terminal status until the 30-min expiry sweep
  // marks it EXPIRED. A stale/expired-but-unswept command must NOT falsely block a new
  // migration — so we exclude commands already past their expiresAt.
  const inFlight = await prisma.tpvCommandQueue.findFirst({
    where: {
      terminalId,
      commandType: 'FACTORY_RESET',
      status: { in: ['PENDING', 'QUEUED', 'SENT', 'RECEIVED', 'EXECUTING'] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  })
  if (inFlight) {
    blockers.push({
      code: 'MIGRATION_IN_PROGRESS',
      message: 'Ya hay una migración (factory reset) en curso para esta terminal.',
    })
  }

  // Soft warning (Phase 1): unsynced device data cannot be verified server-side yet.
  warnings.push({
    code: 'UNSYNCED_DATA',
    message: 'Confirma que la TPV terminó de sincronizar sus ventas antes de continuar (Fase 2 lo verificará automáticamente).',
  })

  return {
    canProceed: blockers.length === 0,
    fromVenueId: terminal.venueId,
    toVenueId,
    blockers,
    warnings,
  }
}

export interface MigrateExecuteResult {
  commandId: string
  fromVenueId: string
  toVenueId: string
  startedAt: Date
}

/**
 * Execute a terminal venue migration. The order here is the whole safety story:
 * re-parent the terminal to the destination venue FIRST, then the FACTORY_RESET
 * is queued against that NEW venue. A factory reset auto-restores the device's
 * venue from the server on reboot, so if we wiped before re-parenting the device
 * would simply return to the OLD venue. Re-parent → wipe is forced.
 *
 * The wipe-queueing now lives INSIDE `updateTerminal` ("blindar") so EVERY
 * venue-change path wipes — not just this wizard. This function therefore
 * delegates the re-parent + wipe to `updateTerminal` and must NOT queue the
 * wipe again (that would double-wipe). It recovers the queued command id by
 * re-querying the latest FACTORY_RESET for the terminal.
 */
export async function migrateExecute(
  terminalId: string,
  toVenueId: string,
  actor: TerminalActor & { staffName?: string },
  assignedMerchantIds?: string[],
): Promise<MigrateExecuteResult> {
  // Re-validate at execute time — state may have changed since preflight.
  const pre = await migratePreflight(terminalId, toVenueId)
  if (!pre.canProceed) {
    throw new BadRequestError(`Migration blocked: ${pre.blockers.map(b => b.code).join(', ')}`)
  }

  // 1) Re-parent + auto-queue the wipe in ONE call. updateTerminal validates the
  //    target venue exists, clears assignedMerchantIds (cross-tenant safety),
  //    and — because the venue changed — queues the 7-day-TTL FACTORY_RESET with
  //    the migration payload ({ fromVenueId, previousMerchantIds, toVenueId }).
  //    We do NOT queue the wipe here ourselves: that would double-wipe.
  await updateTerminal(terminalId, { venueId: toVenueId }, actor)

  // 2) Set the destination merchant(s) AFTER the re-parent. This is a SECOND
  //    updateTerminal call with the venue unchanged, so it does NOT re-queue a
  //    wipe — it only validates brand/merchant compatibility via the existing
  //    logic and writes assignedMerchantIds. Setting them before the device's
  //    post-wipe config fetch means the freshly-wiped TPV pulls the correct
  //    merchant on first reconnect.
  //
  //    If the operator did NOT pick specific merchants (the wizard's "Comercio por
  //    defecto de la sucursal (recomendado)" option sends none), fall back to the
  //    destination venue's configured default merchant (VenuePaymentConfig
  //    .primaryAccountId — the same merchant migratePreflight's NO_PAYMENT_CONFIG
  //    blocker guarantees exists). WITHOUT this fallback the move clears the old
  //    merchant and assigns nothing, leaving the terminal with an empty
  //    assignedMerchantIds — online but unable to process payments ("migró pero no
  //    cobra"). The "recommended default" must therefore resolve to a real merchant.
  let merchantsToAssign = assignedMerchantIds
  if (!merchantsToAssign || merchantsToAssign.length === 0) {
    const paymentConfig = await prisma.venuePaymentConfig.findFirst({
      where: { venueId: toVenueId },
      select: { primaryAccountId: true },
    })
    if (paymentConfig?.primaryAccountId) {
      merchantsToAssign = [paymentConfig.primaryAccountId]
    }
  }
  if (merchantsToAssign && merchantsToAssign.length > 0) {
    await updateTerminal(terminalId, { assignedMerchantIds: merchantsToAssign }, actor)
  }

  // 3) Recover the queued wipe's commandId. updateTerminal does not return it
  //    (its return shape is the terminal, which callers depend on), so we
  //    re-query the latest FACTORY_RESET for this terminal.
  //
  //    PARTIAL-FAILURE WINDOW: the re-parent already committed. If the wipe
  //    failed to queue inside updateTerminal (it logs a warning instead of
  //    throwing, since the re-parent stands), there is no command to recover.
  //    Surface that recoverable state to the operator so they re-send the
  //    factory reset from the TPV command panel — preserving the prior
  //    recoverable-state semantics.
  const cmd = await prisma.tpvCommandQueue.findFirst({
    where: { terminalId, commandType: 'FACTORY_RESET' },
    orderBy: { createdAt: 'desc' },
  })
  if (!cmd) {
    throw new ConflictError(
      'La terminal se reasignó correctamente al venue destino, pero no se pudo encolar el borrado (factory reset). La terminal NO se ha borrado todavía — reenvía el factory reset desde el panel de comandos de la TPV.',
    )
  }

  return { commandId: cmd.id, fromVenueId: pre.fromVenueId, toVenueId, startedAt: new Date() }
}

/**
 * Cancel an in-flight terminal migration — undo the move while the device has
 * NOT wiped yet.
 *
 * Safety hinge: only a FACTORY_RESET still in PENDING/QUEUED (and not expired)
 * is cancellable. Those statuses mean the device has not received the wipe
 * (offline / hasn't polled). Once the command reaches SENT/RECEIVED/EXECUTING/
 * COMPLETED the device may already have wiped, so the migration is no longer
 * reversible from here.
 *
 * Reverts the terminal directly via Prisma (NOT updateTerminal) so the "blindar"
 * auto-wipe does NOT re-queue a FACTORY_RESET on the revert.
 */
export interface MigrateCancelResult {
  cancelled: boolean
  restoredVenueId: string
}

export async function migrateCancel(terminalId: string, actor: TerminalActor): Promise<MigrateCancelResult> {
  // 1) Find the cancellable in-flight wipe. PENDING/QUEUED + not-expired only —
  //    SENT and beyond means the device may already have wiped.
  const command = await prisma.tpvCommandQueue.findFirst({
    where: {
      terminalId,
      commandType: 'FACTORY_RESET',
      status: { in: ['PENDING', 'QUEUED'] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: 'desc' },
  })

  if (!command) {
    throw new BadRequestError(
      'No hay una migración cancelable para esta terminal (la TPV ya recibió el borrado o no hay migración en curso).',
    )
  }

  // 2) Read the revert target from the command payload. Older commands queued
  //    before the blindar payload existed can't be auto-reverted.
  const migration = (command.payload as { migration?: { fromVenueId?: string; previousMerchantIds?: string[] } } | null)?.migration
  if (!migration || !migration.fromVenueId) {
    throw new BadRequestError(
      'Esta migración no se puede revertir automáticamente: el comando de borrado no tiene la información del venue de origen.',
    )
  }
  const { fromVenueId, previousMerchantIds } = migration

  // 3) Cancel the queued wipe so it never reaches the device.
  await tpvCommandQueueService.cancelCommand(command.id, actor.staffId ?? 'system', 'Migración cancelada por el operador')

  // 4) Revert the terminal directly (BYPASS updateTerminal so blindar does NOT
  //    re-queue a wipe on the revert). Restore both the origin venue and the
  //    merchant assignments captured at migration time.
  await prisma.terminal.update({
    where: { id: terminalId },
    data: { venueId: fromVenueId, assignedMerchantIds: previousMerchantIds ?? [] },
  })

  // 5) Best-effort audit trail (never throws).
  await logAction({
    staffId: actor.staffId ?? null,
    venueId: fromVenueId,
    action: 'TERMINAL_MIGRATION_CANCELLED',
    entity: 'Terminal',
    entityId: terminalId,
    data: { commandId: command.id, restoredVenueId: fromVenueId, restoredMerchantIds: previousMerchantIds ?? [] },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  })

  logger.info(`Migration cancelled for terminal ${terminalId} — reverted to venue ${fromVenueId}`, {
    commandId: command.id,
  })

  return { cancelled: true, restoredVenueId: fromVenueId }
}

const ONLINE_THRESHOLD_MS = 2 * 60 * 1000 // mirror tpv-health/command-execution online cutoff

export interface MigrateStatusResult {
  commandStatus: string
  commandDelivered: boolean
  reboundAfterWipe: boolean
  currentlyOnline: boolean
  onlineUnderNewVenue: boolean
  confirmed: boolean
  elapsedMs: number
}

export async function migrateStatus(terminalId: string, commandId: string): Promise<MigrateStatusResult> {
  const command = await prisma.tpvCommandQueue.findUnique({ where: { id: commandId } })
  // Guard the commandType too: a non-migration command id (e.g. LOCK/RESTART) must not be
  // usable as a migration status target — only FACTORY_RESET commands drive a migration.
  if (!command || command.terminalId !== terminalId || command.commandType !== 'FACTORY_RESET')
    throw new NotFoundError('Migration command not found for terminal')

  const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } })
  if (!terminal) throw new NotFoundError('Terminal not found')

  const t0 = command.createdAt
  const now = Date.now()

  const commandDelivered = ['SENT', 'RECEIVED', 'EXECUTING', 'COMPLETED'].includes(command.status)
  const reboundAfterWipe = !!terminal.lastActivationStatusCheckAt && terminal.lastActivationStatusCheckAt > t0
  const currentlyOnline = !!terminal.lastHeartbeat && now - terminal.lastHeartbeat.getTime() < ONLINE_THRESHOLD_MS
  const onlineUnderNewVenue = currentlyOnline && terminal.venueId === command.venueId
  const confirmed = reboundAfterWipe && onlineUnderNewVenue

  return {
    commandStatus: command.status,
    commandDelivered,
    reboundAfterWipe,
    currentlyOnline,
    onlineUnderNewVenue,
    confirmed,
    elapsedMs: now - t0.getTime(),
  }
}
