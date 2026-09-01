import { Prisma, PaymentProcessor } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { deviceReboundAfter, updateTerminal, type TerminalActor } from '@/services/dashboard/terminals.superadmin.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
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

interface PendingWipeRow {
  id: string
  createdAt: Date
  status: string
  payload: unknown
  venueId: string
}

/**
 * FACTORY_RESETs that are STILL pending for this terminal. Two filters, and BOTH are
 * needed (Asana 1218069201250971, 2026-09-01):
 *  1. Expiry-aware: a FACTORY_RESET never ACKs (the device wipes + kills its process before
 *     it can), so it lingers in a non-terminal status until the expiry sweep marks it
 *     EXPIRED. A stale/expired-but-unswept command must NOT falsely block a new migration.
 *  2. Rebind-aware: the sweep only ever touches commands WITH an expiresAt. Hand-inserted
 *     rows with `expiresAt = null` stayed SENT forever and blocked the org wizard for MONTHS
 *     on 3 terminals; and the 7-day migration TTL blocked re-migrating a terminal for a week
 *     after its wipe had already completed. The device's own post-wipe rebind is the proof
 *     the wipe happened — `deviceReboundAfter`, the same rule the terminals-list badge and
 *     `migrateStatus` use, so the three surfaces can never disagree.
 */
