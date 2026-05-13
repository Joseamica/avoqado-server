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
  updatePaymentLinkBrandingSchema,
  updatePaymentLinkSettingsSchema,
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

/**
 * GET  /api/v1/dashboard/venues/:venueId/payment-links/branding/config
 * PUT  /api/v1/dashboard/venues/:venueId/payment-links/branding/config
 *
 * Per-venue branding for the public payment-link checkout
 * (pay.avoqado.io). GET returns merged config with defaults; PUT replaces
 * the whole config. Path is intentionally a sub-segment of /payment-links
 * so the permission guard at the parent (`payment-link:read`) gates it.
 */
router.get('/branding/config', paymentLinkController.getPaymentLinkBranding)
router.put('/branding/config', validateRequest(updatePaymentLinkBrandingSchema), paymentLinkController.updatePaymentLinkBranding)

/**
 * GET   /api/v1/dashboard/venues/:venueId/payment-links/settings
 * PATCH /api/v1/dashboard/venues/:venueId/payment-links/settings
 *
 * Venue-wide defaults applied to new payment links + notification toggles.
 * Sibling of /branding/config so the same `payment-link:read` guard at the
 * parent gates both. Pre-existing per-link tippingConfig / customFields on
 * PaymentLink rows are untouched; this just controls the dashboard's
 * "Ajustes generales" form and the on-paid notification email.
 */
router.get('/settings', paymentLinkController.getPaymentLinkSettingsHandler)
router.patch('/settings', validateRequest(updatePaymentLinkSettingsSchema), paymentLinkController.updatePaymentLinkSettingsHandler)

export default router
