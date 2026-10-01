import { Prisma, PaymentProcessor } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { assertMerchantsTerminalCompatible } from '@/lib/providerDeviceCompatibility'
import { assertDeviceActionSupported } from '@/services/device-capabilities.service'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/errors/AppError'
import {
  deviceReboundAfter,
  migrationCommandWhere,
  updateTerminal,
  type TerminalActor,
} from '@/services/dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
import type { TerminalWriteScope } from '@/services/shared/terminalScopedWrites'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * Snapshot del pago del venue ORIGEN, usado sólo por el flujo "migrar el merchant
 * con la terminal". Replica la herencia venue → org de getEffectivePaymentConfig
 * pero sin sus includes pesados: aquí sólo hacen falta ids.
 */
export interface OriginPaymentSnapshot {
  /** Merchants que la terminal debe conservar tras el re-parent. */
  merchantIds: string[]
  /** Config a copiar al destino, o null si no hay nada que copiar. */
  copyable: {
    primaryAccountId: string
    secondaryAccountId: string | null
    tertiaryAccountId: string | null
    preferredProcessor: PaymentProcessor
    routingRules: Prisma.JsonValue | null
  } | null
}

const PAYMENT_CONFIG_SELECT = {
  primaryAccountId: true,
  secondaryAccountId: true,
  tertiaryAccountId: true,
  preferredProcessor: true,
  routingRules: true,
} as const

export async function resolveOriginPayment(
  terminal: { venueId: string; assignedMerchantIds: string[] },
  originOrgId: string | null,
): Promise<OriginPaymentSnapshot> {
  // 1) Config propia del venue origen; si no, la heredada de su org.
  let cfg = await prisma.venuePaymentConfig.findUnique({
    where: { venueId: terminal.venueId },
    select: PAYMENT_CONFIG_SELECT,
  })
  if (!cfg && originOrgId) {
    cfg = await prisma.organizationPaymentConfig.findUnique({
      where: { organizationId: originOrgId },
      select: PAYMENT_CONFIG_SELECT,
    })
  }

  // 2) Los merchants ya asignados a la terminal ganan: son lo que la TPV usa hoy
  //    (el heartbeat resuelve assignedMerchantIds ANTES que la config del venue).
  const fromCfg = cfg ? [cfg.primaryAccountId, cfg.secondaryAccountId, cfg.tertiaryAccountId].filter((x): x is string => !!x) : []
  const merchantIds = terminal.assignedMerchantIds.length ? terminal.assignedMerchantIds : fromCfg

  // 3) Qué copiar al destino.
  //    - SIN override: copiar `cfg` VERBATIM. Preserva huecos (secondary null +
  //      tertiary no-null) y deja `routingRules` válidas: nombran slots por
  //      nombre ({"factura":"secondary"}), así que sólo significan algo contra
  //      la asignación de slots para la que se escribieron.
  //    - CON override: la terminal define la identidad (decisión del founder:
  //      18 de 78 terminales cobran con un merchant != al default de su venue).
  //      `assignedMerchantIds` es un CONJUNTO sin orden (se llena con `push`; el
  //      TPV lo lee sin orderBy), así que la jerarquía que derivamos de él es
  //      arbitraria — por eso `routingRules` se anula: sus referencias a slots
  //      no sobreviven a una jerarquía redefinida. El orden que SÍ asignamos
  //      (merchantIds[0] → primary) no es cosmético: el slot `primary` está
  //      privilegiado por consumidores que nunca leen `routingRules`
  //      (transactionCost.service.ts:265 atribuye costos vía `primaryAccount`;
  //      onboarding.controller.ts:398 trata `primaryAccountId` como EL merchant).
  //      Se sostiene así: sin reglas no hay política previa que contradecir;
  //      `merchantIds[0]` es la identidad que decidió el founder; y para una
  //      terminal que sobrescribe a su venue, la jerarquía del venue no es un
  //      ranking autoritativo — no existe mejor llave. Además, 66 de 78
  //      terminales traen un solo merchant, así que no hay orden que equivocar.
  //    `preferredProcessor` viene de `cfg` en ambos casos: no nombra ningún slot.
  const hasOverride = terminal.assignedMerchantIds.length > 0
  const copyable = !merchantIds[0]
    ? null
    : hasOverride
      ? {
          primaryAccountId: merchantIds[0],
          secondaryAccountId: merchantIds[1] ?? null,
          tertiaryAccountId: merchantIds[2] ?? null,
          preferredProcessor: cfg?.preferredProcessor ?? ('AUTO' as PaymentProcessor),
          routingRules: null,
        }
      : cfg

  return { merchantIds, copyable }
}

