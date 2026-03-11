/**
 * Payment Link Routes (Dashboard)
 *
 * Base path: /api/v1/dashboard/venues/:venueId/payment-links
 *
 * All routes require authentication (enforced by parent router).
 *
 * @module routes/dashboard/paymentLink
 */

import { Router } from 'express'
import { validateRequest } from '@/middlewares/validation'
import * as paymentLinkController from '@/controllers/dashboard/paymentLink.dashboard.controller'
import {
  listPaymentLinksSchema,
  createPaymentLinkSchema,
  getPaymentLinkSchema,
  updatePaymentLinkSchema,
} from '@/schemas/dashboard/paymentLink.schema'

const router = Router({ mergeParams: true })

/**
 * GET /api/v1/dashboard/venues/:venueId/payment-links
 * Lists payment links for a venue
 */
router.get('/', validateRequest(listPaymentLinksSchema), paymentLinkController.listPaymentLinks)

/**
 * POST /api/v1/dashboard/venues/:venueId/payment-links
 * Creates a new payment link
 */
router.post('/', validateRequest(createPaymentLinkSchema), paymentLinkController.createPaymentLink)

/**
 * GET /api/v1/dashboard/venues/:venueId/payment-links/:linkId
 * Gets a single payment link by ID
 */
router.get('/:linkId', validateRequest(getPaymentLinkSchema), paymentLinkController.getPaymentLink)

/**
 * PUT /api/v1/dashboard/venues/:venueId/payment-links/:linkId
 * Updates a payment link
 */
router.put('/:linkId', validateRequest(updatePaymentLinkSchema), paymentLinkController.updatePaymentLink)

/**
 * DELETE /api/v1/dashboard/venues/:venueId/payment-links/:linkId
 * Archives a payment link (soft delete)
 */
router.delete('/:linkId', validateRequest(getPaymentLinkSchema), paymentLinkController.archivePaymentLink)

export default router
