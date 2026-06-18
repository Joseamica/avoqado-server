// src/controllers/tpv/appUpdate.tpv.controller.ts
import { Request, Response } from 'express'
import { AppEnvironment, AppPlatform } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { buildAudienceConditions } from '../../services/appUpdate/audienceTargeting'

/**
 * TPV App Update Controller
 *
 * Endpoint for Android TPV to check for updates from Avoqado backend
 * (independent of Blumon provider updates)
 *
 * This is part of the dual update system:
 * - Blumon: Provider-managed updates (via CheckVersionUseCase in SDK)
 * - Avoqado: Self-managed updates (via this endpoint)
 */

/**
 * @route   GET /api/v1/tpv/check-update
 * @desc    Check if there's a newer version available
 * @access  Public (no auth required - called before login)
 *
 * Query params:
 * - currentVersion: number (versionCode, e.g., 6)
 * - environment: "SANDBOX" | "PRODUCTION"
 *
 * Response:
 * - hasUpdate: boolean
 * - update: { versionName, versionCode, downloadUrl, fileSize, checksum, releaseNotes, updateMode }
 *   - updateMode: "NONE" | "BANNER" | "FORCE"
 */
export async function checkForUpdate(req: Request, res: Response) {
  try {
    const { currentVersion, environment } = req.query

    // Validate parameters
    if (!currentVersion || !environment) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: currentVersion, environment',
      })
    }

    const versionCode = parseInt(currentVersion as string)
    if (isNaN(versionCode) || versionCode < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid currentVersion: must be a positive integer',
      })
    }

    const env = (environment as string).toUpperCase()
    if (!['SANDBOX', 'PRODUCTION'].includes(env)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid environment: must be SANDBOX or PRODUCTION',
      })
    }

    // Optional platform (new clients only). Old TPV APKs don't send it →
    // default ANDROID_TPV preserves their behavior exactly.
    const platformParam = ((req.query.platform as string) || 'ANDROID_TPV').toUpperCase()
    if (!['ANDROID_TPV', 'WINDOWS_DESKTOP'].includes(platformParam)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid platform: must be ANDROID_TPV or WINDOWS_DESKTOP',
      })
    }

    // ── Audience targeting ──────────────────────────────────────────────────
    // Resolve which targeted versions apply to THIS terminal:
    //  • ALL       → every terminal (default — today's behavior)
    //  • VENUES    → only if the terminal reports a venue (X-Venue-Id) that's in the list
    //  • TERMINALS → only if we can identify the terminal serial (X-Terminal-Serial) and
    //                it's in the list. INERT until the APK starts sending its serial.
    // An unknown/unactivated terminal only ever matches ALL rows → fail-safe: it can never
    // receive a build scoped to a venue/terminal it doesn't belong to.
    const venueIdHeader = (req.headers['x-venue-id'] as string | undefined)?.trim() || undefined
    const terminalSerialHeader = (req.headers['x-terminal-serial'] as string | undefined)?.trim() || undefined

    let terminalId: string | undefined
    if (terminalSerialHeader) {
      const terminal = await prisma.terminal.findFirst({
        where: { serialNumber: { equals: terminalSerialHeader, mode: 'insensitive' } },
        select: { id: true },
      })
      terminalId = terminal?.id
    }

    const audienceConditions = buildAudienceConditions(venueIdHeader, terminalId)

    // Find the latest active version for this environment + platform that targets this terminal
    const latestUpdate = await prisma.appUpdate.findFirst({
      where: {
        environment: env as AppEnvironment,
        platform: platformParam as AppPlatform,
        isActive: true,
        OR: audienceConditions,
      },
      orderBy: { versionCode: 'desc' },
      select: {
        id: true,
        versionName: true,
        versionCode: true,
        downloadUrl: true,
        fileSize: true,
        checksum: true,
        releaseNotes: true,
        updateMode: true,
        minAndroidSdk: true,
        createdAt: true,
      },
    })

    // No update available
    if (!latestUpdate) {
      logger.debug(`No updates available for ${env} environment`)
      return res.json({
        success: true,
        hasUpdate: false,
        message: 'No updates available',
      })
    }

    // Check if newer version exists
    if (latestUpdate.versionCode <= versionCode) {
      logger.debug(`TPV is up to date: current=${versionCode}, latest=${latestUpdate.versionCode}`)
      return res.json({
        success: true,
        hasUpdate: false,
        message: 'You are on the latest version',
        currentVersion: versionCode,
        latestVersion: latestUpdate.versionCode,
      })
    }

    // Update available
    logger.info(`Update available for TPV: ${versionCode} -> ${latestUpdate.versionCode} (${env})`)

    return res.json({
      success: true,
      hasUpdate: true,
      update: {
        id: latestUpdate.id,
        versionName: latestUpdate.versionName,
        versionCode: latestUpdate.versionCode,
        downloadUrl: latestUpdate.downloadUrl,
        fileSize: latestUpdate.fileSize.toString(), // Convert BigInt to string for JSON
        checksum: latestUpdate.checksum,
        releaseNotes: latestUpdate.releaseNotes,
        updateMode: latestUpdate.updateMode, // NONE, BANNER, or FORCE
        minAndroidSdk: latestUpdate.minAndroidSdk,
        publishedAt: latestUpdate.createdAt.toISOString(),
      },
    })
  } catch (error) {
    logger.error('Error checking for TPV update:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to check for updates',
    })
  }
}

