import { Router } from 'express'
import * as organizationController from '../../controllers/dashboard/organizations.superadmin.controller'
import { validateRequest } from '../../middlewares/validation'
import { z } from 'zod'

const router = Router()

/**
 * Organization Routes
 * Base path: /api/v1/dashboard/superadmin/organizations
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// ===========================================
// VALIDATION SCHEMAS
// ===========================================

const organizationIdSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID'),
  }),
})

const createOrganizationSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Organization name is required'),
    slug: z
      .string()
      .min(1, 'Slug is required')
      .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase with hyphens only')
      .refine(slug => !['org', 'organizations', 'admin', 'superadmin', 'auth', 'api'].includes(slug), {
        message: 'Slug is reserved and cannot be used',
      })
      .optional(),
    email: z.string().email('Invalid email address'),
    phone: z.string().min(1, 'Phone number is required'),
    taxId: z.string().optional(),
    type: z.enum(['RESTAURANT', 'RETAIL', 'SERVICE', 'ENTERTAINMENT', 'HOSPITALITY', 'HEALTHCARE', 'OTHER']).optional(),
  }),
})

const updateOrganizationSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID'),
  }),
  body: z.object({
    name: z.string().min(1).optional(),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase with hyphens only')
      .refine(slug => !['org', 'organizations', 'admin', 'superadmin', 'auth', 'api'].includes(slug), {
        message: 'Slug is reserved and cannot be used',
      })
      .optional()
      .nullable(),
    email: z.string().email('Invalid email address').optional(),
    phone: z.string().min(1).optional(),
    taxId: z.string().optional().nullable(),
    type: z.enum(['RESTAURANT', 'RETAIL', 'SERVICE', 'ENTERTAINMENT', 'HOSPITALITY', 'HEALTHCARE', 'OTHER']).optional(),
  }),
})

const enableModuleSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID'),
  }),
  body: z.object({
    moduleCode: z.string().min(1, 'Module code is required'),
    preset: z.string().optional(),
    config: z.record(z.any()).optional(),
  }),
})

const disableModuleSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID'),
  }),
  body: z.object({
    moduleCode: z.string().min(1, 'Module code is required'),
  }),
})

const updateModuleConfigSchema = z.object({
  params: z.object({
    organizationId: z.string().cuid('Invalid organization ID'),
  }),
  body: z.object({
    moduleCode: z.string().min(1, 'Module code is required'),
    config: z.record(z.any()),
  }),
})

// ===========================================
// ROUTES
// ===========================================

/**
 * @route   GET /api/v1/dashboard/superadmin/organizations
 * @desc    Get all organizations with venue counts and module stats
 * @access  Superadmin only
 */
router.get('/', organizationController.getAllOrganizations)

/**
 * @route   GET /api/v1/dashboard/superadmin/organizations/list
 * @desc    Get simplified list of organizations for dropdowns
 * @access  Superadmin only
 * @note    MUST be defined BEFORE /:organizationId to avoid route conflict
 */
router.get('/list', organizationController.getOrganizationsListSimple)

/**
 * @route   POST /api/v1/dashboard/superadmin/organizations
 * @desc    Create a new organization
 * @access  Superadmin only
 */
router.post('/', validateRequest(createOrganizationSchema), organizationController.createOrganization)

/**
 * @route   GET /api/v1/dashboard/superadmin/organizations/:organizationId
 * @desc    Get a single organization with full details
 * @access  Superadmin only
 */
router.get('/:organizationId', validateRequest(organizationIdSchema), organizationController.getOrganizationById)

/**
 * @route   PATCH /api/v1/dashboard/superadmin/organizations/:organizationId
 * @desc    Update an organization
 * @access  Superadmin only
 */
router.patch('/:organizationId', validateRequest(updateOrganizationSchema), organizationController.updateOrganization)

/**
 * @route   DELETE /api/v1/dashboard/superadmin/organizations/:organizationId
 * @desc    Delete an organization (only if no venues exist)
 * @access  Superadmin only
 */
router.delete('/:organizationId', validateRequest(organizationIdSchema), organizationController.deleteOrganization)

// ===========================================
// ORGANIZATION MODULE ROUTES
// ===========================================

/**
 * @route   GET /api/v1/dashboard/superadmin/organizations/:organizationId/modules
 * @desc    Get all modules with their enablement status for an organization
 * @access  Superadmin only
 */
router.get('/:organizationId/modules', validateRequest(organizationIdSchema), organizationController.getModulesForOrganization)

/**
 * @route   POST /api/v1/dashboard/superadmin/organizations/:organizationId/modules/enable
 * @desc    Enable a module for all venues in an organization
 * @access  Superadmin only
 */
router.post('/:organizationId/modules/enable', validateRequest(enableModuleSchema), organizationController.enableModuleForOrganization)

/**
 * @route   POST /api/v1/dashboard/superadmin/organizations/:organizationId/modules/disable
 * @desc    Disable a module for an organization
 * @access  Superadmin only
 */
router.post('/:organizationId/modules/disable', validateRequest(disableModuleSchema), organizationController.disableModuleForOrganization)

/**
 * @route   PATCH /api/v1/dashboard/superadmin/organizations/:organizationId/modules/config
 * @desc    Update module configuration for an organization
 * @access  Superadmin only
 */
router.patch(
  '/:organizationId/modules/config',
  validateRequest(updateModuleConfigSchema),
  organizationController.updateOrganizationModuleConfig,
)

export default router