export interface MigrationBlocker {
  code:
    | 'TERMINAL_RETIRED'
    | 'SAME_VENUE'
    | 'NO_PAYMENT_CONFIG'
    | 'INVALID_MERCHANT'
    | 'UNSUPPORTED_DEVICE'
    | 'NO_STAFF_PIN'
    | 'MIGRATION_IN_PROGRESS'
    | 'CROSS_ORG_MERCHANT'
    | 'ORIGIN_HAS_NO_MERCHANT'
    | 'DESTINATION_ALREADY_CONFIGURED_MERCHANT'
  message: string
}

export interface MigrationWarning {
  // 'OPEN_SHIFT' reserved for Phase 2 (open-shift soft check) — not emitted yet.
  code: 'UNSYNCED_DATA' | 'OPEN_SHIFT'
  message: string
}

export interface MerchantMigrationInfo {
  available: boolean
  reason?: 'CROSS_ORG' | 'ORIGIN_HAS_NO_MERCHANT' | 'DESTINATION_ALREADY_CONFIGURED'
  merchants: { id: string; displayName: string | null }[]
}

/**
 * The FACTORY_RESET that is blocking a migration, described so the wizard can say WHEN it
 * was queued, WHERE it came from, and offer the way out instead of a dead end
 * (founder decision 2026-09-01, Asana 1218069201250971):
 *
 * - `cancellable` — the device has NOT received it yet (PENDING/QUEUED): the operator can
 *   cancel it (`migrateCancel`) and go on.
 * - `discardable` — the device received it but has been silent for `DISCARD_AFTER_MS`
 *   since it was queued: the operator can discard it (`migrateDiscard`). Before that the
 *   only honest answer is "power the terminal on and wait", and `discardableAt` says
 *   exactly until when.
 */
export interface PendingWipeInfo {
  commandId: string
  queuedAt: Date
  status: string
  origin: 'MIGRATION' | 'MANUAL'
  /** Destination venue of the migration that queued the wipe; null for a manual wipe. */
  toVenueId: string | null
  cancellable: boolean
  discardable: boolean
  discardableAt: Date
}

export interface PreflightResult {
  canProceed: boolean
  fromVenueId: string
  toVenueId: string
  blockers: MigrationBlocker[]
  warnings: MigrationWarning[]
  merchantMigration: MerchantMigrationInfo
  /** Present (non-null) exactly when `MIGRATION_IN_PROGRESS` is among the blockers. */
  pendingWipe: PendingWipeInfo | null
}

/**
 * How long a delivered-but-unexecuted wipe must stay silent before an operator may discard
 * it. Founder decision (2026-09-01): 24 h, for the org OWNER too. A device that has ignored
 * its wipe for a day is not going to execute it on its own; leaving the command alive only
 * blocks every future migration of that terminal (7-day TTL) — or blocks it forever, which
 * is how the hand-inserted rows with no expiresAt kept 3 terminals stuck for 5 months.
 */
export const DISCARD_AFTER_MS = 24 * 60 * 60 * 1000

const IN_FLIGHT_STATUSES = ['PENDING', 'QUEUED', 'SENT', 'RECEIVED', 'EXECUTING'] as const
/** The device has not received the command: it can still be cancelled server-side. */
const CANCELLABLE_STATUSES: readonly string[] = ['PENDING', 'QUEUED']
function canCancelWipe(command: { status: string; payload: unknown }): boolean {
  return (
    CANCELLABLE_STATUSES.includes(command.status) ||
    ((command.payload as { _deliveryProtocol?: number } | null)?._deliveryProtocol === 2 && ['SENT', 'RECEIVED'].includes(command.status))
  )
}

interface PendingWipeRow {
  id: string
  createdAt: Date
  status: string
  payload: unknown
  venueId: string
}

