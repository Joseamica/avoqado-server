// src/controllers/superadmin/appUpdate.controller.ts
import { Request, Response } from 'express'
import { PrismaClient, AppEnvironment } from '@prisma/client'
import { getStorageBucket } from '../../config/firebase'
import logger from '../../config/logger'
import crypto from 'crypto'
import { extractApkMetadata, validatePackageName } from '../../services/apk-parser.service'

const prisma = new PrismaClient()

/**
 * AppUpdate Controller
 *
 * Manages TPV app updates for the dual update system (Blumon + Avoqado)
 *
 * Flow:
 * 1. Superadmin uploads APK via dashboard
 * 2. APK is stored in Firebase Storage
 * 3. Metadata is stored in PostgreSQL
 * 4. TPV queries /tpv/check-update to get latest version
 * 5. TPV downloads APK from Firebase Storage URL
 */

/**
 * @route   GET /api/v1/dashboard/superadmin/app-updates
 * @desc    List all app updates with optional environment filter
 * @access  Superadmin only
 */
export async function listAppUpdates(req: Request, res: Response) {
  try {
    const { environment } = req.query

    const where: any = {}
    if (environment && ['SANDBOX', 'PRODUCTION'].includes(environment as string)) {
      where.environment = environment as AppEnvironment
    }

    const updates = await prisma.appUpdate.findMany({
      where,
      orderBy: { versionCode: 'desc' },
      include: {
        uploadedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    })

    // Convert BigInt to string for JSON serialization
    const serializedUpdates = updates.map(update => ({
      ...update,
      fileSize: update.fileSize.toString(),
    }))

    return res.json({
      success: true,
      data: serializedUpdates,
    })
  } catch (error) {
    logger.error('Error listing app updates:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to list app updates',
    })
  }
}

/**
 * @route   GET /api/v1/dashboard/superadmin/app-updates/:id
 * @desc    Get app update by ID
 * @access  Superadmin only
 */
export async function getAppUpdateById(req: Request, res: Response) {
  try {
    const { id } = req.params

    const update = await prisma.appUpdate.findUnique({
      where: { id },
      include: {
        uploadedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    })

    if (!update) {
      return res.status(404).json({
        success: false,
        error: 'App update not found',
      })
    }

    return res.json({
      success: true,
      data: {
        ...update,
        fileSize: update.fileSize.toString(),
      },
    })
  } catch (error) {
    logger.error('Error getting app update:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to get app update',
    })
  }
}

/**
 * @route   POST /api/v1/dashboard/superadmin/app-updates
 * @desc    Create new app update (upload APK)
 * @access  Superadmin only
 *
 * Request body:
 * - versionName?: string (e.g., "1.3.0") - Auto-detected from APK if not provided
 * - versionCode?: number (e.g., 6) - Auto-detected from APK if not provided
 * - environment: "SANDBOX" | "PRODUCTION"
 * - releaseNotes?: string (markdown)
 * - isRequired?: boolean
 * - minAndroidSdk?: number (default: auto-detected from APK or 27)
 * - apkBase64: string (base64-encoded APK file)
 */
