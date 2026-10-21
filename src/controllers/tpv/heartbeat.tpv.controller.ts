import { NextFunction, Request, Response } from 'express'
import { HeartbeatData, tpvHealthService } from '../../services/tpv/tpv-health.service'
import { issueCommandCredential, resolveCommandTerminal } from '../../services/tpv/command-credential.service'
import { UnauthorizedError, ForbiddenError } from '../../errors/AppError'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { terminalRegistry } from '../../communication/sockets/terminal-registry'
import { heartbeatSchema } from '../../schemas/tpv.schema'
import { buildAudienceConditions } from '../../services/appUpdate/audienceTargeting'
import { AppEnvironment, UpdateMode } from '@prisma/client'

/**
 * Calculate config version for a terminal's merchant configuration
 * Part of the 3-layer cache invalidation strategy (Layer 2: PULL via heartbeat)
 *
 * Version is based on:
 * - Number of effective merchants (from assignedMerchantIds OR payment config inheritance)
 * - Most recent updatedAt timestamp of any merchant OR payment config
 *
 * This allows Android to compare its cached config version with the server's
 * and refresh if they don't match (handles missed Socket.IO events)
 */
async function getMerchantConfigVersion(terminalId: string): Promise<string | null> {
  try {
    // Find terminal with venue info for inheritance fallback
    const terminal = await prisma.terminal.findFirst({
      where: {
        OR: [
          { id: terminalId },
          { serialNumber: { equals: terminalId, mode: 'insensitive' } },
          { serialNumber: { equals: `AVQD-${terminalId}`, mode: 'insensitive' } },
        ],
      },
      select: {
        assignedMerchantIds: true,
        venueId: true,
      },
    })

    if (!terminal) {
      return null
    }

    let merchantIds: string[] = terminal.assignedMerchantIds

    // If no explicit assignments, resolve from payment config inheritance
    if (merchantIds.length === 0 && terminal.venueId) {
      // Check venue payment config first, then org
      const venueConfig = await prisma.venuePaymentConfig.findUnique({
        where: { venueId: terminal.venueId },
        select: { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true, updatedAt: true },
      })

      if (venueConfig) {
        merchantIds = [venueConfig.primaryAccountId, venueConfig.secondaryAccountId, venueConfig.tertiaryAccountId].filter(
          Boolean,
        ) as string[]
      } else {
        // Check org config
        const venue = await prisma.venue.findUnique({
          where: { id: terminal.venueId },
          select: { organizationId: true },
        })
        if (venue?.organizationId) {
          const orgConfig = await prisma.organizationPaymentConfig.findUnique({
            where: { organizationId: venue.organizationId },
            select: { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true, updatedAt: true },
          })
          if (orgConfig) {
            merchantIds = [orgConfig.primaryAccountId, orgConfig.secondaryAccountId, orgConfig.tertiaryAccountId].filter(
              Boolean,
            ) as string[]
          }
        }
      }
    }

    if (merchantIds.length === 0) {
      return null
    }

    // Get the latest updatedAt from all resolved merchants
    const merchants = await prisma.merchantAccount.findMany({
      where: { id: { in: merchantIds } },
      select: { id: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 1,
    })

    if (merchants.length === 0) {
      return null
    }

    // Also factor in payment config updatedAt for change detection
    let latestTimestamp = merchants[0].updatedAt.getTime()

    if (terminal.venueId) {
      const venueConfig = await prisma.venuePaymentConfig.findUnique({
        where: { venueId: terminal.venueId },
        select: { updatedAt: true },
      })
      if (venueConfig) {
        latestTimestamp = Math.max(latestTimestamp, venueConfig.updatedAt.getTime())
      }
    }

    // Version format: "{count}-{latestTimestamp}"
    return `${merchantIds.length}-${latestTimestamp}`
  } catch (error) {
    logger.error('Failed to calculate merchant config version', {
      terminalId,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null // Non-blocking - return null if calculation fails
  }
}

/**
 * Check for forced updates that the terminal must install
 *
 * **Backend Enforcement Pattern:**
 * This is the "cannot bypass" enforcement mechanism. Unlike the initial update check
 * which the user can dismiss, this is included in EVERY heartbeat response.
 *
 * The terminal receives this every 30 seconds and MUST show the ForceUpdateDialog
 * until the update is installed.
 *
 * @param currentVersion The terminal's current version string (e.g., "1.4.1-sandbox" or "1.4.1")
 * @param currentVersionCode The terminal's current version code (e.g., 15)
 * @returns Force update info if one exists, null otherwise
 */
async function checkForForcedUpdate(
  currentVersion: string | undefined,
  currentVersionCode: number | undefined,
  terminal?: { id: string; venueId: string },
): Promise<{
  versionName: string
  versionCode: number
  downloadUrl: string
  releaseNotes: string | null
  updateMode: string
} | null> {
  try {
    // Determine environment from version string
    // Sandbox versions end with "-sandbox" (e.g., "1.4.1-sandbox")
    // Production versions have no suffix (e.g., "1.4.1")
    const isSandbox = currentVersion?.toLowerCase().includes('sandbox') ?? true // Default to sandbox for safety
    const environment: AppEnvironment = isSandbox ? 'SANDBOX' : 'PRODUCTION'

    // Get current version code (try from param, then parse from version string)
    // Version code is more reliable for comparison than version name
    const versionCode = currentVersionCode ?? 0

    // Find the latest active FORCE update for this environment
    const forceUpdate = await prisma.appUpdate.findFirst({
      where: {
        environment,
        platform: 'ANDROID_TPV',
        OR: buildAudienceConditions(terminal?.venueId, terminal?.id),
        isActive: true,
        updateMode: UpdateMode.FORCE,
        versionCode: { gt: versionCode }, // Only if newer than current version
      },
      orderBy: { versionCode: 'desc' },
      select: {
        versionName: true,
        versionCode: true,
        downloadUrl: true,
        releaseNotes: true,
        updateMode: true,
      },
    })

    if (!forceUpdate) {
      return null
    }

    logger.info(`🚨 [Heartbeat] FORCE update required: ${versionCode} → ${forceUpdate.versionCode} (${environment})`)

    return {
      versionName: forceUpdate.versionName,
      versionCode: forceUpdate.versionCode,
      downloadUrl: forceUpdate.downloadUrl,
      releaseNotes: forceUpdate.releaseNotes,
      updateMode: forceUpdate.updateMode,
    }
  } catch (error) {
    logger.error('Failed to check for forced update', {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
    return null // Non-blocking - return null if check fails
  }
}

/**
 * Resolve the terminal's own IP rather than the CDN edge it came through.
 *
 * `app.set('trust proxy', 1)` (src/config/middleware.ts) unwraps a single hop,
 * but production sits behind Cloudflare in front of the host proxy — so `req.ip`
 * resolves to a Cloudflare address (172.64.x / 172.71.x) that is identical for
 * every terminal in the fleet and therefore useless for locating a device.
 *
 * `CF-Connecting-IP` is set by Cloudflare itself and is the trustworthy value
 * here; a client-supplied header cannot survive the edge. `X-Forwarded-For` is
 * a comma-separated chain whose FIRST entry is the original client. Both are
 * spoofable if a request ever reaches the app without passing the edge, so this
 * is used for diagnostics only — never for auth or rate limiting.
 */
function resolveClientIp(req: Request<any, any, any>): string | undefined {
  const cfConnectingIp = req.headers['cf-connecting-ip']
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) return cfConnectingIp.trim()

  const forwardedFor = req.headers['x-forwarded-for']
  const forwardedChain = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor
  const originClient = forwardedChain?.split(',')[0]?.trim()
  if (originClient) return originClient

  return req.ip || req.socket.remoteAddress
}

/**
 * Process heartbeat from TPV terminal (unauthenticated endpoint)
 * This allows terminals to report status even when authentication fails
 * and returns server status for synchronization
 */
export async function processHeartbeat(req: Request<{}, {}, HeartbeatData>, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = heartbeatSchema.safeParse({ body: req.body })
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Datos de heartbeat inválidos', errors: parsed.error.issues })
      return
    }
    const heartbeatData = parsed.data.body
    let updateTerminal: { id: string; venueId: string; brand?: string | null } | undefined
    const clientIp = resolveClientIp(req)

    logger.debug(`Heartbeat received from terminal ${heartbeatData.terminalId}`, {
      terminalId: heartbeatData.terminalId,
      status: heartbeatData.status,
      ip: clientIp,
    })

    // Process the heartbeat using the existing service
    await tpvHealthService.processHeartbeat(heartbeatData, clientIp)

    // Register terminal in the terminal registry (for Socket.IO payment routing)
    // HTTP heartbeat doesn't have socketId, but we register anyway so the terminal
    // appears in GET /terminals/online. The socketId will be filled when the
    // Socket.IO heartbeat fires, or resolved at payment time.
    try {
      const terminal = await prisma.terminal.findFirst({
        where: {
          OR: [
            { serialNumber: { equals: heartbeatData.terminalId, mode: 'insensitive' } },
            { serialNumber: { equals: `AVQD-${heartbeatData.terminalId}`, mode: 'insensitive' } },
            { id: heartbeatData.terminalId },
          ],
        },
        select: { id: true, venueId: true, name: true, brand: true },
      })
      if (terminal) {
        updateTerminal = terminal
        terminalRegistry.register(heartbeatData.terminalId, null, terminal.venueId, terminal.name || undefined)
        logger.debug(`📡 [HTTP-Heartbeat] Terminal registered: ${heartbeatData.terminalId} (venue: ${terminal.venueId})`)
      }
    } catch (regError) {
      logger.warn(`Failed to register terminal in registry: ${regError}`)
    }

    // Get current server status for the terminal to enable synchronization
    const terminalHealth = await tpvHealthService.getTerminalHealth(heartbeatData.terminalId)

    // Get pending commands for this terminal (Square Terminal API polling pattern)
    // This delivers commands via HTTP instead of requiring socket connection
    const commandTerminal = await resolveCommandTerminal(req, heartbeatData.terminalId)
    const pendingCommands =
      commandTerminal && (commandTerminal.commandProtocolVersion ?? 0) < 2
        ? await tpvHealthService.getPendingCommands(commandTerminal.id)
        : []

    // Layer 2 of 3-layer cache invalidation: Include config version in heartbeat response
    // Android compares this with its cached version and refreshes if they don't match
    // This catches missed Socket.IO events (Layer 1) when terminal was offline
    const configVersion = await getMerchantConfigVersion(heartbeatData.terminalId)

    // 🚨 Backend Enforcement: Check for forced updates that cannot be bypassed
    // This is included in EVERY heartbeat response. Terminal must show ForceUpdateDialog
    // until the update is installed. User cannot dismiss or ignore this.
    const versionCode = heartbeatData.systemInfo?.versionCode as number | undefined
    const forceUpdate =
      req.headers['x-tpv-processor'] === 'NEXGO' || updateTerminal?.brand?.toUpperCase().includes('NEXGO')
        ? null
        : await checkForForcedUpdate(heartbeatData.version, versionCode, updateTerminal)

    logger.debug(`Heartbeat processed, server status: ${terminalHealth.status}`, {
      terminalId: heartbeatData.terminalId,
      clientReported: heartbeatData.status,
      serverStatus: terminalHealth.status,
      pendingCommandsCount: pendingCommands.length,
      configVersion,
      forceUpdate: forceUpdate ? `v${forceUpdate.versionCode}` : null,
    })

    res.status(200).json({
      success: true,
      message: 'Heartbeat processed successfully',
      serverStatus: terminalHealth.status, // This allows Android to sync its local state
      timestamp: new Date().toISOString(),
      // Square/Toast pattern: Include pending commands in heartbeat response
      // Terminal doesn't need socket connection to receive commands
      pendingCommands: pendingCommands.length > 0 ? pendingCommands : undefined,
      // Layer 2 of 3-layer cache invalidation: Config version for merchant sync
      // Format: "{count}-{latestTimestamp}" e.g. "2-1701532800000"
      // Android should refresh merchant config if this doesn't match local cached version
      configVersion: configVersion || undefined,
      // 🚨 Backend Enforcement: Force update that cannot be bypassed
      // Terminal MUST install this update. Included in every heartbeat until installed.
      forceUpdate: forceUpdate || undefined,
    })
  } catch (error) {
    logger.error(`Failed to process unauthenticated heartbeat:`, error)
    next(error)
  }
}

/**
 * Acknowledge command execution from TPV terminal
 * Called by terminal after processing a command received via heartbeat
 *
 * **Security: Terminal Ownership Validation**
 * The terminal must provide its serialNumber (terminalId) in the request.
 * The service validates that the command belongs to that terminal before processing.
 * This prevents attackers from spoofing ACKs for commands they don't own.
 */
export async function acknowledgeCommand(
  req: Request<{}, {}, { commandId: string; terminalId: string; resultStatus: string; resultMessage?: string; resultPayload?: any }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { commandId, terminalId, resultStatus, resultMessage, resultPayload } = req.body

    // Validate required fields
    if (!commandId || !resultStatus) {
      res.status(400).json({
        success: false,
        error: 'commandId and resultStatus are required',
      })
      return
    }

    // Security: Require terminalId to validate ownership
    if (!terminalId) {
      res.status(400).json({
        success: false,
        error: 'terminalId is required for security validation',
      })
      return
    }

    const validStatuses = ['SUCCESS', 'FAILED', 'REJECTED', 'TIMEOUT']
    if (!validStatuses.includes(resultStatus)) {
      res.status(400).json({
        success: false,
        error: `Invalid resultStatus. Must be one of: ${validStatuses.join(', ')}`,
      })
      return
    }

    logger.info(`Command ACK received: ${commandId} - ${resultStatus}`, {
      commandId,
      terminalId,
      resultStatus,
      resultMessage,
    })

    // Service validates terminal ownership before processing
    const commandTerminal = await resolveCommandTerminal(req, terminalId)
    if (!commandTerminal)
      throw new UnauthorizedError('La terminal debe autenticar la confirmación del comando', 'TPV_COMMAND_AUTH_REQUIRED')

    await tpvHealthService.acknowledgeCommand(
      commandId,
      terminalId,
      resultStatus as 'SUCCESS' | 'FAILED' | 'REJECTED' | 'TIMEOUT',
      resultMessage,
      resultPayload,
    )

    res.status(200).json({
      success: true,
      message: 'Command acknowledgment processed',
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error(`Failed to acknowledge command:`, error)
    next(error)
  }
}

/**
 * Get current terminal status from server for synchronization
 * This allows terminals to sync their local state with server state when reconnecting
 */
export async function getTerminalStatus(req: Request<{ serialNumber: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { serialNumber } = req.params

    logger.info(`Status sync requested for terminal ${serialNumber}`)

    // Get current server status for the terminal
    const terminalHealth = await tpvHealthService.getTerminalHealth(serialNumber)

    if (!terminalHealth) {
      logger.warn(`Terminal not found for status sync: ${serialNumber}`)
      res.status(404).json({
        success: false,
        error: 'Terminal not found',
      })
      return
    }

    logger.info(`Returning server status for terminal ${serialNumber}: ${terminalHealth.status}`)

    res.status(200).json({
      success: true,
      status: terminalHealth.status,
      message: `Terminal status: ${terminalHealth.status}`,
      lastSeen: terminalHealth.lastSeen,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error(`Failed to get terminal status for ${req.params.serialNumber}:`, error)
    next(error)
  }
}

/** Provision existing APKs once after authenticated TPV login; never from serial alone. */
export async function provisionCommandCredential(req: Request, res: Response, next: NextFunction) {
  try {
    const identifier = req.body?.terminalId
    if (typeof identifier !== 'string' || !identifier.trim()) {
      res.status(400).json({ message: 'El terminalId es requerido' })
      return
    }
    const terminal = await resolveCommandTerminal(req, identifier, true)
    if (!terminal) throw new ForbiddenError('La sesión no pertenece a esta terminal')
    res.json({
      commandToken: await issueCommandCredential(
        terminal.id,
        typeof req.headers['x-tpv-command-token'] === 'string' ? req.headers['x-tpv-command-token'] : undefined,
      ),
    })
  } catch (error) {
    next(error)
  }
}

/** A bounded, event-triggered pull. Called on safe foreground/reconnect or a socket hint. */
export async function commandsReady(req: Request, res: Response, next: NextFunction) {
  try {
    const identifier = req.body?.terminalId
    if (typeof identifier !== 'string' || !identifier.trim()) {
      res.status(400).json({ message: 'El terminalId es requerido' })
      return
    }
    const terminal = await resolveCommandTerminal(req, identifier)
    if (!terminal) throw new UnauthorizedError('La terminal debe autenticar la entrega de comandos', 'TPV_COMMAND_AUTH_REQUIRED')
    const sessionId = req.body?.sessionId
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
      res.status(400).json({ message: 'La sesión de la app es requerida' })
      return
    }
    if (terminal.commandProtocolVersion !== 2 || terminal.commandSessionId !== sessionId) {
      await prisma.terminal.update({ where: { id: terminal.id }, data: { commandProtocolVersion: 2, commandSessionId: sessionId } })
    }
    res.json({ pendingCommands: await tpvHealthService.getPendingCommands(terminal.id, true) })
  } catch (error) {
    next(error)
  }
}

/** One permit per execution, never a polling loop. Cancelled/expired work cannot run later. */
export async function permitCommand(req: Request, res: Response, next: NextFunction) {
  try {
    const { terminalId, commandId, sessionId } = req.body ?? {}
    if (typeof terminalId !== 'string' || !terminalId || typeof commandId !== 'string' || !commandId) {
      res.status(400).json({ message: 'Terminal y comando requeridos' })
      return
    }
    const terminal = await resolveCommandTerminal(req, terminalId)
    if (!terminal) throw new UnauthorizedError('Identidad de terminal requerida')
    const { tpvCommandQueueService } = await import('../../services/tpv/command-queue.service')
    if (typeof sessionId !== 'string' || sessionId !== terminal.commandSessionId) {
      res.status(409).json({ permitted: false, message: 'La sesión de la app cambió' })
      return
    }
    const permitted = await tpvCommandQueueService.updateCommandStatus(commandId, 'EXECUTING', undefined, undefined, terminal.id, {
      executionSessionId: sessionId,
    })
    res.status(permitted ? 200 : 409).json({ permitted, message: permitted ? 'Comando autorizado' : 'El comando ya no está pendiente' })
  } catch (error) {
    next(error)
  }
}
