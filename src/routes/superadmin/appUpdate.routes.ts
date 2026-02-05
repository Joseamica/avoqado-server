// src/routes/superadmin/appUpdate.routes.ts
import { Router } from 'express'
import * as appUpdateController from '../../controllers/superadmin/appUpdate.controller'
import { validateRequest } from '../../middlewares/validation'
import { z } from 'zod'

const router = Router()

/**
 * App Update Routes
 * Base path: /api/v1/dashboard/superadmin/app-updates
 *
 * Dual Update System: Blumon (provider) + Avoqado (self-managed)
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// Validation schemas
const listUpdatesSchema = z.object({
  query: z.object({
    environment: z.enum(['SANDBOX', 'PRODUCTION']).optional(),
  }),
})

const updateIdSchema = z.object({
  params: z.object({
    id: z.string().cuid('Invalid update ID'),
  }),
})

const environmentSchema = z.object({
  params: z.object({
    environment: z.enum(['sandbox', 'production', 'SANDBOX', 'PRODUCTION']),
  }),
})

const createUpdateSchema = z.object({
  body: z.object({
    // versionName is now optional - auto-detected from APK if not provided
    // Accepts X.Y.Z or X.Y.Z-suffix (e.g., 1.3.0-sandbox)
    versionName: z
      .string()
      .regex(/^\d+\.\d+\.\d+(-\w+)?$/, 'Version name must be in format X.Y.Z or X.Y.Z-suffix')
      .optional(),
    // versionCode is now optional - auto-detected from APK if not provided
    versionCode: z.number({ coerce: true }).int().positive('Version code must be a positive integer').optional(),
    environment: z.enum(['SANDBOX', 'PRODUCTION']),
    releaseNotes: z.string().optional(),
    updateMode: z.enum(['NONE', 'BANNER', 'FORCE']).optional().default('NONE'),
    // minAndroidSdk is also auto-detected from APK if not provided
    minAndroidSdk: z.number({ coerce: true }).int().min(21).max(35).optional(),
    apkBase64: z.string().min(1, 'APK file is required (base64 encoded)'),
  }),
})

const updateAppUpdateSchema = z.object({
  params: z.object({
    id: z.string().cuid('Invalid update ID'),
  }),
  body: z.object({
    releaseNotes: z.string().optional(),
    updateMode: z.enum(['NONE', 'BANNER', 'FORCE']).optional(),
    isActive: z.boolean().optional(),
    minAndroidSdk: z.number({ coerce: true }).int().min(21).max(35).optional(),
  }),
})

// Routes

/**
 * @route   GET /api/v1/dashboard/superadmin/app-updates
 * @desc    List all app updates with optional environment filter
 * @access  Superadmin only
 */
router.get('/', validateRequest(listUpdatesSchema), appUpdateController.listAppUpdates)

/**
 * @route   GET /api/v1/dashboard/superadmin/app-updates/latest/:environment
 * @desc    Get latest active app update for environment
 * @access  Superadmin only
 */
router.get('/latest/:environment', validateRequest(environmentSchema), appUpdateController.getLatestAppUpdate)

/**
 * @route   GET /api/v1/dashboard/superadmin/app-updates/:id
 * @desc    Get app update by ID
 * @access  Superadmin only
 */
router.get('/:id', validateRequest(updateIdSchema), appUpdateController.getAppUpdateById)

/**
 * @route   POST /api/v1/superadmin/app-updates/preview
 * @desc    Preview APK metadata without uploading (for auto-fill form)
 * @access  Superadmin only
 */
router.post('/preview', appUpdateController.previewApkMetadata)

/**
 * @route   POST /api/v1/superadmin/app-updates
 * @desc    Create new app update (upload APK)
 * @access  Superadmin only
 * @note    Body parser (100MB limit) configured in app.ts before this route
 */
router.post('/', validateRequest(createUpdateSchema), appUpdateController.createAppUpdate)

/**
 * @route   PATCH /api/v1/dashboard/superadmin/app-updates/:id
 * @desc    Update app update metadata
 * @access  Superadmin only
 */
router.patch('/:id', validateRequest(updateAppUpdateSchema), appUpdateController.updateAppUpdate)

/**
 * @route   DELETE /api/v1/dashboard/superadmin/app-updates/:id
 * @desc    Delete app update
 * @access  Superadmin only
 */
router.delete('/:id', validateRequest(updateIdSchema), appUpdateController.deleteAppUpdate)

export default router
