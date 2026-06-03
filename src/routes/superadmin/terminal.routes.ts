import { Router } from 'express'
import * as terminalController from '../../controllers/dashboard/terminals.superadmin.controller'
import * as migrationController from '../../controllers/dashboard/terminal-migration.controller'
import { migratePreflightSchema, migrateExecuteSchema, migrateStatusSchema } from './terminal-migration.schemas'
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
    // Optional pre-configuration applied right after creation. Validated by
    // updateTpvSettings/TpvSettings shape; loose schema here keeps the route
    // tolerant to additive settings without needing route updates.
    configOverrides: z.record(z.unknown()).optional(),
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
    // Task 12 / validation point #3: operator confirmation flag for brand-change
    // pruning of incompatible merchants. Default false → service returns a
    // warning envelope listing the incompatible merchants instead of mutating.
    forceUnassign: z.boolean().optional(),
    // Task 54: move a terminal to a different venue. Used by the "Anexar
    // terminal existente" flow in the AngelPay wizard (a NEXGO terminal
    // physically present at venue X has to be re-registered to venue Y so it
    // pulls Y's `/tpv/terminals/:serial/config` payload on next heartbeat).
    // Service-level guard: assigned merchants are cleared on venue move
    // (cross-tenant assignments are never valid).
    venueId: z.string().cuid('Invalid venue ID').optional(),
  }),
})

const terminalIdSchema = z.object({
  params: z.object({
    terminalId: z.string().cuid('Invalid terminal ID'),
  }),
})

// Terminal venue migration schemas live in ./terminal-migration.schemas (imported above)
// so the validation contract can be unit-tested in isolation.

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
 * @route   POST /api/v1/dashboard/superadmin/terminals/:terminalId/migrate-preflight
 * @desc    Run read-only safety checks before migrating a terminal to another venue
 * @access  Superadmin only
 */
router.post('/:terminalId/migrate-preflight', validateRequest(migratePreflightSchema), migrationController.preflight)

/**
 * @route   POST /api/v1/dashboard/superadmin/terminals/:terminalId/migrate-execute
 * @desc    Re-parent the terminal to the destination venue and queue the factory reset
 * @access  Superadmin only
 */
router.post('/:terminalId/migrate-execute', validateRequest(migrateExecuteSchema), migrationController.execute)

/**
 * @route   GET /api/v1/dashboard/superadmin/terminals/:terminalId/migrate-status
 * @desc    Poll the status of an in-flight terminal migration
 * @access  Superadmin only
 */
router.get('/:terminalId/migrate-status', validateRequest(migrateStatusSchema), migrationController.status)

/**
 * @route   DELETE /api/v1/dashboard/superadmin/terminals/:terminalId
 * @desc    Delete terminal (only if inactive/not activated)
 * @access  Superadmin only
 */
router.delete('/:terminalId', validateRequest(terminalIdSchema), terminalController.deleteTerminal)

export default router
