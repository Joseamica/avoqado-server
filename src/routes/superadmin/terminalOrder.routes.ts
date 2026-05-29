import { Router } from 'express'
import * as terminalOrderSuperadminController from '../../controllers/superadmin/terminalOrder.superadmin.controller'
import { assignSerialsSchema, markShippedSchema } from '../../schemas/superadmin/terminalOrder.superadmin.schema'
import { validateRequest } from '../../middlewares/validation'

const router = Router()

/**
 * Superadmin TPV-orders routes — Plan 1 · Task 16.
 *
 * Base path: /api/v1/superadmin/tpv-orders
 *
 * All routes require SUPERADMIN role (enforced by parent router middleware
 * in src/routes/superadmin.routes.ts).
 */

/**
 * @route   GET /api/v1/superadmin/tpv-orders
 * @desc    List every TerminalOrder across all venues (newest first)
 * @access  Superadmin only
 */
router.get('/', terminalOrderSuperadminController.listAllOrdersHandler)

/**
 * @route   GET /api/v1/superadmin/tpv-orders/:id
 * @desc    Get one order with items, venue, terminals, createdBy
 * @access  Superadmin only
 */
router.get('/:id', terminalOrderSuperadminController.getOrderHandler)

/**
 * @route   POST /api/v1/superadmin/tpv-orders/:id/assign-serials
 * @desc    Create Terminals + advance order to SERIALS_ASSIGNED
 * @access  Superadmin only
 */
router.post('/:id/assign-serials', validateRequest(assignSerialsSchema), terminalOrderSuperadminController.assignSerialsHandler)

/**
 * @route   POST /api/v1/superadmin/tpv-orders/:id/mark-shipped
 * @desc    Advance order to SHIPPED (requires SERIALS_ASSIGNED + tracking)
 * @access  Superadmin only
 */
router.post('/:id/mark-shipped', validateRequest(markShippedSchema), terminalOrderSuperadminController.markShippedHandler)

/**
 * @route   POST /api/v1/superadmin/tpv-orders/:id/mark-delivered
 * @desc    Advance order to DELIVERED (requires SHIPPED)
 * @access  Superadmin only
 */
router.post('/:id/mark-delivered', terminalOrderSuperadminController.markDeliveredHandler)

export default router
