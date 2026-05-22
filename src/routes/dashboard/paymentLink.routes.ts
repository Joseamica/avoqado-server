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
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import * as paymentLinkController from '@/controllers/dashboard/paymentLink.dashboard.controller'
import {
  listPaymentLinksSchema,
  createPaymentLinkSchema,
  getPaymentLinkSchema,
  updatePaymentLinkSchema,
  updatePaymentLinkBrandingSchema,
  updatePaymentLinkSettingsSchema,
  sharePaymentLinkWhatsappSchema,
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
router.post('/', checkPermission('payment-link:create'), validateRequest(createPaymentLinkSchema), paymentLinkController.createPaymentLink)

// ───────────────────────────────────────────────────────────────────────────
// Static-prefix routes — MUST be declared BEFORE `/:linkId` because Express
// matches in order. With `/:linkId` first, `GET /settings` would be routed
// to getPaymentLink with linkId='settings' and 404 ("Liga de pago no
// encontrada"). Same caveat applies to any future static sub-paths.
// ───────────────────────────────────────────────────────────────────────────

/**
 * GET  /api/v1/dashboard/venues/:venueId/payment-links/branding/config
 * PUT  /api/v1/dashboard/venues/:venueId/payment-links/branding/config
 */
router.get('/branding/config', paymentLinkController.getPaymentLinkBranding)
router.put('/branding/config', checkPermission('payment-link:update'), validateRequest(updatePaymentLinkBrandingSchema), paymentLinkController.updatePaymentLinkBranding)

/**
 * GET   /api/v1/dashboard/venues/:venueId/payment-links/settings
 * PATCH /api/v1/dashboard/venues/:venueId/payment-links/settings
 *
 * Venue-wide defaults applied to new payment links + notification toggles.
 * Pre-existing per-link tippingConfig / customFields on PaymentLink rows
 * are untouched; this controls the dashboard "Ajustes generales" form and
 * the on-paid notification email.
 */
router.get('/settings', paymentLinkController.getPaymentLinkSettingsHandler)
router.patch('/settings', checkPermission('payment-link:update'), validateRequest(updatePaymentLinkSettingsSchema), paymentLinkController.updatePaymentLinkSettingsHandler)

// ───────────────────────────────────────────────────────────────────────────
// Dynamic-id routes
// ───────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/dashboard/venues/:venueId/payment-links/:linkId
 * Gets a single payment link by ID
 */
router.get('/:linkId', validateRequest(getPaymentLinkSchema), paymentLinkController.getPaymentLink)

/**
 * PUT /api/v1/dashboard/venues/:venueId/payment-links/:linkId
 * Updates a payment link
 */
router.put('/:linkId', checkPermission('payment-link:update'), validateRequest(updatePaymentLinkSchema), paymentLinkController.updatePaymentLink)

/**
 * DELETE /api/v1/dashboard/venues/:venueId/payment-links/:linkId
 * Archives a payment link (soft delete). Uses the `:update` permission since
 * the dashboard surfaces archive as part of the edit-link UI; if we ever add
 * a distinct `payment-link:delete` permission, change this gate.
 */
router.delete('/:linkId', checkPermission('payment-link:update'), validateRequest(getPaymentLinkSchema), paymentLinkController.archivePaymentLink)

/**
 * POST /api/v1/dashboard/venues/:venueId/payment-links/:linkId/share-whatsapp
 * Sends a payment link to a customer via WhatsApp Business (Meta template
 * `payment_link_share`). Permission is enforced by the parent router's
 * `payment-link:read` check — sharing an existing link is a read-level
 * action (no mutation to the link itself).
 */
router.post('/:linkId/share-whatsapp', validateRequest(sharePaymentLinkWhatsappSchema), paymentLinkController.shareViaWhatsapp)

export default router
