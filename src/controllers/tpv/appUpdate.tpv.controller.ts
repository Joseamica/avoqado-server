// src/controllers/tpv/appUpdate.tpv.controller.ts
import { Request, Response } from 'express'
import { PrismaClient, AppEnvironment } from '@prisma/client'
import logger from '../../config/logger'

const prisma = new PrismaClient()

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
 * - update: { versionName, versionCode, downloadUrl, fileSize, checksum, releaseNotes, isRequired }
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

    // Find the latest active version for this environment
    const latestUpdate = await prisma.appUpdate.findFirst({
      where: {
        environment: env as AppEnvironment,
        isActive: true,
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
        isRequired: true,
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
        isRequired: latestUpdate.isRequired,
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
