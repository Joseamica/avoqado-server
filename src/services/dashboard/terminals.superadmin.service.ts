import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, IncompatibleDeviceError, NotFoundError, TerminalBrandChangeBlocked } from '../../errors/AppError'
import { generateActivationCode as generateActivationCodeUtil } from './terminal-activation.service'
import { notifyAffectedTerminals } from '../superadmin/merchantAccount.service'
import { tpvCommandQueueService } from '../tpv/command-queue.service'
import { updateTpvSettings, type TpvSettings } from './tpv.dashboard.service'
import { assertMerchantsTerminalCompatible, isProviderCompatibleWithBrand } from '../../lib/providerDeviceCompatibility'
import { logAction } from './activity-log.service'

/**
 * Audit actor — who triggered a terminal mutation. Threaded from the controller
 * so every Terminal change lands in `ActivityLog` (the May 2026 incident had
 * zero audit trail because these services never logged).
 */
export interface TerminalActor {
  staffId?: string | null
  staffName?: string
  ipAddress?: string
  userAgent?: string
}

/**
 * Migration wipe TTL — 7 days.
 *
 * Any venue change on a terminal auto-queues a FACTORY_RESET ("blindar"): the
 * device's Blumon merchant creds are re-synced ONLY by the wipe-and-restart
 * (heartbeat/config-poll does NOT re-sync them), so a re-parented-but-not-wiped
 * terminal would keep charging through the OLD venue's merchant → split-brain
 * money routing. The default FACTORY_RESET TTL is 30 min, which would expire
 * before a multi-day-offline device returns. This long TTL lets the wipe
 * complete whenever the device reconnects.
 *
 * Kept in sync with the same constant in terminal-migration.service.ts.
 */
export const MIGRATION_WIPE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Per-terminal migration badge shape attached to each terminal in the SUPERADMIN
 * list response. `null` when the terminal has no in-flight migration FACTORY_RESET.
 *
 * `inProgress` is true while a migration wipe is "live" AND the device has NOT yet
 * rebound after it. A FACTORY_RESET never ACKs (it lingers in a non-terminal status
 * until it EXPIRES), so completion is detected via the device's post-wipe rebound
 * (`Terminal.lastActivationStatusCheckAt` stamped strictly AFTER the command was
 * created), not via the command reaching a terminal status.
 */
export interface TerminalMigrationInfo {
  inProgress: boolean
  commandId: string
  fromVenueId: string
  toVenueId: string
}

/**
 * In-flight (non-terminal) command statuses for a migration FACTORY_RESET. These
 * mean the wipe has NOT completed/failed/expired/been cancelled yet.
 */
const MIGRATION_IN_FLIGHT_STATUSES = ['PENDING', 'QUEUED', 'SENT', 'RECEIVED', 'EXECUTING'] as const

/**
 * Minimal shape of a migration FACTORY_RESET command needed to compute the badge.
 * Decoupled from Prisma's generated type so this stays unit-testable in isolation.
 */
export interface MigrationCommandLike {
  id: string
  createdAt: Date | null
  payload: unknown
}

/**
 * Pure helper — compute the `migration` badge for a single terminal.
 *
 * @param command The terminal's latest in-flight migration FACTORY_RESET (or null/undefined).
 * @param lastActivationStatusCheckAt When the device last (re-)bound via activation-status.
 * @returns The `TerminalMigrationInfo` badge, or `null` when there's no migration command
 *          (or the command's payload lacks a `migration` object — i.e. a manual reset).
 *
 * A migration is in progress UNLESS the device already rebound after the wipe, i.e.
 * `lastActivationStatusCheckAt` is strictly after the command's `createdAt`. An offline
 * device (no rebound) stays `inProgress: true`.
 */
export function computeTerminalMigration(
  command: MigrationCommandLike | null | undefined,
  lastActivationStatusCheckAt: Date | null | undefined,
): TerminalMigrationInfo | null {
  if (!command) return null

  const migration = (command.payload as any)?.migration
  if (!migration || typeof migration.fromVenueId !== 'string' || typeof migration.toVenueId !== 'string') {
    // Not a migration wipe (manual FACTORY_RESET, or legacy command without payload).
    return null
  }

  const rebound = Boolean(lastActivationStatusCheckAt && command.createdAt && lastActivationStatusCheckAt > command.createdAt)

  return {
    inProgress: !rebound,
    commandId: command.id,
    fromVenueId: migration.fromVenueId,
    toVenueId: migration.toVenueId,
  }
}

