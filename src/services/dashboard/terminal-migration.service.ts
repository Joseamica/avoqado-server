import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { updateTerminal, type TerminalActor } from '@/services/dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'

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
 * re-parent the terminal to the destination venue FIRST, then queue the
 * FACTORY_RESET against that NEW venue. A factory reset auto-restores the
 * device's venue from the server on reboot, so if we wiped before re-parenting
 * the device would simply return to the OLD venue. Re-parent → wipe is forced.
 */
// 7 days — the migration wipe must wait for an offline device (e.g. a venue closed for a few days)
// instead of expiring in the default 30 min. The device's Blumon merchant creds are re-synced ONLY
// by the wipe-and-restart (verified in avoqado-tpv: heartbeat/config-poll does NOT re-sync them), so
// if the wipe expired before the device returned, the terminal would come back charging through the
// OLD venue's merchant. A long TTL lets the wipe complete whenever the device reconnects.
const MIGRATION_WIPE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function migrateExecute(
  terminalId: string,
  toVenueId: string,
  actor: TerminalActor & { staffName?: string },
): Promise<MigrateExecuteResult> {
  // Re-validate at execute time — state may have changed since preflight.
  const pre = await migratePreflight(terminalId, toVenueId)
  if (!pre.canProceed) {
    throw new BadRequestError(`Migration blocked: ${pre.blockers.map(b => b.code).join(', ')}`)
  }

  // 1) Re-parent FIRST. updateTerminal validates the target venue exists and
  //    clears assignedMerchantIds (cross-tenant safety) on venue change.
  await updateTerminal(terminalId, { venueId: toVenueId }, actor)

  // 2) Queue the wipe AGAINST THE NEW VENUE. queueCommand asserts
  //    terminal.venueId === venueId, which now holds after the re-parent.
  //    Delivery is via the device's next heartbeat (post-reparent the socket
  //    room no longer matches), which is exactly our model.
  //
  //    PARTIAL-FAILURE WINDOW: the re-parent above already committed. queueCommand
  //    is NOT transaction-aware, so we cannot atomically roll it back. If queueing
  //    fails here (e.g. the terminal got locked between preflight and queue), the
  //    terminal is left re-parented to the destination venue with NO wipe queued.
  //    Surface that recoverable state to the operator instead of a bare error so
  //    they know to re-send the factory reset from the TPV command panel.
  let queued
  try {
    queued = await tpvCommandQueueService.queueCommand({
      terminalId,
      venueId: toVenueId,
      commandType: 'FACTORY_RESET',
      priority: 'CRITICAL',
      requestedBy: actor.staffId ?? 'system',
      requestedByName: actor.staffName,
      source: 'DASHBOARD',
    })

    // Override the default 30-min FACTORY_RESET TTL with a long one so the wipe survives a
    // multi-day offline device and completes the migration whenever it reconnects (see constant above).
    await prisma.tpvCommandQueue.update({
      where: { id: queued.commandId },
      data: { expiresAt: new Date(Date.now() + MIGRATION_WIPE_TTL_MS) },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ConflictError(
      `La terminal se reasignó correctamente al venue destino, pero no se pudo encolar el borrado (factory reset): ${msg}. La terminal NO se ha borrado todavía — reenvía el factory reset desde el panel de comandos de la TPV.`,
    )
  }

  return { commandId: queued.commandId, fromVenueId: pre.fromVenueId, toVenueId, startedAt: new Date() }
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
