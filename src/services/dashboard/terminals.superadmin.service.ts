import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, IncompatibleDeviceError, NotFoundError, TerminalBrandChangeBlocked } from '../../errors/AppError'
import { generateActivationCode as generateActivationCodeUtil } from './terminal-activation.service'
import { notifyAffectedTerminals } from '../superadmin/merchantAccount.service'
import { tpvCommandQueueService } from '../tpv/command-queue.service'
import { updateTpvSettings, type TpvSettings } from './tpv.dashboard.service'
import { assertMerchantsTerminalCompatible, isProviderCompatibleWithBrand } from '../../lib/providerDeviceCompatibility'

/**
 * Get All Terminals (Cross-Venue)
 *
 * Returns all terminals across all venues with optional filters.
 * Used by superadmin dashboard.
 *
 * @param filters Optional filters: venueId, status, type
 * @returns List of terminals with venue info
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

  logger.info(`Fetched ${terminals.length} terminals`)

  return terminals
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
        throw new IncompatibleDeviceError(
          `Cannot assign incompatible merchants to ${data.brand} terminal: ${summary}`,
        )
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
    logger.info(
      `Moving terminal ${terminalId} from venue ${terminal.venueId} → ${data.venueId} (clearing assignedMerchantIds)`,
    )
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

      const incompatible = assignedMerchants.filter(
        m => !isProviderCompatibleWithBrand(m.provider.code, data.brand!),
      )

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

        return await prisma.$transaction(async tx => {
          const updated = await tx.terminal.update({
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
          logger.info(
            `Terminal ${terminalId} brand changed atomically with merchant pruning`,
          )
          return updated
        })
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
      // Task 54: clear assignedMerchantIds on venue change (cross-tenant
      // assignments are never valid). When venue isn't changing, defer to
      // explicit `assignedMerchantIds` from the caller.
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
export async function deleteTerminal(terminalId: string) {
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