/**
 * @route   GET /api/v1/tpv/get-version
 * @desc    Get a specific version by versionCode (for INSTALL_VERSION command)
 * @access  Authenticated (requires valid token)
 *
 * Query params:
 * - versionCode: number (e.g., 5)
 * - environment: "SANDBOX" | "PRODUCTION"
 *
 * Response:
 * - found: boolean
 * - version: { versionName, versionCode, downloadUrl, fileSize, checksum, releaseNotes }
 */
export async function getSpecificVersion(req: Request, res: Response) {
  try {
    const { versionCode, environment } = req.query

    // Validate parameters
    if (!versionCode || !environment) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: versionCode, environment',
      })
    }

    const targetVersionCode = parseInt(versionCode as string)
    if (isNaN(targetVersionCode) || targetVersionCode < 1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid versionCode: must be a positive integer',
      })
    }

    const env = (environment as string).toUpperCase()
    if (!['SANDBOX', 'PRODUCTION'].includes(env)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid environment: must be SANDBOX or PRODUCTION',
      })
    }

    // Find the specific version
    const update = await prisma.appUpdate.findUnique({
      where: {
        versionCode_environment: {
          versionCode: targetVersionCode,
          environment: env as AppEnvironment,
        },
      },
      select: {
        id: true,
        versionName: true,
        versionCode: true,
        downloadUrl: true,
        fileSize: true,
        checksum: true,
        releaseNotes: true,
        updateMode: true,
        isActive: true,
        minAndroidSdk: true,
        createdAt: true,
      },
    })

    if (!update) {
      logger.warn(`Version ${targetVersionCode} not found for ${env}`)
      return res.json({
        success: true,
        found: false,
        message: `Version ${targetVersionCode} not found for ${env} environment`,
      })
    }

    if (!update.isActive) {
      logger.warn(`Version ${targetVersionCode} is not active for ${env}`)
      return res.json({
        success: true,
        found: false,
        message: `Version ${targetVersionCode} is not active`,
      })
    }

    logger.info(`Returning specific version: ${update.versionCode} (${env})`)

    return res.json({
      success: true,
      found: true,
      version: {
        id: update.id,
        versionName: update.versionName,
        versionCode: update.versionCode,
        downloadUrl: update.downloadUrl,
        fileSize: update.fileSize.toString(),
        checksum: update.checksum,
        releaseNotes: update.releaseNotes,
        updateMode: update.updateMode,
        minAndroidSdk: update.minAndroidSdk,
        publishedAt: update.createdAt.toISOString(),
      },
    })
  } catch (error) {
    logger.error('Error getting specific version:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to get version',
    })
  }
}

/**
 * @route   POST /api/v1/tpv/report-update-installed
 * @desc    Report that an update was successfully installed (for analytics)
 * @access  Authenticated (called after successful update and login)
 *
 * Body:
 * - versionCode: number
 * - versionName: string
 * - updateSource: "AVOQADO" | "BLUMON"
 * - serialNumber: string
 */
export async function reportUpdateInstalled(req: Request, res: Response) {
  try {
    const { versionCode, versionName, updateSource, serialNumber } = req.body

    // Just log for now - can be expanded to track update adoption
    logger.info(`Update installed: ${serialNumber} -> ${versionName} (${versionCode}) via ${updateSource}`)

    // Optionally update terminal record with new version
    if (serialNumber) {
      await prisma.terminal.updateMany({
        where: { serialNumber },
        data: { version: versionName },
      })
    }

    return res.json({
      success: true,
      message: 'Update installation reported',
    })
  } catch (error) {
    logger.error('Error reporting update installed:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to report update installation',
    })
  }
}

/**
 * Report an APK install attempt (success or failure) for diagnostics.
 *
 * Called by TPV after every install attempt so we can monitor install
 * success rates and alert on failures in production.
 *
 * Body:
 * - versionName: string
 * - serialNumber: string | null
 * - success: boolean
 * - strategy: "PACKAGE_INSTALLER" | "PAX_SDK" | "BOTH_FAILED" | "EXCEPTION"
 * - errorMessage: string | null
 * - androidVersion: number
 * - durationMs: number
 * - updateSource: "AVOQADO" | "BLUMON"
 * - deviceModel: string
 * - packageName: string
 */
export async function reportInstallAttempt(req: Request, res: Response) {
  try {
    const { versionName, serialNumber, success, strategy, errorMessage, androidVersion, durationMs, deviceModel } = req.body

    if (success) {
      logger.info(
        `[InstallAttempt] SUCCESS: ${serialNumber ?? 'unknown'} → ${versionName} via ${strategy} (${durationMs}ms, Android ${androidVersion}, ${deviceModel})`,
      )
    } else {
      logger.error(
        `[InstallAttempt] FAILED: ${serialNumber ?? 'unknown'} → ${versionName} via ${strategy} (${durationMs}ms, Android ${androidVersion}, ${deviceModel}) — ${errorMessage}`,
      )
    }

    return res.json({
      success: true,
      message: 'Install attempt reported',
    })
  } catch (error) {
    logger.error('Error reporting install attempt:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to report install attempt',
    })
  }
}
