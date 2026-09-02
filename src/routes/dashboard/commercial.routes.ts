import { Router } from 'express'
import { z } from 'zod'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { requireCommercialV2CheckoutActive } from '@/middlewares/requireCommercialV2CheckoutActive.middleware'
import { validateRequest } from '@/middlewares/validation'
import { commercialAuthenticatedQuoteRateLimiter } from '@/middlewares/commercial-authenticated-quote-rate-limit.middleware'
import { bridgeCommercialQuotePreviewRequestV2Schema, commercialDirectVenueQuoteRequestV2Schema } from '@/schemas/commercialQuoteV2.schema'
import {
  acceptCommercialQuote,
  bridgeAuthenticatedCommercialQuote,
  createCommercialCheckout,
  createAuthenticatedCommercialQuote,
  getCommercialBillingOverview,
  listCommercialBillingReceipts,
} from '@/controllers/dashboard/commercial.dashboard.controller'

const router = Router({ mergeParams: true })

export const commercialDirectVenueQuoteHttpSchema = z
  .object({
    params: z.object({ venueId: z.string().min(1).max(128) }).strict(),
    body: commercialDirectVenueQuoteRequestV2Schema,
  })
  .strict()

export const bridgeCommercialQuotePreviewHttpSchema = z
  .object({
    params: z.object({ venueId: z.string().min(1).max(128) }).strict(),
    body: bridgeCommercialQuotePreviewRequestV2Schema,
  })
  .strict()

export const commercialBillingOverviewHttpSchema = z
  .object({
    params: z.object({ venueId: z.string().min(1).max(128) }).strict(),
    query: z.object({}).strict(),
  })
  .strict()

export const commercialBillingReceiptsHttpSchema = z
  .object({
    params: z.object({ venueId: z.string().min(1).max(128) }).strict(),
    query: z
      .object({
        cursor: z.string().min(1).max(191).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict(),
  })
  .strict()

router.get(
  '/venues/:venueId/billing/overview',
  authenticateTokenMiddleware,
  validateRequest(commercialBillingOverviewHttpSchema),
  checkPermission('billing:subscriptions:read'),
  getCommercialBillingOverview,
)
router.get(
  '/venues/:venueId/billing/receipts',
  authenticateTokenMiddleware,
  validateRequest(commercialBillingReceiptsHttpSchema),
  checkPermission('billing:history:read'),
  listCommercialBillingReceipts,
)

router.post(
  '/venues/:venueId/quotes',
  authenticateTokenMiddleware,
  checkPermission('billing:subscriptions:manage'),
  validateRequest(commercialDirectVenueQuoteHttpSchema),
  createAuthenticatedCommercialQuote,
)
router.post(
  '/venues/:venueId/quotes/from-preview',
  authenticateTokenMiddleware,
  commercialAuthenticatedQuoteRateLimiter,
  validateRequest(bridgeCommercialQuotePreviewHttpSchema),
  bridgeAuthenticatedCommercialQuote,
)
router.post(
  '/venues/:venueId/quotes/:quoteId/accept',
  requireCommercialV2CheckoutActive,
  authenticateTokenMiddleware,
  checkPermission('billing:subscriptions:manage'),
  acceptCommercialQuote,
)
router.post(
  '/venues/:venueId/quote-acceptances/:acceptanceId/checkout',
  requireCommercialV2CheckoutActive,
  authenticateTokenMiddleware,
  checkPermission('billing:subscriptions:manage'),
  createCommercialCheckout,
)

export default router
