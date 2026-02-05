/**
 * TPV Version Gate Middleware
 *
 * Enforces minimum app version for TPV terminals. This is the "cannot bypass"
 * layer of forced updates - if the app version is below the minimum required,
 * ALL API requests are rejected with HTTP 426 Upgrade Required.
 *
 * **Square/Toast/Stripe Pattern:**
 * This is how top POS companies enforce critical updates. The app literally
 * cannot function until it's updated because every API call fails.
 *
 * **How it works:**
 * 1. TPV sends X-App-Version-Code header with every request
 * 2. Middleware checks if there's a FORCE update with higher versionCode
 * 3. If yes, returns 426 with update info
 * 4. TPV shows ForceUpdateDialog and blocks all functionality
 *
 * **Usage:**
 * Apply to all authenticated TPV routes:
 * ```typescript
 * router.use('/tpv', authenticateToken, tpvVersionGate, tpvRoutes)
 * ```
 */

import { Request, Response, NextFunction } from 'express'
import prisma from '../utils/prismaClient'
import { AppEnvironment, UpdateMode } from '@prisma/client'
import logger from '../config/logger'

// Cache the minimum version to avoid DB queries on every request
// Invalidated every 60 seconds or when an update is published
let cachedMinVersion: { sandbox: number | null; production: number | null } = {
  sandbox: null,
  production: null,
}
let cacheTimestamp = 0
const CACHE_TTL_MS = 60_000 // 1 minute

/**
 * Get the minimum required version for an environment.
 * Returns the versionCode of the latest active FORCE update, or null if none.
 */
async function getMinimumRequiredVersion(environment: AppEnvironment): Promise<number | null> {
  const now = Date.now()

  // Check cache
  if (now - cacheTimestamp < CACHE_TTL_MS) {
    return environment === 'SANDBOX' ? cachedMinVersion.sandbox : cachedMinVersion.production
  }

  // Refresh cache for both environments
  try {
    const [sandboxUpdate, productionUpdate] = await Promise.all([
      prisma.appUpdate.findFirst({
        where: {
          environment: 'SANDBOX',
          isActive: true,
          updateMode: UpdateMode.FORCE,
        },
        orderBy: { versionCode: 'desc' },
        select: { versionCode: true },
      }),
      prisma.appUpdate.findFirst({
        where: {
          environment: 'PRODUCTION',
          isActive: true,
          updateMode: UpdateMode.FORCE,
        },
        orderBy: { versionCode: 'desc' },
        select: { versionCode: true },
      }),
    ])

    cachedMinVersion = {
      sandbox: sandboxUpdate?.versionCode ?? null,
      production: productionUpdate?.versionCode ?? null,
    }
    cacheTimestamp = now

    logger.debug('[VersionGate] Cache refreshed', {
      sandbox: cachedMinVersion.sandbox,
      production: cachedMinVersion.production,
    })
  } catch (error) {
    logger.error('[VersionGate] Failed to query minimum version', { error })
    // On error, don't block - return null (no minimum)
    return null
  }

  return environment === 'SANDBOX' ? cachedMinVersion.sandbox : cachedMinVersion.production
}

/**
 * Invalidate the version cache (call when publishing a new FORCE update)
 */
export function invalidateVersionCache(): void {
  cacheTimestamp = 0
  logger.info('[VersionGate] Cache invalidated')
}

/**
 * Paths that should NOT be blocked by version gate.
 * These are unauthenticated endpoints that need to work even on old versions.
 */
const EXCLUDED_PATHS = [
  '/heartbeat', // Health monitoring (needs to work always)
  '/command-ack', // Command acknowledgment
  '/auth/pin-login', // Login (user needs to see update dialog after login)
  '/auth/refresh-token', // Token refresh
  '/auth/logout', // Logout
  '/activate', // Terminal activation
  '/check-update', // Update check endpoint itself
  '/get-version', // Get specific version
  '/terminals/', // Terminal status sync
]

/**
 * Check if a path should be excluded from version gate
 */
function isExcludedPath(path: string): boolean {
  return EXCLUDED_PATHS.some(excluded => path.includes(excluded))
}

/**
 * TPV Version Gate Middleware
 *
 * Checks X-App-Version-Code header and returns 426 if below minimum.
 */
export async function tpvVersionGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Skip excluded paths (unauthenticated endpoints)
    if (isExcludedPath(req.path)) {
      return next()
    }

    // Get version from header
    const versionHeader = req.headers['x-app-version-code']
    if (!versionHeader) {
      // No version header - allow request (backwards compatibility)
      // Old app versions don't send this header yet
      return next()
    }

    const clientVersionCode = parseInt(versionHeader as string, 10)
    if (isNaN(clientVersionCode)) {
      return next() // Invalid header, allow request
    }

    // Determine environment from version name header or default to sandbox
    const versionName = req.headers['x-app-version-name'] as string | undefined
    const isSandbox = versionName?.toLowerCase().includes('sandbox') ?? true
    const environment: AppEnvironment = isSandbox ? 'SANDBOX' : 'PRODUCTION'

    // Get minimum required version
    const minVersion = await getMinimumRequiredVersion(environment)

    // If no FORCE update exists, allow request
    if (minVersion === null) {
      return next()
    }

    // If client version is >= minimum, allow request
    if (clientVersionCode >= minVersion) {
      return next()
    }

    // Client version is below minimum - return 426 Upgrade Required
    logger.warn('[VersionGate] Blocking outdated client', {
      clientVersion: clientVersionCode,
      minVersion,
      environment,
      path: req.path,
    })

    // Get full update info for the response
    const forceUpdate = await prisma.appUpdate.findFirst({
      where: {
        environment,
        isActive: true,
        updateMode: UpdateMode.FORCE,
        versionCode: minVersion,
      },
      select: {
        versionName: true,
        versionCode: true,
        downloadUrl: true,
        releaseNotes: true,
      },
    })

    res.status(426).json({
      success: false,
      error: 'UPGRADE_REQUIRED',
      message: 'Esta versión ya no es compatible. Por favor actualiza la aplicación.',
      minVersionCode: minVersion,
      currentVersionCode: clientVersionCode,
      update: forceUpdate
        ? {
            versionName: forceUpdate.versionName,
            versionCode: forceUpdate.versionCode,
            downloadUrl: forceUpdate.downloadUrl,
            releaseNotes: forceUpdate.releaseNotes,
          }
        : undefined,
    })
  } catch (error) {
    // On error, don't block - allow request and log error
    logger.error('[VersionGate] Middleware error', { error })
    next()
  }
}
