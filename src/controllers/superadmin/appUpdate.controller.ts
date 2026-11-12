// src/controllers/superadmin/appUpdate.controller.ts
import { Request, Response } from 'express'
import { AppEnvironment, AppPlatform, UpdateMode } from '@prisma/client'
import { getStorageBucket } from '../../config/firebase'
import logger from '../../config/logger'
import crypto from 'crypto'
import { ambienteDeCampo, extractApkMetadata, PAQUETE_DE_CAMPO, validatePackageName } from '../../services/apk-parser.service'
import { HUELLA_DE_FIRMA_DE_CAMPO, huellaDelCertificadoDeclarado } from '../../services/apk/certificadoDeclarado'
import prisma from '../../utils/prismaClient'
import {
  normalizeTargeting,
  esObligatoriaDirigida,
  OBLIGATORIA_SOLO_PARA_TODAS,
  type AppUpdateTargetTypeValue,
} from '../../services/appUpdate/audienceTargeting'

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
    const { environment, platform } = req.query

    // Sin plataforma: sólo la TPV, como siempre («Instalar versión» de una terminal identifica la versión por su código,
    // que ahora se repite entre carriles). El panel de versiones pide la de campo explícitamente.
    const where: any = { platform: (platform as AppPlatform | undefined) ?? 'ANDROID_TPV' }
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
 * - updateMode?: "NONE" | "BANNER" | "FORCE" (default: "NONE")
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
      updateMode = 'NONE',
      minAndroidSdk: providedMinSdk,
      apkBase64,
      platform = 'ANDROID_TPV',
    } = req.body
    const esCampo = platform === 'ANDROID_CAMPO'

    // Modo y alcance se validan ANTES de leer y subir el APK: un alta rechazada después de subir reemplazaba el archivo del
    // mismo nombre que ya estaba publicado (Codex, apps viejas r4).
    const validUpdateModes = ['NONE', 'BANNER', 'FORCE']
    if (!validUpdateModes.includes(updateMode)) {
      return res.status(400).json({
        success: false,
        error: `Invalid updateMode. Must be one of: ${validUpdateModes.join(', ')}`,
      })
    }
    // Validate + normalize audience targeting (defaults to ALL = every terminal)
    // La app de campo no reporta sucursal ni serie al buscar versiones: una fila VENUES/TERMINALS nunca le llegaría.
    // Su carril es siempre para todos los celulares.
    const targeting = esCampo
      ? { targetType: 'ALL' as const, targetVenueIds: [] as string[], targetTerminalIds: [] as string[] }
      : normalizeTargeting(req.body)
    if ('error' in targeting) {
      return res.status(400).json({ success: false, error: targeting.error })
    }
    if (esObligatoriaDirigida(updateMode, targeting.targetType)) {
      return res.status(400).json({ success: false, error: OBLIGATORIA_SOLO_PARA_TODAS, message: OBLIGATORIA_SOLO_PARA_TODAS })
    }

    // DEBUG: Log what we received
    logger.info(`📥 Received updateMode from request: ${req.body.updateMode}`)
    logger.info(`📥 updateMode after destructuring (with default): ${updateMode}`)

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
    const packageValidation = validatePackageName(
      apkMetadata,
      environment as 'SANDBOX' | 'PRODUCTION',
      esCampo ? 'ANDROID_CAMPO' : 'ANDROID_TPV',
    )
    if (!packageValidation.valid) {
      return res.status(400).json({
        success: false,
        error: packageValidation.message,
      })
    }

    if (esCampo) {
      // El celular compara el versionCode anunciado con el del APK: si no coinciden, pediría la misma versión para siempre.
      const distinto =
        (providedVersionCode !== undefined && Number(providedVersionCode) !== apkMetadata.versionCode) ||
        (providedVersionName !== undefined && providedVersionName !== apkMetadata.versionName)
      if (distinto) {
        return res.status(400).json({
          success: false,
          error: `En la app de campo la versión es la del APK (${apkMetadata.versionName}, código ${apkMetadata.versionCode}); no se puede cambiar`,
        })
      }
      // Freno de accidentes (no es verificación criptográfica, ver certificadoDeclarado.ts): un APK de producción con otra
      // llave dejaría a los celulares nuevos con una firma que nunca podrá actualizarse.
      if (environment === 'PRODUCTION' && huellaDelCertificadoDeclarado(apkBuffer) !== HUELLA_DE_FIRMA_DE_CAMPO) {
        return res.status(400).json({
          success: false,
          error: 'El APK no está firmado con la llave de la app de campo (súbelo desde el release firmado de GitHub)',
        })
      }
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
        versionCode_environment_platform: {
          versionCode: typeof versionCode === 'string' ? parseInt(versionCode) : versionCode,
          environment: environment as AppEnvironment,
          platform: esCampo ? 'ANDROID_CAMPO' : 'ANDROID_TPV',
        },
      },
    })

    if (existing) {
      return res.status(409).json({
        success: false,
        error: `Version code ${versionCode} already exists for ${environment} environment (${platform})`,
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
    // Campo: el nombre lleva el inicio del SHA-256, así que dos altas simultáneas de builds distintos nunca escriben el mismo
    // archivo (la que pierde el INSERT deja su archivo huérfano, pero la fila ganadora siempre apunta a SUS bytes).
    const fileName = esCampo
      ? `campo-updates/${environment.toLowerCase()}/avoqado-campo-${versionName}-${versionCode}-${checksum.slice(0, 12)}.apk`
      : `tpv-updates/${environment.toLowerCase()}/avoqado-tpv-${versionName}-${environment.toLowerCase()}.apk`
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

    // Create database record (la llave única resuelve dos altas simultáneas: la que pierde es 409, no 500)
    const appUpdate = await prisma.appUpdate.create({
      data: {
        versionName,
        versionCode: versionCodeInt,
        environment: environment as AppEnvironment,
        platform: esCampo ? 'ANDROID_CAMPO' : 'ANDROID_TPV',
        releaseNotes,
        updateMode: updateMode as UpdateMode,
        minAndroidSdk,
        downloadUrl,
        fileSize: BigInt(fileSize),
        checksum,
        uploadedById,
        targetType: targeting.targetType,
        targetVenueIds: targeting.targetVenueIds,
        targetTerminalIds: targeting.targetTerminalIds,
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

    // Audit: superadmin uploaded a (possibly targeted) APK rollout. Global action → venueId null.
    // Best-effort: an audit failure must NOT roll back / 500 a row that's already created + uploaded.
    try {
      await prisma.activityLog.create({
        data: {
          action: 'SUPERADMIN_APP_UPDATE_CREATED',
          entity: 'AppUpdate',
          entityId: appUpdate.id,
          staffId: uploadedById,
          venueId: null,
          data: {
            versionName,
            versionCode: versionCodeInt,
            environment,
            platform: esCampo ? 'ANDROID_CAMPO' : 'ANDROID_TPV',
            updateMode,
            targetType: targeting.targetType,
            targetVenueIds: targeting.targetVenueIds,
            targetTerminalIds: targeting.targetTerminalIds,
          },
        },
      })
    } catch (auditError) {
      logger.warn('Failed to write ActivityLog for app update create (non-fatal):', auditError)
    }

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
    if ((error as { code?: string })?.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'Esa versión ya existe en ese ambiente y plataforma (otra alta ganó)' })
    }
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
    const { releaseNotes, updateMode, isActive } = req.body

    const existing = await prisma.appUpdate.findUnique({ where: { id } })
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'App update not found',
      })
    }

    // Validate updateMode if provided
    if (updateMode !== undefined) {
      const validUpdateModes = ['NONE', 'BANNER', 'FORCE']
      if (!validUpdateModes.includes(updateMode)) {
        return res.status(400).json({
          success: false,
          error: `Invalid updateMode. Must be one of: ${validUpdateModes.join(', ')}`,
        })
      }
    }

    // Audience targeting is only touched if the caller sent targetType
    let targeting: { targetType: AppUpdateTargetTypeValue; targetVenueIds: string[]; targetTerminalIds: string[] } | undefined
    if (req.body.targetType !== undefined) {
      // La app de campo no reporta sucursal ni serie: una fila limitada nunca le llegaría (el alta ya la fuerza a ALL).
      if (existing.platform === 'ANDROID_CAMPO' && req.body.targetType !== 'ALL') {
        return res.status(400).json({
          success: false,
          error: 'La app de campo siempre sale para todos los celulares: no reporta sucursal ni serie, así que no se puede limitar',
        })
      }
      const result = normalizeTargeting(req.body)
      if ('error' in result) {
        return res.status(400).json({ success: false, error: result.error })
      }
      targeting = result
    }
    if (esObligatoriaDirigida(updateMode ?? existing.updateMode, targeting?.targetType ?? existing.targetType)) {
      return res.status(400).json({ success: false, error: OBLIGATORIA_SOLO_PARA_TODAS, message: OBLIGATORIA_SOLO_PARA_TODAS })
    }

    // «Obligatoria = para todas» se cumple en la misma escritura: si otra edición cambió el modo o el alcance entre la lectura
    // de arriba y aquí, la fila ya no coincide y no se escribe (Codex, apps viejas r4).
    const guarda =
      !targeting && updateMode === 'FORCE'
        ? { targetType: 'ALL' as const }
        : targeting && targeting.targetType !== 'ALL' && updateMode === undefined
          ? { updateMode: { not: UpdateMode.FORCE } }
          : {}
    let updated
    try {
      updated = await prisma.appUpdate.update({
        where: { id, ...guarda },
        data: {
          ...(releaseNotes !== undefined && { releaseNotes }),
          ...(updateMode !== undefined && { updateMode: updateMode as UpdateMode }),
          ...(isActive !== undefined && { isActive }),
          ...(targeting && {
            targetType: targeting.targetType,
            targetVenueIds: targeting.targetVenueIds,
            targetTerminalIds: targeting.targetTerminalIds,
          }),
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
    } catch (error: any) {
      if (error?.code !== 'P2025') throw error
      const cambio = 'Esta versión cambió mientras la editabas. Recarga la página y vuelve a intentarlo.'
      return res.status(409).json({ success: false, error: cambio, message: cambio })
    }

    logger.info(`App update ${id} updated`)

    // Audit: superadmin edited an APK rollout (targeting/mode/active). Global action → venueId null.
    // Best-effort: an audit failure must NOT 500 an update that already succeeded.
    try {
      await prisma.activityLog.create({
        data: {
          action: 'SUPERADMIN_APP_UPDATE_UPDATED',
          entity: 'AppUpdate',
          entityId: updated.id,
          staffId: req.authContext?.userId ?? null,
          venueId: null,
          data: {
            versionName: updated.versionName,
            versionCode: updated.versionCode,
            ...(releaseNotes !== undefined && { releaseNotes }),
            ...(updateMode !== undefined && { updateMode }),
            ...(isActive !== undefined && { isActive }),
            ...(targeting && {
              targetType: targeting.targetType,
              targetVenueIds: targeting.targetVenueIds,
              targetTerminalIds: targeting.targetTerminalIds,
            }),
          },
        },
      })
    } catch (auditError) {
      logger.warn('Failed to write ActivityLog for app update edit (non-fatal):', auditError)
    }

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
        platform: (req.query.platform as AppPlatform | undefined) ?? 'ANDROID_TPV',
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
        // Helper to determine environment based on package name (la app de campo: por su versionName)
        detectedEnvironment:
          metadata.packageName === PAQUETE_DE_CAMPO
            ? ambienteDeCampo(metadata.versionName)
            : metadata.packageName === 'com.jaac.avoqado_tpv.sandbox'
              ? 'SANDBOX'
              : metadata.packageName === 'com.jaac.avoqado_tpv'
                ? 'PRODUCTION'
                : null,
        detectedPlatform: metadata.packageName === PAQUETE_DE_CAMPO ? 'ANDROID_CAMPO' : 'ANDROID_TPV',
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