/**
 * Get All Terminals (Cross-Venue)
 *
 * Returns all terminals across all venues with optional filters.
 * Used by superadmin dashboard.
 *
 * Each returned terminal additionally carries a `migration` field
 * (`TerminalMigrationInfo | null`) so the dashboard can show a "Migrando…" badge
 * and offer resume/cancel for terminals with an in-flight migration FACTORY_RESET.
 *
 * @param filters Optional filters: venueId, status, type
 * @returns List of terminals with venue info + migration badge
 */
export async function getAllTerminals(filters?: { venueId?: string; status?: string; type?: string }) {
  logger.info('Fetching all terminals with filters:', filters)

  const where: any = {}

  if (filters?.venueId) {
    where.venueId = filters.venueId
  }

  if (filters?.status) {
    where.status = filters.status
  }

  if (filters?.type) {
    where.type = filters.type
  }

  const terminals = await prisma.terminal.findMany({
    where,
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  // ---------------------------------------------------------------------------
  // Migration badge ("Migrando…").
  // ---------------------------------------------------------------------------
  // One batched query (no N+1) for the in-flight migration FACTORY_RESET commands
  // of the terminals on this page. We filter in-flight statuses + not-expired here
  // (a migration wipe never ACKs; it lingers until it EXPIRES), then keep only the
  // latest such command per terminal and compute `inProgress` from the device's
  // post-wipe rebound timestamp. Adds the `migration` field WITHOUT changing the
  // existing list shape.
  const terminalIds = terminals.map(t => t.id)
  const latestMigrationByTerminal = new Map<string, MigrationCommandLike>()

  if (terminalIds.length > 0) {
    const migrationCommands = await prisma.tpvCommandQueue.findMany({
      where: {
        terminalId: { in: terminalIds },
        commandType: 'FACTORY_RESET',
        status: { in: [...MIGRATION_IN_FLIGHT_STATUSES] },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true, terminalId: true, createdAt: true, payload: true },
      orderBy: { createdAt: 'desc' },
    })

    // Keep the latest migration command per terminal. Because rows are ordered by
    // createdAt desc, the first one we see for a terminal is its latest — and we
    // only keep commands whose payload actually carries a `migration` object.
    for (const cmd of migrationCommands) {
      if (latestMigrationByTerminal.has(cmd.terminalId)) continue
      if (!(cmd.payload as any)?.migration) continue
      latestMigrationByTerminal.set(cmd.terminalId, cmd)
    }
  }

  const terminalsWithMigration = terminals.map(terminal => ({
    ...terminal,
    migration: computeTerminalMigration(latestMigrationByTerminal.get(terminal.id), terminal.lastActivationStatusCheckAt),
  }))

  logger.info(`Fetched ${terminals.length} terminals`)

  return terminalsWithMigration
}

/**
 * Get Terminal by ID
 *
 * @param terminalId Terminal ID (CUID)
 * @returns Terminal with venue info
 */
export async function getTerminalById(terminalId: string) {
  logger.info(`Fetching terminal: ${terminalId}`)

  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  return terminal
}

/**
 * Create Terminal
 *
 * Creates a new terminal with optional merchant account assignments.
 * Optionally generates activation code immediately.
 *
 * @param data Terminal creation data
 * @returns Created terminal with activation code (if requested)
 */
export async function createTerminal(data: {
  venueId: string
  serialNumber: string
  name: string
  type: string
  brand?: string
  model?: string
  assignedMerchantIds?: string[]
  generateActivationCode?: boolean
  staffId?: string
  configOverrides?: Partial<TpvSettings>
}) {
  logger.info('Creating terminal:', {
    venueId: data.venueId,
    serialNumber: data.serialNumber,
    name: data.name,
  })

  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: data.venueId },
  })

  if (!venue) {
    throw new BadRequestError('Venue not found')
  }

  // Check if serial number is unique
  const existingTerminal = await prisma.terminal.findFirst({
    where: {
      serialNumber: {
        equals: data.serialNumber,
        mode: 'insensitive',
      },
    },
  })

  if (existingTerminal) {
    throw new BadRequestError(`Terminal with serial number ${data.serialNumber} already exists`)
  }

  // Validate merchant accounts exist (if assigned)
  if (data.assignedMerchantIds && data.assignedMerchantIds.length > 0) {
    const merchantCount = await prisma.merchantAccount.count({
      where: {
        id: { in: data.assignedMerchantIds },
      },
    })

    if (merchantCount !== data.assignedMerchantIds.length) {
      throw new BadRequestError('One or more merchant accounts not found')
    }

    // Provider ↔ device-brand compatibility guard (Task 11 / validation point #2).
    // For a fresh terminal we don't have an id yet, so we inline the check
    // against the prospective `data.brand` (may be undefined → permissive,
    // re-enforced on activation per the spec).
    if (data.brand) {
      const merchants = await prisma.merchantAccount.findMany({
        where: { id: { in: data.assignedMerchantIds } },
        select: { id: true, provider: { select: { code: true } } },
      })
      const incompatible = merchants.filter(m => !isProviderCompatibleWithBrand(m.provider.code, data.brand!))
      if (incompatible.length > 0) {
        const summary = incompatible.map(m => `${m.id} (${m.provider.code})`).join(', ')
        throw new IncompatibleDeviceError(`Cannot assign incompatible merchants to ${data.brand} terminal: ${summary}`)
      }
    }
  }

  // Create terminal
  const terminal = await prisma.terminal.create({
    data: {
      venueId: data.venueId,
      serialNumber: data.serialNumber,
      name: data.name,
      type: data.type as any,
      brand: data.brand,
      model: data.model,
      status: 'INACTIVE', // Default status (will become ACTIVE after activation)
      assignedMerchantIds: data.assignedMerchantIds || [],
    },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  })

  logger.info(`Terminal created successfully: ${terminal.id}`)

  // Auto-attach existing merchant accounts with matching serial number
  // Note: Terminal serialNumber may have prefix (e.g., "AVQD-2841548417") while
  // MerchantAccount.blumonSerialNumber has raw serial ("2841548417")
  let autoAttachedMerchants: Array<{ id: string; displayName: string | null }> = []

  if (data.serialNumber) {
    // Extract raw serial by removing common prefixes (AVQD-, AVQ-, etc.)
    const rawSerial = data.serialNumber.replace(/^(AVQD-|AVQ-|AVO-)/i, '')
    logger.info('[Terminal Create] Searching for merchants to auto-attach', {
      terminalSerial: data.serialNumber,
      rawSerial,
    })

    const matchingMerchants = await prisma.merchantAccount.findMany({
      where: {
        OR: [
          { blumonSerialNumber: data.serialNumber }, // Exact match
          { blumonSerialNumber: rawSerial }, // Match raw serial
        ],
        active: true,
      },
      select: {
        id: true,
        displayName: true,
      },
    })

    if (matchingMerchants.length > 0) {
      // Filter out merchants that were already passed in assignedMerchantIds
      const existingIds = new Set(data.assignedMerchantIds || [])
      const newMerchants = matchingMerchants.filter(m => !existingIds.has(m.id))

      if (newMerchants.length > 0) {
        // Update terminal with additional merchants
        const updatedTerminal = await prisma.terminal.update({
          where: { id: terminal.id },
          data: {
            assignedMerchantIds: {
              push: newMerchants.map(m => m.id),
            },
          },
        })

        autoAttachedMerchants = newMerchants

        // Notify terminals about the new merchants
        for (const merchant of newMerchants) {
          await notifyAffectedTerminals(merchant.id, merchant.displayName || `Blumon ${data.serialNumber}`, 'MERCHANT_ADDED', false)
        }

        logger.info(`[Terminal Create] Auto-attached ${newMerchants.length} merchant(s) to terminal`, {
          terminalId: terminal.id,
          merchantIds: newMerchants.map(m => m.id),
        })

        // Update terminal object with new assignedMerchantIds for return
        terminal.assignedMerchantIds = updatedTerminal.assignedMerchantIds
      }
    } else {
      logger.info('[Terminal Create] No existing merchants found with matching serial for auto-attach', {
        serialNumber: data.serialNumber,
      })
    }
  }

  // Apply optional pre-configuration overrides (e.g. tip suggestions, kiosk mode,
  // home-screen visibility flags). Reuses updateTpvSettings so the same diff vs
  // org defaults + config.settings (Android compat) logic runs.
  if (data.configOverrides && Object.keys(data.configOverrides).length > 0) {
    try {
      await updateTpvSettings(terminal.id, data.configOverrides)
      logger.info(`Initial TPV settings applied to terminal ${terminal.id}`, {
        keys: Object.keys(data.configOverrides),
      })
    } catch (err) {
      // Don't fail the whole creation if pre-configuration has a problem;
      // the terminal already exists and can be configured later.
      logger.error(`Failed to apply initial TPV settings to terminal ${terminal.id}`, { error: err })
    }
  }

  // Generate activation code if requested
  let activationCodeData = null
  if (data.generateActivationCode && data.staffId) {
    activationCodeData = await generateActivationCodeUtil(terminal.id, data.staffId)
    logger.info(`Activation code generated for terminal ${terminal.id}: ${activationCodeData.activationCode}`)
  }

  await logAction({
    staffId: data.staffId ?? null,
    venueId: terminal.venueId,
    action: 'TERMINAL_CREATED',
    entity: 'Terminal',
    entityId: terminal.id,
    data: {
      serialNumber: terminal.serialNumber,
      name: terminal.name,
      type: terminal.type,
      assignedMerchantIds: terminal.assignedMerchantIds,
      autoAttachedMerchantIds: autoAttachedMerchants.map(m => m.id),
    },
  })

  return {
    terminal,
    activationCode: activationCodeData,
    autoAttachedMerchants,
  }
}