/** Unexpired pending wipes and completed receipts still awaiting an authenticated new boot. */
async function findPendingWipes(terminalId: string, commandSessionId: string | null | undefined): Promise<PendingWipeRow[]> {
  const inFlight = await prisma.tpvCommandQueue.findMany({
    where: {
      terminalId,
      ...migrationCommandWhere(),
    },
    select: { id: true, createdAt: true, status: true, payload: true, venueId: true },
    take: 101,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (inFlight.length > 100) throw new ConflictError('Hay más de 100 borrados pendientes. Requieren revisión antes de migrar.')
  return inFlight.filter(c => !deviceReboundAfter(c, commandSessionId))
}

function newestOf(pending: PendingWipeRow[]): PendingWipeRow {
  return pending.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
}

function describePendingWipe(pending: PendingWipeRow[], now = Date.now()): PendingWipeInfo | null {
  if (pending.length === 0) return null
  const newest = newestOf(pending)
  const migration = (newest.payload as { migration?: { toVenueId?: unknown } } | null)?.migration
  // `cancellable` describes the SAME row as commandId/status/origin — the newest. Looking at
  // "any pending wipe" made the three disagree: a newest SENT with an older QUEUED behind it
  // reported `status: SENT, cancellable: true`, and cancelling then dropped the OLD one,
  // leaving the blocker in place and the operator with no idea why (Codex P2, 2026-09-01).
  const cancellable = canCancelWipe(newest)
  const discardableAt = new Date(newest.createdAt.getTime() + DISCARD_AFTER_MS)
  return {
    commandId: newest.id,
    queuedAt: newest.createdAt,
    status: newest.status,
    origin: migration ? 'MIGRATION' : 'MANUAL',
    toVenueId: typeof migration?.toVenueId === 'string' ? migration.toVenueId : null,
    cancellable,
    discardable:
      (newest.payload as { _deliveryProtocol?: number } | null)?._deliveryProtocol !== 2 && !cancellable && discardableAt.getTime() <= now,
    discardableAt,
  }
}

/**
 * Human date+time for messages an older client renders verbatim. Carries the HOUR because
 * "you can discard it from…" is an exact 24 h boundary, and the VENUE's timezone because a
 * hardcoded Mexico City reads an hour off for a Tijuana venue (Codex P3, 2026-09-01).
 */
function fechaCorta(d: Date, timezone = 'America/Mexico_City'): string {
  return d.toLocaleString('es-MX', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** The migration payload of a pending wipe, when it was queued BY a migration. */
interface WipeMigrationPayload {
  fromVenueId?: string
  previousMerchantIds?: string[]
  createdVenuePaymentConfigId?: string
}
function migrationPayloadOf(row: PendingWipeRow): WipeMigrationPayload | null {
  const m = (row.payload as { migration?: WipeMigrationPayload } | null)?.migration
  return m && typeof m.fromVenueId === 'string' ? m : null
}

export async function migratePreflight(
  terminalId: string,
  toVenueId: string,
  migrateMerchant = false,
  assignedMerchantIds?: string[],
): Promise<PreflightResult> {
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

  // Config de pagos del destino. Con `migrateMerchant` la TPV trae su propio
  // merchant, así que la ausencia de config deja de ser bloqueante.
  const paymentConfig =
    (await prisma.venuePaymentConfig.findFirst({ where: { venueId: toVenueId } })) ??
    (await prisma.organizationPaymentConfig.findUnique({ where: { organizationId: targetVenue.organizationId } }))

  // Snapshot del origen: qué merchant viajaría y si es legal que viaje.
  const originVenue = await prisma.venue.findUnique({ where: { id: terminal.venueId } })
  const sameOrg = !!originVenue && originVenue.organizationId === targetVenue.organizationId
  const origin = await resolveOriginPayment(
    { venueId: terminal.venueId, assignedMerchantIds: terminal.assignedMerchantIds ?? [] },
    originVenue?.organizationId ?? null,
  )

  // I5 (bug fix): `origin.merchantIds` are ids referenced by config/assignment, NOT
  // necessarily still chargeable — `MerchantAccount.active` is a real enable/disable flag
  // (fraud/compliance), and a deactivated account's id can still linger in a
  // VenuePaymentConfig or a terminal's assignedMerchantIds. Filter to `active: true` HERE,
  // before deciding ORIGIN_HAS_NO_MERCHANT, so a merchant closed for fraud/compliance can't
  // silently pass as "the origin has something to carry" — same shape as the precedent in
  // merchantRouting.service.ts:107-108. Kept local to migratePreflight (not pushed into
  // resolveOriginPayment) — that helper is deliberately lightweight/ids-only (see its
  // docstring) and this is a genuinely new DB round-trip, not something it already owns.
  const activeOriginMerchants = origin.merchantIds.length
    ? await prisma.merchantAccount.findMany({
        where: { id: { in: origin.merchantIds }, active: true },
        select: { id: true, displayName: true },
      })
    : []

  let merchantMigration: MerchantMigrationInfo
  if (!sameOrg) {
    // I2: cross-org = ventas del venue B liquidando en la cuenta bancaria de la org A.
    merchantMigration = { available: false, reason: 'CROSS_ORG', merchants: [] }
  } else if (activeOriginMerchants.length === 0) {
    merchantMigration = { available: false, reason: 'ORIGIN_HAS_NO_MERCHANT', merchants: [] }
  } else if (paymentConfig) {
    // I1: el destino ya cobra con lo suyo; imponerle el merchant del origen
    // repuntaría su dinero. No se ofrece.
    merchantMigration = { available: false, reason: 'DESTINATION_ALREADY_CONFIGURED', merchants: [] }
  } else {
    merchantMigration = { available: true, merchants: activeOriginMerchants }
  }

  if (!paymentConfig && !migrateMerchant) {
    blockers.push({
      code: 'NO_PAYMENT_CONFIG',
      message: 'El venue destino no tiene configuración de pagos (merchant). La TPV no podría cobrar.',
    })
  }
  // Finding 2 (final whole-branch review, defense-in-depth): the wizard already hides the
  // checkbox when the destination has its own config (merchantMigration.reason ===
  // 'DESTINATION_ALREADY_CONFIGURED', computed above) — but per critical-warnings.md the
  // backend must enforce this itself, never trust the client to hide a control. Without this
  // hard blocker, a caller bypassing the UI could send migrateMerchant: true here and
  // migrateExecute's Step 2 auto-carry would silently override the destination venue's OWN
  // configured default merchant with the origin's — corrupting a venue that already charges
  // correctly. Only fires when migrateMerchant is explicitly requested; a destination with its
  // own config and migrateMerchant unset/false is unaffected (today's behavior, unchanged).
  if (migrateMerchant && paymentConfig) {
    blockers.push({
      code: 'DESTINATION_ALREADY_CONFIGURED_MERCHANT',
      message: 'El venue destino ya tiene su propio comercio configurado. No se puede forzar el comercio del origen.',
    })
  }
  // I3: el guard vive en el backend, no en la visibilidad del checkbox.
  if (migrateMerchant && !sameOrg) {
    blockers.push({
      code: 'CROSS_ORG_MERCHANT',
      message:
        'No se puede migrar el comercio a otra organización: las ventas del venue destino se depositarían en la cuenta bancaria de la organización de origen.',
    })
  }
  // I4: nunca dejar "migró pero no cobra".
  if (migrateMerchant && activeOriginMerchants.length === 0) {
    blockers.push({
      code: 'ORIGIN_HAS_NO_MERCHANT',
      message: 'La terminal de origen no tiene un comercio (merchant) que migrar.',
    })
  }

  try {
    assertDeviceActionSupported(terminal, { kind: 'REMOTE_COMMAND', commandType: 'FACTORY_RESET' })
  } catch {
    blockers.push({ code: 'UNSUPPORTED_DEVICE', message: 'Este dispositivo no admite la migración remota de TPV.' })
  }
  const merchants = assignedMerchantIds?.length
    ? assignedMerchantIds
    : migrateMerchant
      ? origin.merchantIds
      : paymentConfig?.primaryAccountId
        ? [paymentConfig.primaryAccountId]
        : []
  if (merchants.length) {
    const active = await prisma.merchantAccount.findMany({
      where: { id: { in: merchants }, active: true },
      select: { id: true },
      take: merchants.length,
    })
    if (new Set(merchants).size !== merchants.length || active.length !== merchants.length) {
      blockers.push({ code: 'INVALID_MERCHANT', message: 'Uno de los comercios seleccionados no existe o está desactivado.' })
    } else {
      try {
        await assertMerchantsTerminalCompatible(terminalId, merchants)
      } catch {
        blockers.push({ code: 'INVALID_MERCHANT', message: 'El comercio seleccionado no es compatible con esta terminal.' })
      }
    }
  } else if (!blockers.some(b => b.code === 'NO_PAYMENT_CONFIG' || b.code === 'ORIGIN_HAS_NO_MERCHANT')) {
    blockers.push({
      code: 'NO_PAYMENT_CONFIG',
      message: 'El destino no tiene un comercio de cobro disponible. Configúralo antes de migrar.',
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

  // Idempotency: refuse while a FACTORY_RESET is still pending for this terminal (see
  // `findPendingWipes` for what "pending" means and why). The blocker is never a dead end:
  // `pendingWipe` tells the wizard when it was queued, where it came from, and which way
  // out applies (cancel / wait / discard).
  const pendingWipe = describePendingWipe(await findPendingWipes(terminalId, terminal.commandSessionId))
  if (pendingWipe) {
    blockers.push({
      code: 'MIGRATION_IN_PROGRESS',
      message: `Hay un borrado de fábrica pendiente desde el ${fechaCorta(pendingWipe.queuedAt, originVenue?.timezone)} que la terminal aún no ejecuta.`,
    })
  }

  // Soft warning (Phase 1): unsynced device data cannot be verified server-side yet.
  warnings.push({
    code: 'UNSYNCED_DATA',
    message: 'Confirma en la TPV que no hay cobros, reembolsos ni ventas pendientes de sincronizar antes de migrar.',
  })

  return {
    canProceed: blockers.length === 0,
    fromVenueId: terminal.venueId,
    toVenueId,
    blockers,
    warnings,
    merchantMigration,
    pendingWipe,
  }
}

export interface MigrateExecuteResult {
  commandId: string
  fromVenueId: string
  toVenueId: string
  startedAt: Date
}

/** Validates the complete destination, then commits the move and wipe together. */
export async function migrateExecute(
  terminalId: string,
  toVenueId: string,
  actor: TerminalActor & { staffName?: string },
  assignedMerchantIds?: string[],
  migrateMerchant = false,
  /**
   * El dashboard de la organización pasa `{ organizationId }`: el traslado y la asignación de comercios se escriben
   * acotados a esa organización, así que una terminal que pasó a otra en medio no se jala de regreso (auditoría de
   * Codex del spec «pantalla del cliente», 4ª ronda, 2026-09-17). El superadmin no lo pasa.
   */
  scope?: TerminalWriteScope,
): Promise<MigrateExecuteResult> {
  const pre = await migratePreflight(terminalId, toVenueId, migrateMerchant, assignedMerchantIds)
  if (!pre.canProceed) throw new BadRequestError(pre.blockers.map(b => b.message).join(' '))

  const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } })
  if (!terminal || terminal.venueId !== pre.fromVenueId) throw new ConflictError('La terminal cambió. Actualiza y vuelve a validar.')
  const originVenue = await prisma.venue.findUnique({ where: { id: pre.fromVenueId } })
  const targetVenue = await prisma.venue.findUnique({ where: { id: toVenueId } })
  if (!targetVenue) throw new NotFoundError('Venue destino no encontrado')
  const origin = migrateMerchant ? await resolveOriginPayment(terminal, originVenue?.organizationId ?? null) : null
  const destination = await resolveOriginPayment({ venueId: toVenueId, assignedMerchantIds: [] }, targetVenue.organizationId)
  const merchants = assignedMerchantIds?.length
    ? assignedMerchantIds
    : origin
      ? origin.merchantIds
      : destination.copyable
        ? [destination.copyable.primaryAccountId]
        : []
  if (!merchants.length) throw new BadRequestError('Configura un comercio de cobro antes de migrar.')

  // Resolve and validate everything before entering the shared atomic move.
  await assertMerchantsTerminalCompatible(terminalId, merchants)
  const copyable = origin?.copyable
  const paymentConfig = copyable
    ? {
        ...copyable,
        ...(assignedMerchantIds?.length && {
          primaryAccountId: assignedMerchantIds[0],
          secondaryAccountId: assignedMerchantIds[1] ?? null,
          tertiaryAccountId: assignedMerchantIds[2] ?? null,
          routingRules: null,
        }),
        routingRules: assignedMerchantIds?.length ? Prisma.JsonNull : (copyable.routingRules ?? Prisma.JsonNull),
      }
    : undefined
  if (migrateMerchant && (!paymentConfig || destination.copyable)) {
    throw new ConflictError('La configuración de pagos cambió. Actualiza y vuelve a validar la migración.')
  }
  const moved = await updateTerminal(terminalId, { venueId: toVenueId, assignedMerchantIds: merchants }, actor, scope, {
    expectedVenueId: pre.fromVenueId,
    paymentConfig,
  })
  if (!('migrationCommandId' in moved) || typeof moved.migrationCommandId !== 'string' || !moved.migrationCommandId) {
    throw new ConflictError('No se confirmó la migración. Actualiza el estado de la terminal.')
  }
  return { commandId: moved.migrationCommandId, fromVenueId: pre.fromVenueId, toVenueId, startedAt: new Date() }
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

export async function migrateCancel(terminalId: string, actor: TerminalActor, scopedOrgId?: string): Promise<MigrateCancelResult> {
  const { command, migration, restoredVenueId } = await prisma.$transaction(async tx => {
    const command = await tx.tpvCommandQueue.findFirst({
      where: {
        terminalId,
        commandType: 'FACTORY_RESET',
        OR: [
          { status: { in: ['PENDING', 'QUEUED'] } },
          { status: { in: ['SENT', 'RECEIVED'] }, payload: { path: ['_deliveryProtocol'], equals: 2 } },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    if (!command)
      throw new BadRequestError(
        'No hay una migración cancelable para esta terminal (la TPV ya recibió el borrado o no hay migración en curso).',
      )
    const migration = (
      command.payload as {
        migration?: { fromVenueId?: string; previousMerchantIds?: string[]; createdVenuePaymentConfigId?: string }
      } | null
    )?.migration
    if (scopedOrgId && migration?.fromVenueId) {
      const origin = await tx.venue.findFirst({ where: { id: migration.fromVenueId, organizationId: scopedOrgId }, select: { id: true } })
      if (!origin) throw new ForbiddenError('No puedes cancelar una migración cuyo origen pertenece a otra organización.')
    }
    // The compare-and-set in cancelCommand locks the queue row before restoring the venue.
    // Delivery either wins first (and cancellation fails) or sees CANCELLED after commit.
    await tpvCommandQueueService.cancelCommand(
      command.id,
      actor.staffId ?? 'system',
      migration?.fromVenueId ? 'Migración cancelada por el operador' : 'Borrado pendiente cancelado por el operador',
      tx,
    )
    if (migration?.fromVenueId) {
      // Bypass updateTerminal: restoring must not enqueue another wipe.
      await tx.terminal.update({
        where: { id: terminalId },
        data: {
          venueId: migration.fromVenueId,
          assignedMerchantIds: migration.previousMerchantIds ?? [],
        },
      })
      if (migration.createdVenuePaymentConfigId) {
        await tx.venuePaymentConfig.deleteMany({ where: { id: migration.createdVenuePaymentConfigId } })
      }
      return { command, migration, restoredVenueId: migration.fromVenueId }
    }
    const terminal = await tx.terminal.findUnique({ where: { id: terminalId }, select: { venueId: true } })
    if (!terminal) throw new NotFoundError('Terminal not found')
    return { command, migration, restoredVenueId: terminal.venueId }
  })
  if (migration?.createdVenuePaymentConfigId) {
    await logAction({
      staffId: actor.staffId ?? null,
      venueId: restoredVenueId,
      action: 'VENUE_PAYMENT_CONFIG_DELETED',
      entity: 'VenuePaymentConfig',
      entityId: migration.createdVenuePaymentConfigId,
      data: { reason: 'Migración de terminal cancelada', commandId: command.id, terminalId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    })
  }
  await logAction({
    staffId: actor.staffId ?? null,
    venueId: restoredVenueId,
    action: migration?.fromVenueId ? 'TERMINAL_MIGRATION_CANCELLED' : 'TERMINAL_PENDING_WIPE_CANCELLED',
    entity: 'Terminal',
    entityId: terminalId,
    data: { commandId: command.id, restoredVenueId, restoredMerchantIds: migration?.previousMerchantIds ?? [] },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  })
  logger.info(`Pending wipe cancelled for terminal ${terminalId}`, { commandId: command.id, restoredVenueId })
  return { cancelled: true, restoredVenueId }
}

export interface MigrateDiscardResult {
  discarded: number
  commandIds: string[]
  /** Venue the terminal is left at: its origin when a migration wipe was undone, else unchanged. */
  restoredVenueId: string
}

/**
 * Discard a pending FACTORY_RESET the device has received but never executed — the way out
 * of a MIGRATION_IN_PROGRESS that cannot be cancelled (founder decision 2026-09-01, Asana
 * 1218069201250971; the org OWNER may do this too).
 *
 * Refuses, in this order:
 *  - nothing pending (the device already rebound after every wipe, or there was none);
 *  - a wipe still PENDING/QUEUED — the device hasn't received it, so `migrateCancel` is the
 *    safer path and the UI must offer it first;
 *  - the newest wipe is younger than `DISCARD_AFTER_MS` — the device may still be about to
 *    execute it; the message says from when discarding will be allowed.
 *
 * 🔴 A wipe queued BY A MIGRATION is UNDONE, not merely dropped: the terminal goes back to
 * its origin venue with its origin merchants, and the `VenuePaymentConfig` that migration
 * created at the destination is deleted — exactly what `migrateCancel` does. A FACTORY_RESET
 * is the ONLY thing that re-points the merchant credentials the device holds in memory (see
 * `terminals.superadmin.service.ts`), so leaving the terminal re-parented at the destination
 * WITHOUT its wipe is the split-brain the migration exists to prevent — the device would
 * charge through the origin's merchant while the server books the sale under the destination.
 * The 7-day TTL leaves that same hole today; discarding must not open it 6 days earlier
 * (Codex P1, 2026-09-01). Undoing is safe precisely because the device provably never
 * rebound, i.e. never executed the wipe. It also avoids a `SAME_VENUE` trap: the operator is
 * about to re-run the very migration this wipe belonged to.
 */
export async function migrateDiscard(terminalId: string, actor: TerminalActor, scopedOrgId?: string): Promise<MigrateDiscardResult> {
  const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } })
  if (!terminal) throw new NotFoundError('Terminal not found')

  const pending = await findPendingWipes(terminalId, terminal.commandSessionId)
  if (pending.length === 0) {
    throw new BadRequestError('No hay un borrado pendiente que descartar: la terminal ya lo ejecutó o nunca hubo uno.')
  }
  const newest = newestOf(pending)
  if (canCancelWipe(newest)) {
    throw new BadRequestError('Ese borrado todavía no llega a la terminal: cancélalo en vez de descartarlo.')
  }
  const discardableAt = new Date(newest.createdAt.getTime() + DISCARD_AFTER_MS)
  if (discardableAt.getTime() > Date.now()) {
    const venue = await prisma.venue.findUnique({ where: { id: terminal.venueId }, select: { timezone: true } })
    throw new BadRequestError(
      `El borrado se envió hace menos de 24 horas. Prende la terminal con internet y espera a que se reinicie; ` +
        `si sigue sin aparecer, podrás descartarlo a partir del ${fechaCorta(discardableAt, venue?.timezone)}.`,
    )
  }

  // Revert target: the OLDEST pending migration wipe — the venue the terminal sat at before
  // this pile of unexecuted moves. (Normally there is at most one: preflight blocks a second
  // migration while one is pending.)
  const revert = pending
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map(migrationPayloadOf)
    .find(Boolean)

  const now = new Date()
  const { discardedIds } = await prisma.$transaction(async tx => {
    // Serialize against authenticated app-boot registration. A plain re-read still leaves a race
    // between the read and the writes; this row lock keeps the proof stable until commit.
    const [fresh] = await tx.$queryRaw<Array<{ commandSessionId: string | null }>>`
      SELECT "commandSessionId"
      FROM "Terminal"
      WHERE "id" = ${terminalId}
      FOR UPDATE
    `
    if (!fresh) throw new NotFoundError('Terminal not found')
    if (deviceReboundAfter(newest, fresh.commandSessionId)) {
      throw new ConflictError('La terminal confirmó el borrado. Vuelve a verificar el destino.')
    }

    if (scopedOrgId && revert?.fromVenueId) {
      const origin = await tx.venue.findFirst({
        where: { id: revert.fromVenueId, organizationId: scopedOrgId },
        select: { id: true },
      })
      if (!origin) {
        throw new ForbiddenError('No puedes descartar una migración cuyo origen pertenece a otra organización.')
      }
    }

    // One update per id so the audit trail names the rows that ACTUALLY moved: `updateMany`
    // reports a count, not which rows, and the sweep or the device may have moved one of
    // them to a terminal status in the meantime (Codex P3).
    if ((newest.payload as { _deliveryProtocol?: number } | null)?._deliveryProtocol === 2 && newest.status === 'EXECUTING') {
      throw new ConflictError('La TPV ya autorizó la ejecución. Verifica el resultado antes de descartar la migración.')
    }
    const discardedIds: string[] = []
    for (const row of pending) {
      const id = row.id
      const protocol2 = (row.payload as { _deliveryProtocol?: number } | null)?._deliveryProtocol === 2
      const r = await tx.tpvCommandQueue.updateMany({
        where: { id, status: { in: protocol2 ? ['SENT', 'RECEIVED'] : [...IN_FLIGHT_STATUSES] } },
        data: { status: 'EXPIRED', expiresAt: now },
      })
      if (r.count !== 1) {
        throw new ConflictError('El estado del borrado cambió mientras se descartaba. Actualiza la terminal e inténtalo de nuevo.')
      }
      discardedIds.push(id)
    }

    if (revert?.fromVenueId) {
      // Direct write, NOT updateTerminal: the "blindar" auto-wipe would queue a fresh
      // FACTORY_RESET on the revert and re-create the very blocker we are clearing.
      await tx.terminal.update({
        where: { id: terminalId },
        data: { venueId: revert.fromVenueId, assignedMerchantIds: revert.previousMerchantIds ?? [] },
      })
      if (revert.createdVenuePaymentConfigId) {
        await tx.venuePaymentConfig.deleteMany({ where: { id: revert.createdVenuePaymentConfigId } })
      }
    }

    return { discardedIds }
  })

  const restoredVenueId = revert?.fromVenueId ?? terminal.venueId

  await logAction({
    staffId: actor.staffId ?? null,
    venueId: restoredVenueId,
    action: 'TERMINAL_PENDING_WIPE_DISCARDED',
    entity: 'Terminal',
    entityId: terminalId,
    data: {
      commandIds: discardedIds,
      newestQueuedAt: newest.createdAt,
      silentForMs: now.getTime() - newest.createdAt.getTime(),
      lastActivationStatusCheckAt: terminal.lastActivationStatusCheckAt,
      revertedFromVenueId: revert?.fromVenueId ? terminal.venueId : undefined,
      restoredVenueId,
      deletedVenuePaymentConfigId: revert?.createdVenuePaymentConfigId,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  })
  logger.warn(`Pending wipe(s) discarded for terminal ${terminalId} by ${actor.staffId ?? 'system'}`, {
    commandIds: discardedIds,
    restoredVenueId,
  })

  return { discarded: discardedIds.length, commandIds: discardedIds, restoredVenueId }
}

const ONLINE_THRESHOLD_MS = 2 * 60 * 1000 // mirror tpv-health/command-execution online cutoff

export interface MigrateStatusResult {
  cancellable: boolean
  commandStatus: string
  resultMessage: string | null
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

  const commandDelivered = ['RECEIVED', 'EXECUTING', 'COMPLETED'].includes(command.status)
  const reboundAfterWipe = deviceReboundAfter(command, terminal.commandSessionId)
  const currentlyOnline =
    !!terminal.lastHeartbeat && now >= terminal.lastHeartbeat.getTime() && now - terminal.lastHeartbeat.getTime() < ONLINE_THRESHOLD_MS
  const destinationVenueId =
    (command.payload as { _migrationIntent?: { toVenueId?: string } } | null)?._migrationIntent?.toVenueId ?? command.venueId
  const onlineUnderNewVenue = currentlyOnline && terminal.venueId === destinationVenueId
  const confirmed = reboundAfterWipe && onlineUnderNewVenue && command.status === 'COMPLETED'

  return {
    commandStatus: command.status,
    cancellable: canCancelWipe(command),
    resultMessage: command.resultMessage,
    commandDelivered,
    reboundAfterWipe,
    currentlyOnline,
    onlineUnderNewVenue,
    confirmed,
    elapsedMs: now - t0.getTime(),
  }
}
