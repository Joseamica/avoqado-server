import { Router } from 'express'
import * as terminalController from '../../controllers/dashboard/terminals.superadmin.controller'
import { validateRequest } from '../../middlewares/validation'
import { z } from 'zod'

const router = Router()

/**
 * Terminal Routes
 * Base path: /api/v1/dashboard/superadmin/terminals
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware)
 */

// Validation schemas
const terminalQuerySchema = z.object({
  query: z.object({
    venueId: z.string().optional(),
    status: z.string().optional(),
    type: z.string().optional(),
  }),
})

const createTerminalSchema = z.object({
  body: z.object({
    venueId: z.string().cuid('Invalid venue ID'),
    serialNumber: z.string().min(1, 'Serial number is required'),
    name: z.string().min(1, 'Terminal name is required'),
    type: z.enum(['TPV_ANDROID', 'TPV_IOS', 'PRINTER_RECEIPT', 'PRINTER_KITCHEN', 'KDS']),
    brand: z.string().optional(),
    model: z.string().optional(),
    assignedMerchantIds: z.array(z.string()).optional(),
    generateActivationCode: z.boolean().optional(),
  }),
})

const updateTerminalSchema = z.object({
  params: z.object({
    terminalId: z.string().cuid('Invalid terminal ID'),
  }),
  body: z.object({
    name: z.string().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'RETIRED']).optional(),
    assignedMerchantIds: z.array(z.string()).optional(),
    brand: z.string().optional(),
    model: z.string().optional(),
  }),
})

const terminalIdSchema = z.object({
  params: z.object({
    terminalId: z.string().cuid('Invalid terminal ID'),
  }),
})

// Routes

/**
 * @route   GET /api/v1/dashboard/superadmin/terminals
 * @desc    Get all terminals (cross-venue) with optional filters
 * @access  Superadmin only
 */
router.get('/', validateRequest(terminalQuerySchema), terminalController.getAllTerminals)

/**
 * @route   GET /api/v1/dashboard/superadmin/terminals/:terminalId
 * @desc    Get terminal by ID
 * @access  Superadmin only
 */
router.get('/:terminalId', validateRequest(terminalIdSchema), terminalController.getTerminalById)

/**
 * @route   POST /api/v1/dashboard/superadmin/terminals
 * @desc    Create new terminal
 * @access  Superadmin only
 */
router.post('/', validateRequest(createTerminalSchema), terminalController.createTerminal)

/**
 * @route   PATCH /api/v1/dashboard/superadmin/terminals/:terminalId
 * @desc    Update terminal
 * @access  Superadmin only
 */
router.patch('/:terminalId', validateRequest(updateTerminalSchema), terminalController.updateTerminal)

/**
 * @route   POST /api/v1/dashboard/superadmin/terminals/:terminalId/generate-activation-code
 * @desc    Generate activation code for terminal
 * @access  Superadmin only
 */
router.post('/:terminalId/generate-activation-code', validateRequest(terminalIdSchema), terminalController.generateActivationCode)

/**
 * @route   POST /api/v1/dashboard/superadmin/terminals/:terminalId/remote-activate
 * @desc    Send remote activation command to pre-registered terminal
 * @access  Superadmin only
 */
router.post('/:terminalId/remote-activate', validateRequest(terminalIdSchema), terminalController.sendRemoteActivation)

/**
 * @route   DELETE /api/v1/dashboard/superadmin/terminals/:terminalId
 * @desc    Delete terminal (only if inactive/not activated)
 * @access  Superadmin only
 */
router.delete('/:terminalId', validateRequest(terminalIdSchema), terminalController.deleteTerminal)

export default router