async function findPendingWipes(terminalId: string, lastActivationStatusCheckAt: Date | null | undefined): Promise<PendingWipeRow[]> {
  const inFlight = await prisma.tpvCommandQueue.findMany({
    where: {
      terminalId,
      commandType: 'FACTORY_RESET',
      status: { in: [...IN_FLIGHT_STATUSES] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true, createdAt: true, status: true, payload: true, venueId: true },
  })
  return inFlight.filter(c => !deviceReboundAfter(c.createdAt, lastActivationStatusCheckAt))
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
  const cancellable = CANCELLABLE_STATUSES.includes(newest.status)
  const discardableAt = new Date(newest.createdAt.getTime() + DISCARD_AFTER_MS)
  return {
    commandId: newest.id,
    queuedAt: newest.createdAt,
    status: newest.status,
    origin: migration ? 'MIGRATION' : 'MANUAL',
    toVenueId: typeof migration?.toVenueId === 'string' ? migration.toVenueId : null,
    cancellable,
    discardable: !cancellable && discardableAt.getTime() <= now,
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

export async function migratePreflight(terminalId: string, toVenueId: string, migrateMerchant = false): Promise<PreflightResult> {
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
  const paymentConfig = await prisma.venuePaymentConfig.findFirst({
    where: { venueId: toVenueId },
  })

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
  const pendingWipe = describePendingWipe(await findPendingWipes(terminalId, terminal.lastActivationStatusCheckAt))
  if (pendingWipe) {
    blockers.push({
      code: 'MIGRATION_IN_PROGRESS',
      message: `Hay un borrado de fábrica pendiente desde el ${fechaCorta(pendingWipe.queuedAt, originVenue?.timezone)} que la terminal aún no ejecuta.`,
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
 *
 * With `migrateMerchant`, the terminal keeps carrying its origin merchant(s) instead
 * of resolving the destination's default, and — only if the destination has no
 * `VenuePaymentConfig` of its own (I1) — one gets created. Normally copied from the
 * origin, but if the operator explicitly picked a merchant (`assignedMerchantIds`
 * non-empty), the created config reflects THAT choice instead — the terminal and the
 * venue's new permanent default must agree on which merchant is "the" merchant
 * (Finding 1, final whole-branch review). That write's id is stamped onto the
 * FACTORY_RESET payload (`migration.createdVenuePaymentConfigId`) so `migrateCancel`
 * (Task 5) can undo it.
 */
export async function migrateExecute(
  terminalId: string,
  toVenueId: string,
  actor: TerminalActor & { staffName?: string },
  assignedMerchantIds?: string[],
  migrateMerchant = false,
): Promise<MigrateExecuteResult> {
  // Re-validate at execute time — state may have changed since preflight.
  const pre = await migratePreflight(terminalId, toVenueId, migrateMerchant)
  if (!pre.canProceed) {
    throw new BadRequestError(`Migration blocked: ${pre.blockers.map(b => b.code).join(', ')}`)
  }

  // Finding 1 (final whole-branch review, founder-confirmed 2026-07-15): captured from the
  // ORIGINAL parameter, BEFORE it gets reassigned into the local `merchantsToAssign` variable
  // below (Step 2) — that reassignment folds in the auto-carry fallback, which would make this
  // check meaningless if read afterward. Used only to decide the destination
  // VenuePaymentConfig's identity (Step 2b) — see the comment there for why this must NOT be
  // used to derive identity from `merchantsToAssign` in the no-selection case.
  const hasExplicitSelection = !!(assignedMerchantIds && assignedMerchantIds.length > 0)

  // 0) Snapshot del origen ANTES del re-parent: updateTerminal borra
  //    assignedMerchantIds y el venue cambia, así que después ya no se puede leer.
  let origin: OriginPaymentSnapshot | null = null
  if (migrateMerchant) {
    const terminalBefore = await prisma.terminal.findUnique({ where: { id: terminalId } })
    if (!terminalBefore) throw new NotFoundError('Terminal not found')
    const originVenue = await prisma.venue.findUnique({ where: { id: terminalBefore.venueId } })
    origin = await resolveOriginPayment(
      { venueId: terminalBefore.venueId, assignedMerchantIds: terminalBefore.assignedMerchantIds ?? [] },
      originVenue?.organizationId ?? null,
    )
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
  // Con migrateMerchant, la terminal se lleva lo del origen en vez de resolver el
  // default del destino (que puede no existir — ése es justo el caso a desbloquear).
  if ((!merchantsToAssign || merchantsToAssign.length === 0) && migrateMerchant && origin) {
    merchantsToAssign = origin.merchantIds
  }
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

  // 2b) Dejar el venue destino cobrando de forma permanente.
  //     I1: si ya tiene config propia NO se toca — sobrescribirla repuntaría el
  //     dinero de un venue que ya cobra.
  let createdVenuePaymentConfigId: string | null = null
  if (migrateMerchant && origin?.copyable) {
    // Finding 1 (final whole-branch review, founder-confirmed 2026-07-15): si el operador
    // eligió un merchant específico junto con el checkbox, la config creada debe
    // reflejar ESE merchant — no el del origen. Sin esto, la terminal cobra con el
    // elegido pero el "default permanente" de la sucursal queda grabado con el
    // merchant del origen: contamina atribución de costos (transactionCost.service.ts:265
    // lee paymentConfig.primaryAccount), "el merchant del venue" en onboarding
    // (onboarding.controller.ts:398), el matcher de webhooks de Blumon, y cualquier
    // migración FUTURA a este mismo venue sin el checkbox (cuyo fallback en Step 2 lee este
    // mismo primaryAccountId como default permanente del venue).
    //
    // Ojo: esto SÓLO aplica con selección explícita. Sin ella (acarreo automático),
    // `origin.copyable` se usa VERBATIM — NO derivar de `merchantsToAssign` (un array
    // compactado sin huecos, ver Step 2 arriba) en ese caso, o se reintroduce el bug de
    // "hueco compactado, tertiary promovido a secondary" que una revisión anterior ya
    // corrigió dentro de `resolveOriginPayment`.
    const copyable = hasExplicitSelection
      ? {
          primaryAccountId: assignedMerchantIds![0],
          secondaryAccountId: assignedMerchantIds![1] ?? null,
          tertiaryAccountId: assignedMerchantIds![2] ?? null,
          // La política del venue (no es identidad de merchant) sigue viniendo del origen.
          preferredProcessor: origin.copyable.preferredProcessor,
          routingRules: origin.copyable.routingRules,
        }
      : origin.copyable
    const existing = await prisma.venuePaymentConfig.findUnique({ where: { venueId: toVenueId } })
    if (!existing) {
      // Money-safety (review finding, not in the original brief): `copyable` comes from
      // `resolveOriginPayment`'s origin snapshot (or, with an explicit selection above, the
      // operator's own pick) — neither path is filtered by `MerchantAccount.active` (see
      // resolveOriginPayment's docstring — it's a lightweight ids-only helper). `pre` above
      // already confirmed SOME active merchant exists among the
      // origin's merchants (ORIGIN_HAS_NO_MERCHANT), but not specifically that
      // `primaryAccountId` — the one non-nullable field this INSERT hinges on — is
      // the active one (e.g. secondary active, primary deactivated for fraud/
      // compliance). Writing an inactive primaryAccountId into a brand-new
      // VenuePaymentConfig would silently leave the destination "migrated but can't
      // charge" — the exact failure this feature exists to prevent. Scoped
      // deliberately narrow to primaryAccountId only: no re-ranking/promoting
      // secondary → primary — that's real complexity for a currently
      // zero-instance-in-prod edge case (verified in prod: 2026-07-15).
      const referencedIds = [copyable.primaryAccountId, copyable.secondaryAccountId, copyable.tertiaryAccountId].filter(
        (id): id is string => !!id,
      )
      const activeReferenced = await prisma.merchantAccount.findMany({
        where: { id: { in: referencedIds }, active: true },
        select: { id: true },
      })
      const primaryIsActive = activeReferenced.some(m => m.id === copyable.primaryAccountId)

      if (!primaryIsActive) {
        logger.warn(
          `Terminal migration ${terminalId}: skipping VenuePaymentConfig creation for venue ${toVenueId} — origin's primaryAccountId (${copyable.primaryAccountId}) is not an active MerchantAccount.`,
        )
      } else {
        // Race guard: `existing` above is a check-then-act read, not a lock. VenuePaymentConfig
        // .venueId is @unique — if two DIFFERENT terminals migrate to the SAME destination venue
        // with migrateMerchant at nearly the same time, both can see `existing === null` before
        // either creates, and the second `create()` throws P2002. The unique constraint is what
        // actually protects I1 here (nobody's config gets silently overwritten); we just must not
        // let that throw become an uncaught 500 AFTER this terminal's own re-parent (Step 1) and
        // merchant assignment (Step 2) already committed. Mirrors the isPrismaUniqueViolation
        // pattern in terminal-payment.service.ts:129-133. This is an expected race outcome, not a
        // bug — log info (not warn/error) and continue WITHOUT createdVenuePaymentConfigId: this
        // execution didn't create the config, the OTHER terminal's migration owns it, so this
        // terminal's cancel flow must not try to delete a config it doesn't own. Any other error
        // is a real failure and must still propagate.
        try {
          // Cast needed: `copyable.routingRules` is typed `Prisma.JsonValue | null` (a read
          // shape, from resolveOriginPayment's SELECT), but Prisma's generated create input
          // for a nullable Json column wants its `NullableJsonNullValueInput` sentinel instead
          // of a bare `null` — a well-known Prisma JSON-null typing quirk. Runtime value is
          // unaffected (still plain `null`, exactly what a copied "no routing rules" origin
          // config should write).
          const created = await prisma.venuePaymentConfig.create({
            data: { venueId: toVenueId, ...copyable } as Prisma.VenuePaymentConfigUncheckedCreateInput,
          })
          createdVenuePaymentConfigId = created.id
          // I6: es ruteo de dinero → va auditado.
          await logAction({
            staffId: actor.staffId ?? null,
            venueId: toVenueId,
            action: 'VENUE_PAYMENT_CONFIG_CREATED',
            entity: 'VenuePaymentConfig',
            entityId: created.id,
            data: {
              copiedFromVenueId: pre.fromVenueId,
              primaryAccountId: copyable.primaryAccountId,
              viaTerminalMigration: terminalId,
            },
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
          })
        } catch (err) {
          const isUniqueViolation =
            (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') ||
            (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002')
          if (!isUniqueViolation) throw err
          logger.info(
            `Terminal migration ${terminalId}: lost the race to create VenuePaymentConfig for venue ${toVenueId} — another migration already created one.`,
          )
        }
      }
    }
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

  // I5: el cancel necesita saber qué config creamos para poder deshacerla. El
  //     payload lo escribe updateTerminal ("blindar"), así que lo parchamos aquí.
  if (createdVenuePaymentConfigId) {
    const payload = (cmd.payload as Record<string, unknown> | null) ?? {}
    const migration = (payload.migration as Record<string, unknown> | undefined) ?? {}
    await prisma.tpvCommandQueue.update({
      where: { id: cmd.id },
      data: { payload: { ...payload, migration: { ...migration, createdVenuePaymentConfigId } } },
    })
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
  const migration = (
    command.payload as {
      migration?: { fromVenueId?: string; previousMerchantIds?: string[]; createdVenuePaymentConfigId?: string }
    } | null
  )?.migration
  if (!migration || !migration.fromVenueId) {
    // MANUAL wipe (queued from the superadmin, no venue move behind it) — or a legacy
    // command queued before the blindar payload existed. There is nothing to revert: the
    // terminal never moved. Cancelling is just dropping the queued command so it never
    // reaches the device. This path used to throw "cannot revert" and left the operator
    // with no way out of MIGRATION_IN_PROGRESS (Asana 1218069201250971, 2026-09-01).
    const terminal = await prisma.terminal.findUnique({ where: { id: terminalId }, select: { venueId: true } })
    if (!terminal) throw new NotFoundError('Terminal not found')

    await tpvCommandQueueService.cancelCommand(command.id, actor.staffId ?? 'system', 'Borrado pendiente cancelado por el operador')
    await logAction({
      staffId: actor.staffId ?? null,
      venueId: terminal.venueId,
      action: 'TERMINAL_PENDING_WIPE_CANCELLED',
      entity: 'Terminal',
      entityId: terminalId,
      data: { commandId: command.id, origin: 'MANUAL' },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    })
    logger.info(`Pending manual wipe cancelled for terminal ${terminalId}`, { commandId: command.id })
    return { cancelled: true, restoredVenueId: terminal.venueId }
  }
  const { fromVenueId, previousMerchantIds, createdVenuePaymentConfigId } = migration

  // 3) Cancel the queued wipe so it never reaches the device.
  await tpvCommandQueueService.cancelCommand(command.id, actor.staffId ?? 'system', 'Migración cancelada por el operador')

  // 4) Revert the terminal directly (BYPASS updateTerminal so blindar does NOT
  //    re-queue a wipe on the revert). Restore both the origin venue and the
  //    merchant assignments captured at migration time.
  await prisma.terminal.update({
    where: { id: terminalId },
    data: { venueId: fromVenueId, assignedMerchantIds: previousMerchantIds ?? [] },
  })

  // 4b) I5: deshacer la VenuePaymentConfig que ESTA migración creó. Sin esto, una
  //     migración cancelada dejaría al venue destino cobrando para siempre.
  //     deleteMany (no delete) para ser idempotente si ya no existe. Sólo tocamos
  //     la fila cuyo id grabamos nosotros — nunca una preexistente (I1).
  if (createdVenuePaymentConfigId) {
    await prisma.venuePaymentConfig.deleteMany({ where: { id: createdVenuePaymentConfigId } })
    await logAction({
      staffId: actor.staffId ?? null,
      venueId: fromVenueId,
      action: 'VENUE_PAYMENT_CONFIG_DELETED',
      entity: 'VenuePaymentConfig',
      entityId: createdVenuePaymentConfigId,
      data: { reason: 'Migración de terminal cancelada', commandId: command.id, terminalId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    })
  }

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
export async function migrateDiscard(terminalId: string, actor: TerminalActor): Promise<MigrateDiscardResult> {
  const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } })
  if (!terminal) throw new NotFoundError('Terminal not found')

  const pending = await findPendingWipes(terminalId, terminal.lastActivationStatusCheckAt)
  if (pending.length === 0) {
    throw new BadRequestError('No hay un borrado pendiente que descartar: la terminal ya lo ejecutó o nunca hubo uno.')
  }
  const newest = newestOf(pending)
  if (CANCELLABLE_STATUSES.includes(newest.status)) {
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
    // Re-check the proof of wipe INSIDE the transaction: between the read above and this
    // write the device may have rebound (i.e. it DID execute the wipe). Expiring then would
    // record a discard that never happened and — worse — revert a migration that completed.
    const fresh = await tx.terminal.findUnique({ where: { id: terminalId }, select: { lastActivationStatusCheckAt: true } })
    if (deviceReboundAfter(newest.createdAt, fresh?.lastActivationStatusCheckAt)) {
      throw new ConflictError('La terminal acaba de reconectarse: ya ejecutó el borrado. Vuelve a verificar el destino.')
    }

    // One update per id so the audit trail names the rows that ACTUALLY moved: `updateMany`
    // reports a count, not which rows, and the sweep or the device may have moved one of
    // them to a terminal status in the meantime (Codex P3).
    const discardedIds: string[] = []
    for (const id of pending.map(c => c.id)) {
      const r = await tx.tpvCommandQueue.updateMany({
        where: { id, status: { in: [...IN_FLIGHT_STATUSES] } },
        data: { status: 'EXPIRED', expiresAt: now },
      })
      if (r.count > 0) discardedIds.push(id)
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
  const reboundAfterWipe = deviceReboundAfter(t0, terminal.lastActivationStatusCheckAt)
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
