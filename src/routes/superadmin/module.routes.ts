import { Router } from 'express'
import * as moduleController from '../../controllers/dashboard/modules.superadmin.controller'
import { validateRequest } from '../../middlewares/validation'
import { z } from 'zod'

const router = Router()

/**
 * Module Routes
 * Base path: /api/v1/dashboard/superadmin/modules
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// Validation schemas
const moduleCodeSchema = z.object({
  params: z.object({
    moduleCode: z.string().min(1, 'Module code is required'),
  }),
})

const venueIdSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID'),
  }),
})

const moduleIdSchema = z.object({
  params: z.object({
    moduleId: z.string().cuid('Invalid module ID'),
  }),
})

const createModuleSchema = z.object({
  body: z.object({
    code: z
      .string()
      .min(1, 'Module code is required')
      .regex(/^[A-Z_]+$/, 'Module code must be uppercase with underscores only'),
    name: z.string().min(1, 'Module name is required'),
    description: z.string().optional(),
    defaultConfig: z.record(z.any()).optional(),
    presets: z.record(z.any()).optional(),
  }),
})

const updateModuleSchema = z.object({
  params: z.object({
    moduleId: z.string().cuid('Invalid module ID'),
  }),
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    defaultConfig: z.record(z.any()).optional(),
    presets: z.record(z.any()).optional(),
  }),
})

const enableModuleSchema = z.object({
  body: z.object({
    venueId: z.string().cuid('Invalid venue ID'),
    moduleCode: z.string().min(1, 'Module code is required'),
    preset: z.string().optional(),
  }),
})

const disableModuleSchema = z.object({
  body: z.object({
    venueId: z.string().cuid('Invalid venue ID'),
    moduleCode: z.string().min(1, 'Module code is required'),
  }),
})

const updateConfigSchema = z.object({
  body: z.object({
    venueId: z.string().cuid('Invalid venue ID'),
    moduleCode: z.string().min(1, 'Module code is required'),
    config: z.record(z.any()),
  }),
})

// Routes

/**
 * @route   GET /api/v1/dashboard/superadmin/modules
 * @desc    Get all global modules with their configurations and presets
 * @access  Superadmin only
 */
router.get('/', moduleController.getAllModules)

/**
 * @route   POST /api/v1/dashboard/superadmin/modules
 * @desc    Create a new global module
 * @access  Superadmin only
 */
router.post('/', validateRequest(createModuleSchema), moduleController.createModule)

/**
 * @route   GET /api/v1/dashboard/superadmin/modules/venues/:venueId
 * @desc    Get all modules with their enablement status for a specific venue
 * @access  Superadmin only
 * @note    MUST be defined BEFORE /:moduleId to avoid route conflict
 */
router.get('/venues/:venueId', validateRequest(venueIdSchema), moduleController.getModulesForVenue)

/**
 * @route   POST /api/v1/dashboard/superadmin/modules/enable
 * @desc    Enable a module for a venue with optional preset
 * @access  Superadmin only
 */
router.post('/enable', validateRequest(enableModuleSchema), moduleController.enableModuleForVenue)

/**
 * @route   POST /api/v1/dashboard/superadmin/modules/disable
 * @desc    Disable a module for a venue
 * @access  Superadmin only
 */
router.post('/disable', validateRequest(disableModuleSchema), moduleController.disableModuleForVenue)

/**
 * @route   PATCH /api/v1/dashboard/superadmin/modules/config
 * @desc    Update module configuration for a venue
 * @access  Superadmin only
 * @note    MUST be defined BEFORE /:moduleId to avoid route conflict
 */
router.patch('/config', validateRequest(updateConfigSchema), moduleController.updateModuleConfig)

/**
 * @route   PATCH /api/v1/dashboard/superadmin/modules/:moduleId
 * @desc    Update a global module
 * @access  Superadmin only
 */
router.patch('/:moduleId', validateRequest(updateModuleSchema), moduleController.updateModule)

/**
 * @route   DELETE /api/v1/dashboard/superadmin/modules/:moduleId
 * @desc    Delete a global module (only if not enabled for any venue)
 * @access  Superadmin only
 */
router.delete('/:moduleId', validateRequest(moduleIdSchema), moduleController.deleteModule)

/**
 * @route   GET /api/v1/dashboard/superadmin/modules/:moduleCode/venues
 * @desc    Get all venues with their enablement status for a specific module
 * @access  Superadmin only
 */
router.get('/:moduleCode/venues', validateRequest(moduleCodeSchema), moduleController.getVenuesForModule)

export default router