export async function createAppUpdate(req: Request, res: Response) {
  try {
    const {
      versionName: providedVersionName,
      versionCode: providedVersionCode,
      environment,
      releaseNotes,
      isRequired = false,
      minAndroidSdk: providedMinSdk,
      apkBase64,
    } = req.body

    // Validate required fields (only environment and apkBase64 are required now)
    if (!environment || !apkBase64) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: environment, apkBase64',
      })
    }

    // Validate environment
    if (!['SANDBOX', 'PRODUCTION'].includes(environment)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid environment. Must be SANDBOX or PRODUCTION',
      })
    }

    // Decode base64 APK
    const apkBuffer = Buffer.from(apkBase64, 'base64')
    const fileSize = apkBuffer.length

    // Extract APK metadata for auto-detection
    let apkMetadata
    try {
      apkMetadata = await extractApkMetadata(apkBuffer)
      logger.info(`APK metadata auto-detected: ${JSON.stringify(apkMetadata)}`)
    } catch (apkError) {
      const errorMessage = apkError instanceof Error ? apkError.message : 'Unknown error'
      return res.status(400).json({
        success: false,
        error: `Invalid APK file: ${errorMessage}`,
      })
    }

    // Validate package name matches environment
    const packageValidation = validatePackageName(apkMetadata, environment as 'SANDBOX' | 'PRODUCTION')
    if (!packageValidation.valid) {
      return res.status(400).json({
        success: false,
        error: packageValidation.message,
      })
    }

    // Use provided values or auto-detected values
    const versionCode = providedVersionCode ?? apkMetadata.versionCode
    const versionName = providedVersionName ?? apkMetadata.versionName
    const minAndroidSdk = providedMinSdk ?? apkMetadata.minSdkVersion

    // Warn if provided values don't match APK (but allow it for flexibility)
    const warnings: string[] = []
    if (providedVersionCode !== undefined && providedVersionCode !== apkMetadata.versionCode) {
      warnings.push(
        `Warning: Provided versionCode (${providedVersionCode}) differs from APK (${apkMetadata.versionCode}). Using provided value.`,
      )
      logger.warn(warnings[warnings.length - 1])
    }
    if (providedVersionName !== undefined && providedVersionName !== apkMetadata.versionName) {
      warnings.push(
        `Warning: Provided versionName (${providedVersionName}) differs from APK (${apkMetadata.versionName}). Using provided value.`,
      )
      logger.warn(warnings[warnings.length - 1])
    }

    // Check if version already exists for this environment
    const existing = await prisma.appUpdate.findUnique({
      where: {
        versionCode_environment: {
          versionCode: typeof versionCode === 'string' ? parseInt(versionCode) : versionCode,
          environment: environment as AppEnvironment,
        },
      },
    })

    if (existing) {
      return res.status(409).json({
        success: false,
        error: `Version code ${versionCode} already exists for ${environment} environment`,
      })
    }

    // Calculate SHA-256 checksum
    const checksum = crypto.createHash('sha256').update(apkBuffer).digest('hex')

    // Upload to Firebase Storage
    const storage = getStorageBucket()
    if (!storage) {
      return res.status(500).json({
        success: false,
        error: 'Firebase Storage not configured',
      })
    }

    const bucket = storage.bucket()
    const fileName = `tpv-updates/${environment.toLowerCase()}/avoqado-tpv-${versionName}-${environment.toLowerCase()}.apk`
    const file = bucket.file(fileName)

    await file.save(apkBuffer, {
      metadata: {
        contentType: 'application/vnd.android.package-archive',
        metadata: {
          versionName,
          versionCode: versionCode.toString(),
          environment,
          checksum,
        },
      },
    })

    // Make file publicly accessible (or use signed URLs)
    await file.makePublic()
    const downloadUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`

    // Get uploader ID from authenticated user (using authContext pattern)
    const uploadedById = req.authContext?.userId
    if (!uploadedById) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
      })
    }

    // Ensure versionCode is an integer
    const versionCodeInt = typeof versionCode === 'string' ? parseInt(versionCode) : versionCode

    // Create database record
    const appUpdate = await prisma.appUpdate.create({
      data: {
        versionName,
        versionCode: versionCodeInt,
        environment: environment as AppEnvironment,
        releaseNotes,
        isRequired,
        minAndroidSdk,
        downloadUrl,
        fileSize: BigInt(fileSize),
        checksum,
        uploadedById,
      },
      include: {
        uploadedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    })

    logger.info(`App update created: ${versionName} (${versionCodeInt}) for ${environment} by ${uploadedById}`)

    return res.status(201).json({
      success: true,
      data: {
        ...appUpdate,
        fileSize: appUpdate.fileSize.toString(),
      },
      // Include auto-detection info for transparency
      autoDetected: {
        versionCode: providedVersionCode === undefined,
        versionName: providedVersionName === undefined,
        minAndroidSdk: providedMinSdk === undefined,
        apkMetadata: {
          versionCode: apkMetadata.versionCode,
          versionName: apkMetadata.versionName,
          packageName: apkMetadata.packageName,
          minSdkVersion: apkMetadata.minSdkVersion,
        },
      },
      ...(warnings.length > 0 && { warnings }),
    })
  } catch (error) {
    logger.error('Error creating app update:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to create app update',
    })
  }
}

/**
 * @route   PATCH /api/v1/dashboard/superadmin/app-updates/:id
 * @desc    Update app update metadata (not the APK file)
 * @access  Superadmin only
 */
export async function updateAppUpdate(req: Request, res: Response) {
  try {
    const { id } = req.params
    const { releaseNotes, isRequired, isActive } = req.body

    const existing = await prisma.appUpdate.findUnique({ where: { id } })
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'App update not found',
      })
    }

    const updated = await prisma.appUpdate.update({
      where: { id },
      data: {
        ...(releaseNotes !== undefined && { releaseNotes }),
        ...(isRequired !== undefined && { isRequired }),
        ...(isActive !== undefined && { isActive }),
      },
      include: {
        uploadedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    })

    logger.info(`App update ${id} updated`)

    return res.json({
      success: true,
      data: {
        ...updated,
        fileSize: updated.fileSize.toString(),
      },
    })
  } catch (error) {
    logger.error('Error updating app update:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to update app update',
    })
  }
}

/**
 * @route   DELETE /api/v1/dashboard/superadmin/app-updates/:id
 * @desc    Delete app update and remove APK from storage
 * @access  Superadmin only
 */
export async function deleteAppUpdate(req: Request, res: Response) {
  try {
    const { id } = req.params

    const existing = await prisma.appUpdate.findUnique({ where: { id } })
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'App update not found',
      })
    }

    // Delete from Firebase Storage
    try {
      const storage = getStorageBucket()
      if (storage) {
        const bucket = storage.bucket()
        // Extract file path from URL
        const urlPath = new URL(existing.downloadUrl).pathname
        const fileName = urlPath.split('/').slice(2).join('/') // Remove bucket name prefix
        await bucket.file(fileName).delete()
        logger.info(`Deleted APK from storage: ${fileName}`)
      }
    } catch (storageError) {
      logger.warn('Failed to delete APK from storage (may not exist):', storageError)
      // Continue with database deletion even if storage deletion fails
    }

    // Delete from database
    await prisma.appUpdate.delete({ where: { id } })

    logger.info(`App update ${id} deleted`)

    return res.json({
      success: true,
      message: 'App update deleted successfully',
    })
  } catch (error) {
    logger.error('Error deleting app update:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to delete app update',
    })
  }
}

/**
 * @route   GET /api/v1/dashboard/superadmin/app-updates/latest/:environment
 * @desc    Get latest active app update for environment
 * @access  Superadmin only (for dashboard preview)
 */
export async function getLatestAppUpdate(req: Request, res: Response) {
  try {
    const { environment } = req.params

    if (!['SANDBOX', 'PRODUCTION'].includes(environment.toUpperCase())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid environment. Must be SANDBOX or PRODUCTION',
      })
    }

    const latest = await prisma.appUpdate.findFirst({
      where: {
        environment: environment.toUpperCase() as AppEnvironment,
        isActive: true,
      },
      orderBy: { versionCode: 'desc' },
      include: {
        uploadedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    })

    if (!latest) {
      // Return 200 with null data instead of 404
      // 404 should mean "route doesn't exist", not "no data found"
      return res.json({
        success: true,
        data: null,
        message: `No active updates found for ${environment} environment`,
      })
    }

    return res.json({
      success: true,
      data: {
        ...latest,
        fileSize: latest.fileSize.toString(),
      },
    })
  } catch (error) {
    logger.error('Error getting latest app update:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to get latest app update',
    })
  }
}

/**
 * @route   POST /api/v1/dashboard/superadmin/app-updates/preview
 * @desc    Preview APK metadata without uploading (for auto-fill form)
 * @access  Superadmin only
 *
 * Request body:
 * - apkBase64: string (base64-encoded APK file)
 *
 * Returns extracted metadata from AndroidManifest.xml
 */
export async function previewApkMetadata(req: Request, res: Response) {
  try {
    const { apkBase64 } = req.body

    if (!apkBase64) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: apkBase64',
      })
    }

    // Decode base64 APK
    const apkBuffer = Buffer.from(apkBase64, 'base64')

    // Extract metadata
    const metadata = await extractApkMetadata(apkBuffer)

    logger.info(`APK preview: ${metadata.packageName} v${metadata.versionName} (${metadata.versionCode})`)

    return res.json({
      success: true,
      data: {
        versionCode: metadata.versionCode,
        versionName: metadata.versionName,
        packageName: metadata.packageName,
        minSdkVersion: metadata.minSdkVersion,
        // Helper to determine environment based on package name
        detectedEnvironment:
          metadata.packageName === 'com.jaac.avoqado_tpv.sandbox'
            ? 'SANDBOX'
            : metadata.packageName === 'com.jaac.avoqado_tpv'
              ? 'PRODUCTION'
              : null,
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Error previewing APK metadata:', error)
    return res.status(400).json({
      success: false,
      error: errorMessage,
    })
  }
}