/**
 * Update Terminal
 *
 * Updates terminal metadata (name, status, assignedMerchantIds, etc.)
 *
 * @param terminalId Terminal ID (CUID)
 * @param data Update data
 * @returns Updated terminal
 */
export async function updateTerminal(
  terminalId: string,
  data: {
    name?: string
    status?: string
    assignedMerchantIds?: string[]
    brand?: string
    model?: string
    /**
     * Task 12 / validation point #3: when changing `brand`, if any currently
     * assigned merchant becomes incompatible, the service returns a warning
     * payload (no mutation) by default. Pass `forceUnassign: true` after
     * operator confirmation to atomically (a) change the brand and (b)
     * remove the incompatible merchants from `assignedMerchantIds`.
     */
    forceUnassign?: boolean
    /**
     * Task 54: move terminal to a different venue. When set and differs from
     * the current venueId, the service (a) verifies the target venue exists,
     * (b) clears `assignedMerchantIds` (cross-tenant assignments are invalid),
     * and (c) writes the new venueId. The TPV picks up the new venue context
     * on its next `/tpv/terminals/:serial/config` poll (~30s).
     */
    venueId?: string
  },
  actor?: TerminalActor,
) {
  logger.info(`Updating terminal ${terminalId}:`, data)

  // Verify terminal exists
  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  // ---------------------------------------------------------------------------
  // Task 54: venue-move guard.
  // ---------------------------------------------------------------------------
  // If the caller wants to move the terminal to a different venue, validate
  // the target venue and clear merchant assignments (a MerchantAccount lives
  // in the global pool but is wired to a venue via VenuePaymentConfig — keeping
  // assignedMerchantIds across a venue move would leak cross-tenant routing).
  let venueChanged = false
  if (data.venueId && data.venueId !== terminal.venueId) {
    const targetVenue = await prisma.venue.findUnique({ where: { id: data.venueId } })
    if (!targetVenue) {
      throw new NotFoundError(`Target venue ${data.venueId} not found`)
    }
    venueChanged = true
    logger.info(`Moving terminal ${terminalId} from venue ${terminal.venueId} → ${data.venueId} (clearing assignedMerchantIds)`)
  }

  // ---------------------------------------------------------------------------
  // Validation point #3 (Task 12 / spec §3.1 point 2c, §4.4): brand-change guard
  // ---------------------------------------------------------------------------
  // When `brand` changes, scan currently-assigned merchants. If any become
  // incompatible with the NEW brand, return a warning payload (no mutation)
  // unless `forceUnassign: true` — in which case prune them atomically.
  let prunedAssignedMerchantIds: string[] | undefined
  if (data.brand && data.brand !== terminal.brand) {
    const assignedIds = terminal.assignedMerchantIds ?? []
    if (assignedIds.length > 0) {
      const assignedMerchants = await prisma.merchantAccount.findMany({
        where: { id: { in: assignedIds } },
        select: {
          id: true,
          displayName: true,
          externalMerchantId: true,
          provider: { select: { code: true } },
        },
      })

      const incompatible = assignedMerchants.filter(m => !isProviderCompatibleWithBrand(m.provider.code, data.brand!))

      if (incompatible.length > 0) {
        if (!data.forceUnassign) {
          logger.warn(
            `Brand change for terminal ${terminalId} (${terminal.brand} → ${data.brand}) blocked: ${incompatible.length} incompatible merchant(s). Throwing TerminalBrandChangeBlocked.`,
          )
          throw new TerminalBrandChangeBlocked(
            incompatible.map(m => ({
              id: m.id,
              name: m.displayName ?? m.externalMerchantId,
              code: m.provider.code,
            })),
          )
        }

        // forceUnassign:true — atomic brand change + assigned list pruning
        const incompatibleIds = new Set(incompatible.map(m => m.id))
        prunedAssignedMerchantIds = assignedIds.filter(id => !incompatibleIds.has(id))
        logger.info(
          `Brand change for terminal ${terminalId} confirmed with forceUnassign — pruning ${incompatible.length} incompatible merchant(s): ${[...incompatibleIds].join(', ')}`,
        )

        const updated = await prisma.$transaction(async tx => {
          return tx.terminal.update({
            where: { id: terminalId },
            data: {
              ...(data.name && { name: data.name }),
              ...(data.status && { status: data.status as any }),
              brand: data.brand,
              assignedMerchantIds: prunedAssignedMerchantIds!,
              ...(data.model && { model: data.model }),
            },
            include: {
              venue: { select: { id: true, name: true, slug: true } },
            },
          })
        })
        logger.info(`Terminal ${terminalId} brand changed atomically with merchant pruning`)
        await logAction({
          staffId: actor?.staffId ?? null,
          venueId: updated.venueId,
          action: 'TERMINAL_UPDATED',
          entity: 'Terminal',
          entityId: terminalId,
          data: {
            updatedFields: ['brand', 'assignedMerchantIds'],
            brand: { before: terminal.brand, after: updated.brand },
            assignedMerchantIds: { before: terminal.assignedMerchantIds, after: updated.assignedMerchantIds },
            reason: 'brand-change forceUnassign pruning',
          },
          ipAddress: actor?.ipAddress,
          userAgent: actor?.userAgent,
        })
        return updated
      }
    }
  }

  // Validate merchant accounts if being updated
  if (data.assignedMerchantIds && data.assignedMerchantIds.length > 0) {
    const merchants = await prisma.merchantAccount.findMany({
      where: {
        id: { in: data.assignedMerchantIds },
      },
      select: { id: true, displayName: true },
    })

    logger.info(`Validation: Requested ${data.assignedMerchantIds.length} merchants, found ${merchants.length}`)
    logger.info('Requested IDs:', data.assignedMerchantIds)
    logger.info(
      'Found merchants:',
      merchants.map(m => ({ id: m.id, name: m.displayName })),
    )

    if (merchants.length !== data.assignedMerchantIds.length) {
      const foundIds = merchants.map(m => m.id)
      const missingIds = data.assignedMerchantIds.filter(id => !foundIds.includes(id))
      logger.error('Missing merchant IDs:', missingIds)
      throw new BadRequestError(`Merchant accounts not found: ${missingIds.join(', ')}`)
    }

    // Provider ↔ device-brand compatibility guard (Task 11 / validation point #2).
    // Rejects e.g. ANGELPAY merchants → PAX terminals, BLUMON merchants → NEXGO.
    // Permissive on unconstrained providers (STRIPE/MENTA) and null brand
    // (PENDING_ACTIVATION terminals).
    await assertMerchantsTerminalCompatible(terminalId, data.assignedMerchantIds)
  }

  // Update terminal
  const updatedTerminal = await prisma.terminal.update({
    where: { id: terminalId },
    data: {
      ...(data.name && { name: data.name }),
      ...(data.status && { status: data.status as any }),
      // A superadmin setting a terminal to ACTIVE that was never activated
      // counts as activation — stamp activatedAt (and activatedBy) so the
      // heartbeat/login/payment layers treat it as a real activated terminal.
      // Without this the terminal logs "Heartbeat from unactivated terminal"
      // and login/payment endpoints stay blocked even though status=ACTIVE.
      ...(data.status === 'ACTIVE' && !terminal.activatedAt ? { activatedAt: new Date(), activatedBy: actor?.staffId ?? null } : {}),
      // Task 54: clear assignedMerchantIds on venue change (cross-tenant
      // assignments are never valid). When venue isn't changing, defer to
      // explicit `assignedMerchantIds` from the caller.
      // assignedMerchantIds-raw-write-ok: Task 54 clears the array atomically with the
      // cross-venue venueId change (the old roster/links are invalid for the new venue).
      ...(venueChanged
        ? { venueId: data.venueId!, assignedMerchantIds: [] }
        : data.assignedMerchantIds !== undefined
          ? { assignedMerchantIds: data.assignedMerchantIds }
          : {}),
      ...(data.brand && { brand: data.brand }),
      ...(data.model && { model: data.model }),
    },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  })

  const updatedFields: string[] = []
  for (const f of ['name', 'status', 'brand', 'model'] as const) {
    if (data[f] !== undefined) updatedFields.push(f)
  }
  if (data.status === 'ACTIVE' && !terminal.activatedAt) updatedFields.push('activatedAt')
  const merchantsChanged = venueChanged || data.assignedMerchantIds !== undefined
  if (merchantsChanged) updatedFields.push('assignedMerchantIds')
  if (venueChanged) updatedFields.push('venueId')

  await logAction({
    staffId: actor?.staffId ?? null,
    venueId: updatedTerminal.venueId,
    action: 'TERMINAL_UPDATED',
    entity: 'Terminal',
    entityId: terminalId,
    data: {
      updatedFields,
      ...(merchantsChanged && {
        assignedMerchantIds: { before: terminal.assignedMerchantIds, after: updatedTerminal.assignedMerchantIds },
      }),
      ...(venueChanged && { venue: { before: terminal.venueId, after: updatedTerminal.venueId } }),
    },
    ipAddress: actor?.ipAddress,
    userAgent: actor?.userAgent,
  })

  // ---------------------------------------------------------------------------
  // "Blindar": auto-queue the migration wipe on EVERY venue change.
  // ---------------------------------------------------------------------------
  // A re-parented-but-not-wiped terminal keeps the OLD venue's Blumon merchant
  // creds (only the wipe-and-restart re-syncs them) → split-brain money routing.
  // So ANY path that changes the venue (edit dialog, AttachTerminalDialog,
  // admin-MCP move_terminal, migration wizard) must queue the FACTORY_RESET —
  // not just the wizard. This runs AFTER the venue is persisted because
  // queueCommand asserts terminal.venueId === the new venueId.
  //
  // Cancel state (fromVenueId, previousMerchantIds) is captured from the
  // pre-update `terminal` row BEFORE merchants were cleared, so migrateCancel
  // can revert the move while the device hasn't wiped yet.
  //
  // Resilient by design: the re-parent already committed, so a queue failure
  // must NOT fail the whole update (the operator can re-send the factory reset
  // from the command panel). We log a warning instead of throwing.
  if (venueChanged) {
    const fromVenueId = terminal.venueId
    const previousMerchantIds = terminal.assignedMerchantIds ?? []
    const toVenueId = updatedTerminal.venueId
    try {
      const queued = await tpvCommandQueueService.queueCommand({
        terminalId,
        venueId: toVenueId,
        commandType: 'FACTORY_RESET',
        priority: 'CRITICAL',
        requestedBy: actor?.staffId ?? 'system',
        ...(actor?.staffName ? { requestedByName: actor.staffName } : {}),
        source: 'DASHBOARD',
        payload: { migration: { fromVenueId, previousMerchantIds, toVenueId } },
      })

      // Override the default 30-min FACTORY_RESET TTL with a long one so the wipe
      // survives a multi-day-offline device and completes whenever it reconnects.
      await prisma.tpvCommandQueue.update({
        where: { id: queued.commandId },
        data: { expiresAt: new Date(Date.now() + MIGRATION_WIPE_TTL_MS) },
      })

      logger.info(`Migration wipe queued for terminal ${terminalId} (blindar)`, {
        commandId: queued.commandId,
        fromVenueId,
        toVenueId,
      })
    } catch (err) {
      logger.warn(`Failed to queue migration wipe for terminal ${terminalId} (blindar) — re-parent stands, operator can re-send`, {
        terminalId,
        fromVenueId,
        toVenueId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info(`Terminal ${terminalId} updated successfully`)

  return updatedTerminal
}

/**
 * Generate Activation Code for Terminal (Wrapper)
 *
 * Generates a 6-character activation code for a terminal.
 *
 * @param terminalId Terminal ID (CUID)
 * @param staffId Staff ID who is generating the code
 * @returns Activation code data
 */
export async function generateActivationCodeForTerminal(terminalId: string, staffId: string) {
  logger.info(`Generating activation code for terminal ${terminalId} by staff ${staffId}`)

  return generateActivationCodeUtil(terminalId, staffId)
}

/**
 * Delete Terminal
 *
 * Deletes a terminal (only if not activated or RETIRED status).
 *
 * @param terminalId Terminal ID (CUID)
 */
export async function deleteTerminal(terminalId: string, actor?: TerminalActor) {
  logger.info(`Deleting terminal: ${terminalId}`)

  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  // Prevent deletion of ACTIVE terminals (must be retired first)
  if (terminal.status === 'ACTIVE' && terminal.activatedAt) {
    throw new BadRequestError('Cannot delete active terminal. Set status to RETIRED first.')
  }

  await prisma.terminal.delete({
    where: { id: terminalId },
  })

  logger.info(`Terminal ${terminalId} deleted successfully`)

  await logAction({
    staffId: actor?.staffId ?? null,
    venueId: terminal.venueId,
    action: 'TERMINAL_DELETED',
    entity: 'Terminal',
    entityId: terminalId,
    data: {
      serialNumber: terminal.serialNumber,
      name: terminal.name,
      assignedMerchantIds: terminal.assignedMerchantIds,
    },
    ipAddress: actor?.ipAddress,
    userAgent: actor?.userAgent,
  })

  return { success: true }
}

/**
 * Send Remote Activation Command
 *
 * Sends a REMOTE_ACTIVATE command to a pre-registered terminal.
 * The terminal must have a serialNumber and must have sent at least one heartbeat.
 * Only SUPERADMIN can use this function.
 *
 * @param terminalId Terminal ID (CUID)
 * @param staffId Staff ID (SUPERADMIN) who is sending the command
 * @returns Command queue result
 */
export async function sendRemoteActivation(terminalId: string, staffId: string) {
  logger.info(`Sending remote activation command to terminal ${terminalId} by staff ${staffId}`)

  // Fetch terminal with venue info
  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
    include: {
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
        },
      },
    },
  })

  if (!terminal) {
    throw new NotFoundError('Terminal not found')
  }

  // Validate terminal is not already activated
  if (terminal.activatedAt) {
    throw new BadRequestError('Terminal is already activated')
  }

  // Validate terminal has a serial number (required for identification)
  if (!terminal.serialNumber) {
    throw new BadRequestError('Terminal must have a serial number for remote activation')
  }

  // Check if terminal has ever sent a heartbeat (proof of physical device)
  if (!terminal.lastHeartbeat) {
    throw new BadRequestError(
      'Terminal must send at least one heartbeat before remote activation. ' +
        'Please ensure the physical terminal is powered on and connected to the internet.',
    )
  }

  // Validate terminal status - should be INACTIVE
  if (terminal.status === 'RETIRED') {
    throw new BadRequestError('Cannot activate a retired terminal')
  }

  // Get staff info for audit trail
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: { id: true, firstName: true, lastName: true, email: true },
  })

  const staffName = staff ? `${staff.firstName} ${staff.lastName}`.trim() : 'SUPERADMIN'

  // Queue the REMOTE_ACTIVATE command with venue info payload
  const result = await tpvCommandQueueService.queueCommand({
    terminalId: terminal.id,
    venueId: terminal.venueId,
    commandType: 'REMOTE_ACTIVATE',
    payload: {
      venueId: terminal.venue.id,
      venueName: terminal.venue.name,
      venueSlug: terminal.venue.slug,
      venueTimezone: terminal.venue.timezone,
      terminalId: terminal.id,
      terminalName: terminal.name,
      serialNumber: terminal.serialNumber,
    },
    priority: 'HIGH',
    requestedBy: staffId,
    requestedByName: staffName,
    source: 'DASHBOARD',
  })

  logger.info(`Remote activation command queued for terminal ${terminalId}`, {
    commandId: result.commandId,
    correlationId: result.correlationId,
    status: result.status,
  })

  return {
    ...result,
    terminal: {
      id: terminal.id,
      name: terminal.name,
      serialNumber: terminal.serialNumber,
      venue: terminal.venue,
    },
  }
}
